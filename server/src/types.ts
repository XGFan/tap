import { z } from 'zod';

/** True if pattern+flags compile to a valid RegExp. Used to reject malformed
 * Rewrite Rules at config-load time instead of failing open at request time. */
function isValidRegex(pattern: string, flags?: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/** A regex body matcher: a JS RegExp source plus optional standard flags. */
const bodyMatchSchema = z.object({
  pattern: z.string(),
  flags: z.string().optional(),
});

/**
 * The predicate side of a Rewrite Rule. All fields optional and AND-combined.
 * `path` is a glob (e.g. "/v1/chat/*"); `contentType` is a substring; `status`
 * and `responseBody` are only meaningful for response-target rules. Body
 * matchers run against the DECODED UTF-8 body.
 */
const rewriteMatchSchema = z.object({
  method: z.array(z.string()).optional(),
  path: z.string().optional(),
  status: z.array(z.number().int()).optional(),
  contentType: z.string().optional(),
  requestBody: bodyMatchSchema.optional(),
  responseBody: bodyMatchSchema.optional(),
});

/**
 * The action side of a Rewrite Rule. `regexReplace` does a (optionally global)
 * regex substitution with $-backrefs; `setBody` replaces the whole body. Both
 * operate on the decoded UTF-8 body; the action carries its OWN regex, decoupled
 * from the match.
 */
const rewriteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('regexReplace'),
    pattern: z.string(),
    replacement: z.string(),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal('setBody'),
    value: z.string(),
  }),
]);

/**
 * A declarative match -> rewrite rule. `target` selects which body is rewritten
 * (and the direction): a request-target rule rewrites the body forwarded
 * upstream; a response-target rule rewrites the body sent to the client (only
 * for Bounded Responses — see docs/adr/0001). Rules of the same target apply as
 * an ordered pipeline; `stop` halts the pipeline after this rule fires.
 */
export const rewriteRuleSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean().default(true),
    target: z.enum(['request', 'response']),
    match: rewriteMatchSchema.default({}),
    action: rewriteActionSchema,
    stop: z.boolean().optional(),
  })
  .superRefine((rule, ctx) => {
    // Request-target rules cannot reference response-only match fields.
    if (rule.target === 'request') {
      if (rule.match.responseBody !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['match', 'responseBody'],
          message: 'responseBody match is only valid for a response-target rule',
        });
      }
      if (rule.match.status !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['match', 'status'],
          message: 'status match is only valid for a response-target rule',
        });
      }
    }
    // Reject malformed regexes at config-load time.
    const rb = rule.match.requestBody;
    if (rb && !isValidRegex(rb.pattern, rb.flags)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['match', 'requestBody', 'pattern'],
        message: 'invalid regular expression',
      });
    }
    const sb = rule.match.responseBody;
    if (sb && !isValidRegex(sb.pattern, sb.flags)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['match', 'responseBody', 'pattern'],
        message: 'invalid regular expression',
      });
    }
    if (
      rule.action.type === 'regexReplace' &&
      !isValidRegex(rule.action.pattern, rule.action.flags)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'pattern'],
        message: 'invalid regular expression',
      });
    }
  });

export type RewriteRule = z.infer<typeof rewriteRuleSchema>;

/**
 * Which credential-bearing fields get masked in the JSONL record. Names are
 * matched case-insensitively; the defaults cover the Anthropic / OpenAI (incl.
 * Azure) / Gemini families this gateway proxies, plus generic proxy+session
 * credentials. Redaction applies to the LOG ONLY — never to what is forwarded.
 */
export const redactConfigSchema = z.object({
  enabled: z.boolean().default(true),
  requestHeaders: z
    .array(z.string().transform((s) => s.toLowerCase()))
    .default([
      'authorization', // OpenAI, Anthropic, most vendors
      'proxy-authorization', // hop-by-hop: dropped when forwarding, KEPT in the log
      'x-api-key', // Anthropic
      'api-key', // Azure OpenAI
      'x-goog-api-key', // Gemini
      'x-auth-token',
      'cookie',
    ]),
  responseHeaders: z
    .array(z.string().transform((s) => s.toLowerCase()))
    .default(['set-cookie', 'authorization']),
  queryParams: z
    .array(z.string().transform((s) => s.toLowerCase()))
    .default(['key', 'api_key', 'apikey', 'access_token', 'token']),
});

export type RedactConfig = z.infer<typeof redactConfigSchema>;

/**
 * Upstream configuration.
 *
 * baseUrl must be scheme + host ONLY (no path). The proxy appends the incoming
 * request path/query verbatim, so a non-empty path on baseUrl would corrupt the
 * forwarded URL. The zod refine below rejects any baseUrl whose URL pathname is
 * not "" or "/".
 */
export const upstreamConfigSchema = z.object({
  baseUrl: z
    .string()
    .refine(
      (val) => {
        if (val === '') return true; // cold-start: unset baseUrl is allowed
        let u: URL;
        try {
          u = new URL(val);
        } catch {
          return false;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return u.pathname === '' || u.pathname === '/';
      },
      {
        message:
          'baseUrl must be scheme+host only (no path), e.g. "https://api.openai.com"',
      },
    )
    .default(''),
  // undici headersTimeout — time to receive response headers. Never 0/disabled.
  timeoutMs: z.number().int().positive().default(30000),
  // undici bodyTimeout — inter-chunk timeout. Never 0/disabled.
  bodyTimeoutMs: z.number().int().positive().default(120000),
  // Cap for the captured RESPONSE body copy retained in the JSONL log.
  captureBodyLimitBytes: z.number().int().positive().default(5_000_000),
  // Cap for the captured/forwarded REQUEST body. Over this -> 413.
  captureRequestBodyLimitBytes: z.number().int().positive().default(5_000_000),
  // Declarative match -> rewrite rules, applied in array order (see RewriteRule).
  rewriteRules: z.array(rewriteRuleSchema).default([]),
  // Log-only credential masking (see RedactConfig). Never affects forwarding.
  redact: redactConfigSchema.default({}),
});

export type UpstreamConfig = z.infer<typeof upstreamConfigSchema>;

/**
 * Schema accepting a partial config update (PUT body). All fields optional;
 * baseUrl still rejects a path when present.
 */
export const upstreamConfigUpdateSchema = z
  .object({
    baseUrl: z
      .string()
      .refine(
        (val) => {
          if (val === '') return true;
          let u: URL;
          try {
            u = new URL(val);
          } catch {
            return false;
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
          return u.pathname === '' || u.pathname === '/';
        },
        {
          message:
            'baseUrl must be scheme+host only (no path), e.g. "https://api.openai.com"',
        },
      )
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
    bodyTimeoutMs: z.number().int().positive().optional(),
    captureBodyLimitBytes: z.number().int().positive().optional(),
    captureRequestBodyLimitBytes: z.number().int().positive().optional(),
    // Whole-array replace on update (the UI/API submits the full rule list).
    rewriteRules: z.array(rewriteRuleSchema).optional(),
    // Whole-node replace on update, like rewriteRules (the UI submits the full node).
    redact: redactConfigSchema.optional(),
  })
  .strict();

export type UpstreamConfigUpdate = z.infer<typeof upstreamConfigUpdateSchema>;

/** How a captured body is encoded in the JSONL record. */
export type BodyEncoding = 'utf8' | 'base64' | 'empty';

export interface RequestRecord {
  headers: Record<string, string | string[]>;
  /** Captured request body AS FORWARDED (post-rewrite when a rule fired). May be
   * base64 when binary, or null/empty when none. */
  body: string | null;
  bodyEncoding: BodyEncoding;
  /** True if the request body was truncated at captureRequestBodyLimitBytes. */
  bodyTruncated: boolean;
  /** Pre-rewrite body, present ONLY when a request Rewrite Rule changed it. */
  originalBody?: string | null;
  originalBodyEncoding?: BodyEncoding;
}

export interface ResponseRecord {
  status: number;
  headers: Record<string, string | string[]>;
  /** Captured (decoded-if-possible) response body copy. */
  body: string | null;
  bodyEncoding: BodyEncoding;
  /**
   * True if the response body copy was successfully decoded (gzip/deflate/br ->
   * utf8). False when decode failed (body stored as raw base64) — forwarded
   * bytes to the client are always untouched regardless.
   */
  bodyDecodable: boolean;
  /** True if the captured copy was truncated at captureBodyLimitBytes. */
  bodyTruncated: boolean;
  /** Pre-rewrite body, present ONLY when a response Rewrite Rule changed it.
   * Decoded UTF-8 (the form the rewrite operated on). */
  originalBody?: string | null;
  originalBodyEncoding?: BodyEncoding;
}

/**
 * One entry in ExchangeRecord.meta.rewrites: a Rewrite Rule that fired during
 * the exchange. The proxy writes meta.rewrites as RewriteAnnotation[] when any
 * rule changed a body.
 */
export interface RewriteAnnotation {
  name: string;
  target: 'request' | 'response';
  action: 'regexReplace' | 'setBody';
}

/**
 * Latency and throughput measurements for one exchange (see stats.ts). Token
 * counts are what the upstream itself reported — never estimated — so they are
 * null for a response that carries no usage report.
 */
export interface ExchangeStats {
  /**
   * Time To First Token: ms from exchange start to the first response body
   * byte, measured from the same instant as `durationMs`. For a Streaming
   * Response that byte carries the first token; for a Bounded Response the
   * whole body arrives at once, so it is the full generation time.
   */
  ttftMs: number | null;
  /** Prompt tokens reported by the upstream. */
  inputTokens: number | null;
  /** Generated tokens reported by the upstream (reasoning/thinking included). */
  outputTokens: number | null;
  /**
   * `outputTokens` over the observed generation window: `durationMs - ttftMs`
   * for a Streaming Response, `durationMs` for a Bounded one. One decimal.
   */
  tokensPerSecond: number | null;
}

/**
 * One fully-recorded request/response exchange. This is the JSONL line schema.
 * Logger impl lives in task #3, but the TYPE is the cross-task contract.
 */
export interface ExchangeRecord {
  id: string; // ulid
  timestamp: string; // ISO-8601, exchange start
  method: string;
  path: string;
  query: string; // raw query string ("" when none), without leading "?"
  upstreamUrl: string | null; // full forwarded URL, null when no upstream call
  request: RequestRecord;
  response: ResponseRecord;
  /**
   * POST-HOC label (never a routing decision): true if response
   * Content-Type === text/event-stream OR (no Content-Length AND chunkCount > 1).
   */
  streaming: boolean;
  durationMs: number;
  requestBytes: number;
  responseBytes: number; // bytes forwarded to client (original encoding)
  error: string | null; // e.g. upstream_unreachable, upstream_timeout, client_aborted
  /**
   * TTFT + token throughput. Present whenever the upstream produced a response
   * body; omitted on the early-error paths that never reached the upstream.
   */
  stats?: ExchangeStats;
  /**
   * Optional annotations contributed by hooks (e.g. an audit hook setting
   * { audited: true }). Populated from ExchangeContext.meta when non-empty;
   * omitted from the JSONL when no hook wrote anything.
   */
  meta?: Record<string, unknown>;
}

/**
 * Mutable context passed through the hook seam for a single exchange. Hooks
 * (task #3) may inspect and, where applicable, adjust fields. Kept permissive so
 * the hook implementation can evolve without churning the proxy core.
 */
export interface ExchangeContext {
  id: string;
  method: string;
  path: string;
  query: string;
  upstreamUrl: string | null;
  requestHeaders: Record<string, string | string[]>;
  requestBody: Buffer | null;
  /** Populated on the response side; undefined during the request phase. */
  responseStatus?: number;
  responseHeaders?: Record<string, string | string[]>;
  /** Free-form bag for hooks to stash data between request and response phases. */
  state: Record<string, unknown>;
  /**
   * Hook-contributed annotations that should be PERSISTED into the logged
   * ExchangeRecord.meta (e.g. an audit hook setting meta.audited = true).
   * Distinct from `state`, which is ephemeral scratch space not logged.
   */
  meta: Record<string, unknown>;
}

/** A request-phase hook: runs before the upstream call. */
export type RequestHook = (ctx: ExchangeContext) => void | Promise<void>;

/** A response-phase hook: runs after the response is received, before logging. */
export type ResponseHook = (
  ctx: ExchangeContext,
  record: ExchangeRecord,
) => void | Promise<void>;
