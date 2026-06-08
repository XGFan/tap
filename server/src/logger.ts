import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getProjectRoot } from './config.js';
import type { ExchangeRecord } from './types.js';

/**
 * Single-writer JSONL logger (A1).
 *
 * The proxy hands us a FULLY-BUILT ExchangeRecord (body encoding decisions —
 * utf8 vs base64, bodyDecodable — are already made in proxy.ts via its
 * encodeBody helper). The logger's only jobs are: serialize appends so no two
 * writes interleave into a torn line, and emit a compact summary AFTER each
 * successful append to feed the SSE live tail (task #4).
 */

export const LOG_DIR = path.join(getProjectRoot(), 'logs');

/** Event bus for live-tail consumers. Emits 'exchange' with a LogSummary. */
export const logEvents = new EventEmitter();
// Many SSE clients may subscribe; raise the bound well above the default 10 to
// support concurrent live-tail connections, but keep it FINITE so the
// MaxListenersExceeded leak-detection safety net still fires on a real leak.
logEvents.setMaxListeners(1000);

export interface LogSummary {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  streaming: boolean;
  error: string | null;
}

/** UTC-dated log file name for a given Date (deterministic, no local TZ). */
export function logFileNameForDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `exchanges-${yyyy}-${mm}-${dd}.jsonl`;
}

/** Absolute path to the UTC-dated log file for a given Date (default: now). */
export function logFilePathForDate(d: Date = new Date()): string {
  return path.join(LOG_DIR, logFileNameForDate(d));
}

function summarize(record: ExchangeRecord): LogSummary {
  return {
    id: record.id,
    timestamp: record.timestamp,
    method: record.method,
    path: record.path,
    status: record.response.status,
    durationMs: record.durationMs,
    streaming: record.streaming,
    error: record.error,
  };
}

let dirEnsured = false;
async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

/**
 * The serialization chain. Each logExchange enqueues its append as the next
 * link. Every link has its OWN .catch() so a single failed append (disk full,
 * permission error) is swallowed for that record and NEVER poisons or wedges
 * the chain — subsequent appends still run.
 */
let chain: Promise<void> = Promise.resolve();

export function logExchange(record: ExchangeRecord): Promise<void> {
  // Derive the target file from the record's own timestamp so a record always
  // lands in its date's file even if it crosses a UTC midnight boundary.
  const when = new Date(record.timestamp);
  const filePath = logFilePathForDate(
    Number.isNaN(when.getTime()) ? new Date() : when,
  );

  const link = chain.then(async () => {
    // Serialize INSIDE the link so even a pathological record (e.g. a circular
    // structure that makes JSON.stringify throw) becomes a per-link failure
    // rather than a synchronous throw to the caller — the logger must never
    // throw into the proxy's terminal path.
    const line = JSON.stringify(record) + '\n';
    await ensureDir();
    // appendFile opens/writes/closes atomically for a single small write; the
    // serialization above guarantees links never overlap, so lines never tear.
    await fs.appendFile(filePath, line, 'utf8');
    // Emit only AFTER a durable append succeeds — drives the SSE tail.
    logEvents.emit('exchange', summarize(record));
  });

  // Keep the chain progressing even when a link rejects: swallow per-link.
  chain = link.catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[logger] append failed for', record.id, err);
  });

  // Return a promise that resolves/rejects for THIS caller without breaking the
  // shared chain (callers may await for tests; the proxy fires-and-awaits).
  return link;
}
