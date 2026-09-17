import type { ExchangeStats } from './types.js';

/**
 * TTFT + token-throughput measurement for one exchange.
 *
 * Log-only and fully fail-open: an unparseable, truncated or unfamiliar body
 * yields nulls, never an exception — nothing here may break the terminal path.
 * Runs AFTER the response has been forwarded, so its cost is off the client's
 * latency path.
 *
 * Token counts come from what the upstream itself reported; this never
 * estimates. The three families this gateway proxies, in both their bounded and
 * streaming forms:
 *
 *   OpenAI     `usage.prompt_tokens` / `usage.completion_tokens` (Responses API:
 *              `input_tokens` / `output_tokens`); streaming only reports usage
 *              when the caller asked for it (`stream_options.include_usage`).
 *   Anthropic  `usage.input_tokens` / `usage.output_tokens`; when streaming it
 *              is split — `message_start` carries the input count, the final
 *              `message_delta` the cumulative output count.
 *   Gemini     `usageMetadata.promptTokenCount` / `candidatesTokenCount`, plus
 *              `thoughtsTokenCount` (thinking tokens are generated output too,
 *              and the other two vendors already fold theirs into the output
 *              count — adding it keeps `outputTokens` one comparable quantity).
 */

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

const NO_USAGE: TokenUsage = { inputTokens: null, outputTokens: null };

/** A usable token count: a finite, non-negative number. */
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The `usage` object of one event/response — either at the top level or, for
 * Anthropic's `message_start`, nested one level down under `message`.
 */
function usageNode(o: Record<string, unknown>): Record<string, unknown> | null {
  if (o.usage !== null && typeof o.usage === 'object') {
    return o.usage as Record<string, unknown>;
  }
  const msg = o.message;
  if (msg !== null && typeof msg === 'object') {
    const nested = (msg as Record<string, unknown>).usage;
    if (nested !== null && typeof nested === 'object') {
      return nested as Record<string, unknown>;
    }
  }
  return null;
}

/** Token counts carried by ONE parsed event/response object. */
function usageOf(obj: unknown): TokenUsage {
  if (obj === null || typeof obj !== 'object') return NO_USAGE;
  const o = obj as Record<string, unknown>;

  const gemini = o.usageMetadata;
  if (gemini !== null && typeof gemini === 'object') {
    const g = gemini as Record<string, unknown>;
    const candidates = count(g.candidatesTokenCount);
    const thoughts = count(g.thoughtsTokenCount);
    return {
      inputTokens: count(g.promptTokenCount),
      outputTokens:
        candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
    };
  }

  const u = usageNode(o);
  if (u === null) return NO_USAGE;
  return {
    inputTokens: count(u.prompt_tokens) ?? count(u.input_tokens),
    outputTokens: count(u.completion_tokens) ?? count(u.output_tokens),
  };
}

/**
 * Merge one event into the running totals: LAST non-null wins. Both streaming
 * dialects that report more than once are cumulative, not incremental —
 * Anthropic's `message_delta` supersedes the `output_tokens: 1` of
 * `message_start`, and each Gemini chunk restates the running totals — so the
 * last report is the final one and summing would multiply-count.
 */
function merge(into: TokenUsage, obj: unknown): void {
  const u = usageOf(obj);
  if (u.inputTokens !== null) into.inputTokens = u.inputTokens;
  if (u.outputTokens !== null) into.outputTokens = u.outputTokens;
}

/**
 * Scan an SSE body. Only `data:` lines that mention usage are parsed, so a
 * multi-megabyte token stream costs one substring test per line. A partial
 * trailing line (truncated capture) simply fails to parse and is skipped.
 * Multi-line `data:` payloads are not reassembled — no LLM vendor splits its
 * JSON across data lines.
 */
function fromEventStream(text: string): TokenUsage {
  const totals: TokenUsage = { ...NO_USAGE };
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || !payload.includes('usage')) continue;
    merge(totals, parseJson(payload));
  }
  return totals;
}

/** Scan a whole-document body: one JSON object, or an array of stream chunks
 * (Gemini's non-SSE `streamGenerateContent` returns the chunks as an array). */
function fromJsonDocument(text: string): TokenUsage {
  const parsed = parseJson(text);
  if (parsed === null) return NO_USAGE;
  const totals: TokenUsage = { ...NO_USAGE };
  if (Array.isArray(parsed)) {
    for (const element of parsed) merge(totals, element);
  } else {
    merge(totals, parsed);
  }
  return totals;
}

/**
 * Token counts reported inside a decoded response body. `contentType` only
 * picks the scan strategy: it decides when it is decisive, and a body labelled
 * neither SSE nor JSON (or unlabelled) is sniffed for a `data:` line so a
 * mislabelled event stream is still read.
 */
export function extractTokenUsage(
  text: string,
  contentType: string | undefined,
): TokenUsage {
  // Every shape above spells "usage" (usage / usageMetadata). One substring
  // test rejects the whole body when there is nothing to find.
  if (!text.includes('usage')) return NO_USAGE;
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) return fromEventStream(text);
  if (ct.includes('json')) return fromJsonDocument(text);
  return /(^|\n)data:/.test(text.slice(0, 4096))
    ? fromEventStream(text)
    : fromJsonDocument(text);
}

/**
 * Build the stats block for a finished exchange.
 *
 * `ttftMs` is measured from the same instant as `durationMs` (gateway request
 * entry), so the two are comparable and TTFT is what the client actually
 * experienced, gateway overhead included.
 *
 * The generation window `tokensPerSecond` divides by differs by response class,
 * because what is observable differs: a Streaming Response generates during
 * `durationMs - ttftMs` (the prefill that precedes the first token is excluded,
 * the usual output-throughput convention), while a Bounded Response arrives all
 * at once after generation has finished, so the whole `durationMs` was the
 * generation. Both are "output tokens over the time spent generating them".
 */
export function buildStats(input: {
  ttftMs: number | null;
  durationMs: number;
  streaming: boolean;
  bodyText: string | null;
  contentType: string | undefined;
}): ExchangeStats {
  const usage =
    input.bodyText !== null
      ? extractTokenUsage(input.bodyText, input.contentType)
      : NO_USAGE;

  const windowMs =
    input.streaming && input.ttftMs !== null
      ? input.durationMs - input.ttftMs
      : input.durationMs;

  const tokensPerSecond =
    usage.outputTokens !== null && windowMs > 0
      ? Math.round((usage.outputTokens / (windowMs / 1000)) * 10) / 10
      : null;

  return {
    ttftMs: input.ttftMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokensPerSecond,
  };
}
