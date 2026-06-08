import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LOG_DIR, logFileNameForDate } from './logger.js';
import type { ExchangeRecord } from './types.js';

/** Compact summary returned by listExchanges (mirrors the SSE LogSummary). */
export interface ExchangeSummary {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  streaming: boolean;
  error: string | null;
}

export interface ListOptions {
  limit?: number;
  /** ULID cursor: return only records with id strictly less than this. */
  before?: string;
}

const MAX_LIMIT = 500;

function toSummary(r: ExchangeRecord): ExchangeSummary {
  return {
    id: r.id,
    timestamp: r.timestamp,
    method: r.method,
    path: r.path,
    status: r.response?.status,
    durationMs: r.durationMs,
    streaming: r.streaming,
    error: r.error,
  };
}

/**
 * Candidate day-file names from today backwards, used to walk recent history.
 * ULIDs sort by time, so newest records live in the most recent day file.
 */
function recentDayFiles(days: number): string[] {
  const names: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    names.push(logFileNameForDate(d));
  }
  return names;
}

/**
 * Parse a JSONL file into records, tolerating a malformed/partial trailing
 * line (e.g. a write in flight). Returns [] if the file is absent.
 */
async function readRecords(fileName: string): Promise<ExchangeRecord[]> {
  const filePath = path.join(LOG_DIR, fileName);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = content.split('\n');
  const out: ExchangeRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line) as ExchangeRecord);
    } catch {
      // Tolerate a malformed trailing line (last element); skip any other
      // corrupt line rather than failing the whole read.
      continue;
    }
  }
  return out;
}

/**
 * List exchange summaries, newest-first, paginated by the ULID `before` cursor.
 * Walks recent UTC day files (today + a small look-back window) which is
 * sufficient for the MVP viewer.
 */
export async function listExchanges(
  opts: ListOptions = {},
): Promise<ExchangeSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT);
  const before = opts.before;

  const result: ExchangeSummary[] = [];
  // Look back up to ~7 days; stop early once we have enough.
  for (const fileName of recentDayFiles(7)) {
    const records = await readRecords(fileName);
    // Newest-first within the file (ULID-sortable; also matches append order).
    records.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    for (const r of records) {
      if (before && !(r.id < before)) continue; // strictly before the cursor
      result.push(toSummary(r));
      if (result.length >= limit) return result;
    }
  }
  return result;
}

/** Return the full ExchangeRecord for an id, or null if not found. */
export async function getExchange(id: string): Promise<ExchangeRecord | null> {
  for (const fileName of recentDayFiles(7)) {
    const records = await readRecords(fileName);
    const found = records.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
}

export async function clearAllLogs(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(LOG_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'));
  let deleted = 0;
  for (const file of jsonlFiles) {
    await fs.unlink(path.join(LOG_DIR, file));
    deleted++;
  }
  return deleted;
}
