import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  upstreamConfigSchema,
  type UpstreamConfig,
  type UpstreamConfigUpdate,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is two levels up from server/dist (or server/src in dev):
//   <root>/server/dist/config.js  -> <root>
//   <root>/server/src/config.ts   -> <root>
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Mutable runtime state (config.json + logs/) lives under DATA_DIR. Defaults to
// the project root — identical to before for local dev and the E2E suite — but
// can be relocated onto a mounted volume in containerized deploys by setting
// TAP_DATA_DIR (e.g. a Kubernetes PVC). config.json and its temp file MUST share
// a directory so the atomic write (temp file + rename) never crosses a
// filesystem boundary (a cross-device rename fails with EXDEV).
const DATA_DIR = process.env.TAP_DATA_DIR
  ? path.resolve(process.env.TAP_DATA_DIR)
  : PROJECT_ROOT;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/**
 * The single in-memory config reference. NEVER mutated in place — update()
 * builds a brand-new frozen object and atomically swaps this reference.
 */
let current: UpstreamConfig = Object.freeze(upstreamConfigSchema.parse({}));

/** Returns the current immutable config reference. */
export function getConfig(): UpstreamConfig {
  return current;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

/** Directory holding mutable runtime state (config.json + logs/). */
export function getDataDir(): string {
  return DATA_DIR;
}

/** Persist a config object to config.json atomically (temp file + rename). */
async function persist(cfg: UpstreamConfig): Promise<void> {
  const tmp = path.join(
    DATA_DIR,
    `.config.json.${process.pid}.${Date.now()}.tmp`,
  );
  const data = JSON.stringify(cfg, null, 2) + '\n';
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, CONFIG_PATH); // atomic on the same filesystem
}

/**
 * Load config.json from the project root. If absent, materialize defaults and
 * write them out. Validates with zod; on a malformed file we fall back to
 * defaults (and overwrite) rather than crash the gateway.
 */
export async function loadConfig(): Promise<UpstreamConfig> {
  // TAP_DATA_DIR may point at a freshly-mounted volume that does not exist yet.
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = upstreamConfigSchema.parse(JSON.parse(raw));
    current = Object.freeze(parsed);
    return current;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // Malformed/invalid existing config — log and reset to defaults.
      // eslint-disable-next-line no-console
      console.warn(
        `[config] failed to load ${CONFIG_PATH}, using defaults:`,
        err instanceof Error ? err.message : err,
      );
    }
    const defaults = Object.freeze(upstreamConfigSchema.parse({}));
    current = defaults;
    await persist(defaults);
    return current;
  }
}

/**
 * Apply a partial update: merge over the current config, validate the WHOLE
 * resulting object, persist atomically, THEN swap the in-memory reference.
 * Throws (zod error) on invalid input — nothing is mutated or persisted in that
 * case.
 */
export async function update(
  partial: UpstreamConfigUpdate,
): Promise<UpstreamConfig> {
  const merged = { ...current, ...partial };
  const validated = upstreamConfigSchema.parse(merged);
  const next = Object.freeze(validated);
  await persist(next);
  current = next; // atomic reference swap
  return current;
}
