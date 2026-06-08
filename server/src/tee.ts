import { Transform, type TransformCallback } from 'node:stream';

/**
 * A pass-through Transform that forwards every chunk downstream UNBUFFERED
 * (back-pressure preserved) while teeing a bounded copy into an in-memory
 * accumulator for the log record.
 *
 * - Forwarding is never gated on the accumulator: chunks pass straight through
 *   so SSE / incremental responses reach the client with no added latency.
 * - The accumulator stops appending once `capBytes` is reached and sets
 *   `truncated = true`; forwarding continues regardless.
 * - Tracks `chunkCount` and `totalBytes` (bytes forwarded, original encoding),
 *   used by the proxy to compute the post-hoc `streaming` label and
 *   `responseBytes`.
 */
export class TeeTransform extends Transform {
  private readonly capBytes: number;
  private readonly captured: Buffer[] = [];
  private capturedBytes = 0;

  public truncated = false;
  public chunkCount = 0;
  public totalBytes = 0;

  constructor(capBytes: number) {
    super();
    this.capBytes = capBytes;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    // Normalize to Buffer (upstream body emits Buffers, but be defensive).
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    this.chunkCount += 1;
    this.totalBytes += buf.length;

    // Accumulate up to the cap; never block forwarding on this.
    if (!this.truncated) {
      const remaining = this.capBytes - this.capturedBytes;
      if (remaining > 0) {
        if (buf.length <= remaining) {
          this.captured.push(buf);
          this.capturedBytes += buf.length;
        } else {
          this.captured.push(buf.subarray(0, remaining));
          this.capturedBytes += remaining;
          this.truncated = true;
        }
      } else {
        this.truncated = true;
      }
    }

    // Forward the FULL original chunk downstream, unbuffered.
    callback(null, buf);
  }

  /** Returns the bounded captured copy (original encoding, possibly truncated). */
  getCaptured(): Buffer {
    return Buffer.concat(this.captured, this.capturedBytes);
  }
}
