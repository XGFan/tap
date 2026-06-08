import type { UpstreamConfig } from './types.js';

/**
 * Hop-by-hop headers that must NOT be forwarded to the upstream (RFC 7230 §6.1
 * plus the proxy-* pair). Lower-cased for comparison.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface UpstreamTarget {
  url: string;
  host: string;
}

/**
 * Build the upstream URL: config.baseUrl (scheme+host only, enforced by config
 * validation) + the client's verbatim path + query. `rawPath` is the full
 * incoming request URL (path + "?query"), e.g. "/v1/chat/completions?x=1".
 */
export function buildUpstreamUrl(
  baseUrl: string,
  rawPath: string,
): UpstreamTarget {
  // Trim a trailing slash off the base so we don't get a double slash.
  const base = baseUrl.replace(/\/+$/, '');
  const url = `${base}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
  const host = new URL(base).host;
  return { url, host };
}

/**
 * Produce sanitized outbound headers:
 * - drop hop-by-hop headers
 * - rewrite Host to the upstream host
 * - drop content-length (undici recomputes from the body we pass)
 * - KEEP auth headers (authorization, x-api-key, x-goog-api-key) untouched
 */
export function sanitizeRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstreamHost: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [rawKey, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'host') continue; // rewritten below
    if (key === 'content-length') continue; // undici sets this from the body
    out[rawKey] = value;
  }
  out['host'] = upstreamHost;
  return out;
}

/**
 * undici request options enforcing AR1 timeouts. headersTimeout caps how long
 * we wait for response headers; bodyTimeout is the inter-chunk timeout. Neither
 * is ever 0/disabled.
 */
export function timeoutOptions(config: UpstreamConfig): {
  headersTimeout: number;
  bodyTimeout: number;
} {
  return {
    headersTimeout: config.timeoutMs,
    bodyTimeout: config.bodyTimeoutMs,
  };
}
