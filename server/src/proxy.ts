import { pipeline } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest, type Dispatcher } from 'undici';
import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { decodeBody } from './decode.js';
import { TeeTransform } from './tee.js';
import {
  buildUpstreamUrl,
  sanitizeRequestHeaders,
  timeoutOptions,
} from './upstream.js';
import { logExchange } from './logger.js';
import { runRequestHooks, runResponseHooks } from './hooks.js';
import type {
  BodyEncoding,
  ExchangeContext,
  ExchangeRecord,
  ResponseRecord,
} from './types.js';

/** Headers that must NOT be echoed back to the client from the upstream. */
const RESPONSE_HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Normalize a header value to a record entry, lower-casing keys for storage. */
function normalizeHeaders(
  h: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

/** Encode a captured body buffer for the log record. */
function encodeBody(
  buf: Buffer,
  decodable: boolean,
): { body: string | null; encoding: BodyEncoding } {
  if (buf.length === 0) return { body: null, encoding: 'empty' };
  if (!decodable) return { body: buf.toString('base64'), encoding: 'base64' };
  return { body: buf.toString('utf8'), encoding: 'utf8' };
}

const utf8Validator = new TextDecoder('utf-8', { fatal: true });

/** True if the buffer is valid UTF-8 (no replacement-character corruption). */
function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8Validator.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode a captured REQUEST body for the log record without lossy corruption:
 * store as utf8 when the bytes are clean UTF-8, otherwise base64 (with
 * bodyDecodable=false semantics, mirroring the response path). The forwarded
 * upstream bytes are always the original Buffer and unaffected by this.
 */
function encodeRequestBody(buf: Buffer): {
  body: string | null;
  encoding: BodyEncoding;
  decodable: boolean;
} {
  if (buf.length === 0) return { body: null, encoding: 'empty', decodable: true };
  if (isValidUtf8(buf)) {
    return { body: buf.toString('utf8'), encoding: 'utf8', decodable: true };
  }
  return { body: buf.toString('base64'), encoding: 'base64', decodable: false };
}

/**
 * Extract the buffered request body. The catch-all content-type parser (in
 * index.ts) buffers any body into `request.body` as a Buffer; an empty/absent
 * body is normalized to an empty Buffer. The cap check (413) is applied by the
 * caller against the per-request config snapshot.
 */
function getRequestBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (Buffer.isBuffer(body)) return body;
  if (body == null) return Buffer.alloc(0);
  // Defensive: a non-buffer body (shouldn't happen for proxied paths).
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(JSON.stringify(body), 'utf8');
}

/**
 * The always-stream-through proxy catch-all handler.
 *
 * ONE forwarding path, no streaming/non-streaming branch. The pipeline callback
 * (AR2) is the SOLE owner of terminal disposition for the success/error path.
 */
export async function proxyHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // (1) Per-request config snapshot — taken ONCE at entry.
  const config = getConfig();
  const startedAt = Date.now();
  const id = ulid();
  const timestamp = new Date(startedAt).toISOString();

  const rawUrl = request.raw.url ?? request.url; // path + ?query
  const qIdx = rawUrl.indexOf('?');
  const pathOnly = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const query = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);
  const method = request.method;
  const requestHeaders = normalizeHeaders(
    request.headers as Record<string, string | string[] | undefined>,
  );

  // Shared mutable context for hooks.
  const ctx: ExchangeContext = {
    id,
    method,
    path: pathOnly,
    query,
    upstreamUrl: null,
    requestHeaders,
    requestBody: null,
    state: {},
    meta: {},
  };

  // Helper: build + ship a record for the non-streamed error/early paths.
  const finalizeEarly = async (
    statusCode: number,
    errCode: string,
    requestBuf: Buffer,
    requestTruncated: boolean,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const reqEnc = encodeRequestBody(requestBuf);
    const record: ExchangeRecord = {
      id,
      timestamp,
      method,
      path: pathOnly,
      query,
      upstreamUrl: ctx.upstreamUrl,
      request: {
        headers: requestHeaders,
        body: reqEnc.body,
        bodyEncoding: reqEnc.encoding,
        bodyTruncated: requestTruncated,
      },
      response: {
        status: statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        bodyEncoding: 'utf8',
        bodyDecodable: true,
        bodyTruncated: false,
      },
      streaming: false,
      durationMs: Date.now() - startedAt,
      requestBytes: requestBuf.length,
      responseBytes: Buffer.byteLength(JSON.stringify(body)),
      error: errCode,
    };
    ctx.responseStatus = statusCode;
    ctx.responseHeaders = record.response.headers;
    try {
      await runResponseHooks(ctx, record);
    } catch {
      /* hooks must never break the path */
    }
    // Persist hook-contributed annotations (after response hooks ran).
    if (Object.keys(ctx.meta).length > 0) record.meta = { ...ctx.meta };
    await logExchange(record);
    reply.code(statusCode).type('application/json').send(body);
  };

  // (2) Cold start: no upstream configured -> 503, logged, no upstream call.
  if (!config.baseUrl) {
    await finalizeEarly(503, 'upstream_not_configured', Buffer.alloc(0), false, {
      error: 'upstream_not_configured',
    });
    return;
  }

  // (3) Buffered request body; enforce the configured cap -> 413.
  const requestBuf = getRequestBody(request);
  if (requestBuf.length > config.captureRequestBodyLimitBytes) {
    await finalizeEarly(413, 'request_too_large', requestBuf, true, {
      error: 'request_too_large',
    });
    return;
  }
  ctx.requestBody = requestBuf;

  // Build the upstream target.
  const target = buildUpstreamUrl(config.baseUrl, rawUrl);
  ctx.upstreamUrl = target.url;

  // Request-phase hooks run BEFORE forwarding and may mutate ctx.requestHeaders
  // (e.g. a rewrite hook adding a trace header). We therefore derive the
  // outbound headers from ctx.requestHeaders AFTER the hooks run, so those
  // mutations are actually forwarded upstream.
  try {
    await runRequestHooks(ctx);
  } catch {
    /* hooks must never break the path */
  }
  const outHeaders = sanitizeRequestHeaders(ctx.requestHeaders, target.host);

  const reqEnc = encodeRequestBody(ctx.requestBody ?? requestBuf);
  const requestRecord = {
    headers: ctx.requestHeaders,
    body: reqEnc.body,
    bodyEncoding: reqEnc.encoding,
    bodyTruncated: false,
  };

  // (5) Issue the upstream request.
  const hasBody = requestBuf.length > 0;
  let upstream;
  try {
    upstream = await undiciRequest(target.url, {
      method: method as Dispatcher.HttpMethod,
      headers: outHeaders,
      body: hasBody ? requestBuf : undefined,
      ...timeoutOptions(config),
    });
  } catch (err) {
    await finalizeUpstreamError(err);
    return;
  }

  // We have response headers. Commit to streaming through via hijack.
  const upstreamStatus = upstream.statusCode;
  const upstreamHeaders = upstream.headers;
  ctx.responseStatus = upstreamStatus;
  ctx.responseHeaders = normalizeHeaders(
    upstreamHeaders as Record<string, string | string[] | undefined>,
  );

  // (4) Hijack: we own reply.raw from here. Fastify will not touch it.
  reply.hijack();

  // Write status + sanitized response headers (preserving Content-Encoding).
  const contentType = headerValue(upstreamHeaders['content-type']);
  const contentLength = headerValue(upstreamHeaders['content-length']);
  writeResponseHead(reply, upstreamStatus, upstreamHeaders);

  const tee = new TeeTransform(config.captureBodyLimitBytes);
  let settled = false;

  // Capture pipeline / socket errors so they never become unhandled 'error'
  // events that crash the process (AR2).
  let clientAborted = false;
  reply.raw.on('error', (e) => {
    // ECONNRESET / EPIPE on client disconnect land here.
    if (!settled) clientAborted = true;
    request.log.warn({ err: e?.message }, '[proxy] reply.raw error');
  });
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) clientAborted = true;
  });

  // (6) THE single forwarding pipeline. Its callback is the SOLE owner of
  // terminal disposition: compute label -> decode log copy -> build record ->
  // response hooks -> log.
  pipeline(upstream.body, tee, reply.raw, (pipeErr) => {
    if (settled) return;
    settled = true;
    void finalizeStreamed(pipeErr ?? null);
  });

  // ── terminal disposition for the streamed path ─────────────────────────────
  async function finalizeStreamed(pipeErr: Error | null): Promise<void> {
    const durationMs = Date.now() - startedAt;

    // POST-HOC streaming label (never a routing decision).
    const ctHeader = (contentType ?? '').toLowerCase();
    const isEventStream = ctHeader.includes('text/event-stream');
    const noContentLength = contentLength === undefined;
    const streaming = isEventStream || (noContentLength && tee.chunkCount > 1);

    // Decode the captured copy (log-only, failure-tolerant).
    const captured = tee.getCaptured();
    const decoded = decodeBody(captured, upstreamHeaders['content-encoding']);
    const decodable = decoded.decodable;
    const forLog = decodable && decoded.buffer ? decoded.buffer : captured;
    const enc = encodeBody(forLog, decodable);

    // Map a pipeline error to an error code (timeouts/abort can surface late).
    let error: string | null = null;
    if (pipeErr) {
      error = classifyError(pipeErr, 'stream');
    } else if (clientAborted && !reply.raw.writableEnded) {
      error = 'client_aborted';
    }

    const response: ResponseRecord = {
      status: upstreamStatus,
      headers: ctx.responseHeaders ?? {},
      body: enc.body,
      bodyEncoding: enc.encoding,
      bodyDecodable: decodable,
      bodyTruncated: tee.truncated,
    };

    const record: ExchangeRecord = {
      id,
      timestamp,
      method,
      path: pathOnly,
      query,
      upstreamUrl: ctx.upstreamUrl,
      request: requestRecord,
      response,
      streaming,
      durationMs,
      requestBytes: requestBuf.length,
      responseBytes: tee.totalBytes,
      error,
    };

    try {
      await runResponseHooks(ctx, record);
    } catch {
      /* hooks must never break the path */
    }
    // Persist hook-contributed annotations (after response hooks ran).
    if (Object.keys(ctx.meta).length > 0) record.meta = { ...ctx.meta };
    await logExchange(record);

    // Gate the explicit end (AR2): only end if not already ended/destroyed.
    if (!reply.raw.writableEnded && !reply.raw.destroyed) {
      reply.raw.end();
    }
  }

  // ── terminal disposition for connect/DNS/TLS/timeout BEFORE streaming ───────
  async function finalizeUpstreamError(err: unknown): Promise<void> {
    const code = classifyError(err, 'connect');
    const statusCode = code === 'upstream_timeout' ? 504 : 502;
    const bodyObj =
      code === 'upstream_timeout'
        ? { error: 'upstream_timeout' }
        : { error: 'upstream_unreachable' };
    await finalizeEarly(statusCode, code, requestBuf, false, bodyObj);
  }
}

/**
 * Map an undici/Node error to one of our error codes. `phase` disambiguates
 * errors that are ambiguous on their own: an ECONNRESET *before* we have
 * upstream headers means the upstream reset us (unreachable), whereas the same
 * error *during* the downstream pipeline means the client went away (aborted).
 */
function classifyError(err: unknown, phase: 'connect' | 'stream'): string {
  const code = (err as { code?: string })?.code ?? '';
  const name = (err as { name?: string })?.name ?? '';
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'upstream_timeout';
  }
  // Downstream pipeline went away: client closed the connection.
  if (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    name === 'AbortError' ||
    code === 'UND_ERR_ABORTED' ||
    code === 'EPIPE'
  ) {
    return 'client_aborted';
  }
  // ECONNRESET is phase-dependent (see doc above).
  if (code === 'ECONNRESET') {
    return phase === 'stream' ? 'client_aborted' : 'upstream_unreachable';
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    code === 'CERT_HAS_EXPIRED' ||
    code.startsWith('UNABLE_TO_') ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return 'upstream_unreachable';
  }
  return phase === 'stream' ? 'client_aborted' : 'upstream_unreachable';
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * Write the status line + response headers to the raw socket, preserving the
 * upstream Content-Encoding untouched and dropping hop-by-hop headers.
 */
function writeResponseHead(
  reply: FastifyReply,
  status: number,
  headers: Record<string, string | string[] | undefined>,
): void {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (RESPONSE_HOP_BY_HOP.has(key)) continue;
    out[k] = v;
  }
  reply.raw.writeHead(status, out);
}
