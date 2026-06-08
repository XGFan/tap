import { z } from 'zod';

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
  })
  .strict();

export type UpstreamConfigUpdate = z.infer<typeof upstreamConfigUpdateSchema>;

/** How a captured body is encoded in the JSONL record. */
export type BodyEncoding = 'utf8' | 'base64' | 'empty';

export interface RequestRecord {
  headers: Record<string, string | string[]>;
  /** Captured request body. May be base64 when binary, or null/empty when none. */
  body: string | null;
  bodyEncoding: BodyEncoding;
  /** True if the request body was truncated at captureRequestBodyLimitBytes. */
  bodyTruncated: boolean;
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
