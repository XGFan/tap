import zlib from 'node:zlib';

/**
 * Result of attempting to re-compress a rewritten body back into the upstream's
 * original Content-Encoding. The mirror of decode.ts: when `encodable` is false
 * the caller must FAIL OPEN (forward the original, un-rewritten bytes) because we
 * cannot reproduce the wire encoding the client/upstream expects.
 */
export interface EncodeResult {
  encodable: boolean;
  /** The re-compressed buffer when encodable; undefined otherwise. */
  buffer?: Buffer;
}

/**
 * Re-compress `buf` to the SAME single Content-Encoding the body originally
 * carried (so a rewritten Bounded Response can be sent with its wire format
 * preserved). Mirrors decodeBody: handles gzip / x-gzip / deflate / br and
 * identity; unknown or multi-layer encodings return { encodable:false }. Never
 * throws.
 */
export function encodeBody(
  buf: Buffer,
  contentEncoding: string | string[] | undefined,
): EncodeResult {
  // No encoding header -> body stays identity.
  if (contentEncoding === undefined) {
    return { encodable: true, buffer: buf };
  }

  const enc = (Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding)
    .trim()
    .toLowerCase();

  if (enc === '' || enc === 'identity') {
    return { encodable: true, buffer: buf };
  }

  try {
    switch (enc) {
      case 'gzip':
      case 'x-gzip':
        return { encodable: true, buffer: zlib.gzipSync(buf) };
      case 'deflate':
        return { encodable: true, buffer: zlib.deflateSync(buf) };
      case 'br':
        return { encodable: true, buffer: zlib.brotliCompressSync(buf) };
      default:
        // Unknown or multi-layer encoding — cannot reproduce; caller fails open.
        return { encodable: false };
    }
  } catch {
    return { encodable: false };
  }
}
