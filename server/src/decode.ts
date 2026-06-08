import zlib from 'node:zlib';

/**
 * Result of attempting to decode a captured (log-copy-only) response body.
 * When decodable is false the caller must store the RAW bytes as base64 — the
 * forwarded response to the client always preserves the original
 * Content-Encoding regardless of this outcome.
 */
export interface DecodeResult {
  decodable: boolean;
  /** The decoded buffer when decodable; undefined otherwise. */
  buffer?: Buffer;
}

/**
 * Failure-tolerant decompression for the LOG copy only (A4).
 *
 * Handles gzip / deflate / br. On ANY failure — unknown encoding, truncated or
 * stateful stream (e.g. a captured SSE prefix), corrupt bytes — returns
 * { decodable:false } and NEVER throws. The caller then stores the raw bytes as
 * base64. Multiple comma-separated encodings are intentionally treated as
 * not-decodable (we only attempt a single, simple layer).
 */
export function decodeBody(
  buf: Buffer,
  contentEncoding: string | string[] | undefined,
): DecodeResult {
  // No encoding header -> body is already identity; "decodable" as-is.
  if (contentEncoding === undefined) {
    return { decodable: true, buffer: buf };
  }

  const enc = (Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding)
    .trim()
    .toLowerCase();

  if (enc === '' || enc === 'identity') {
    return { decodable: true, buffer: buf };
  }

  try {
    switch (enc) {
      case 'gzip':
      case 'x-gzip':
        return { decodable: true, buffer: zlib.gunzipSync(buf) };
      case 'deflate':
        return { decodable: true, buffer: zlib.inflateSync(buf) };
      case 'br':
        return { decodable: true, buffer: zlib.brotliDecompressSync(buf) };
      default:
        // Unknown or multi-layer encoding — do not attempt.
        return { decodable: false };
    }
  } catch {
    // Truncated/corrupt/stateful stream — never propagate.
    return { decodable: false };
  }
}
