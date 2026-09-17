# AGENTS.md — LLM Gateway MVP

## What This Is

A reverse-proxy gateway for LLM APIs that captures full request/response exchanges in JSONL logs. Monorepo with three packages:

- **server/** — Fastify 5 proxy + API (TypeScript, ESM, NodeNext)
- **web/** — React 18 SPA (Vite 6)
- **test/** — Mock upstream + E2E verification suite

## Commands

```sh
pnpm dev                  # server + web in parallel (tsx watch + vite)
pnpm build                # web first, then server (ORDER MATTERS)
pnpm --filter web build   # web only
pnpm --filter server build # server only
node server/dist/index.js  # production start (PORT=8080 default)
```

No unit test framework. Verification is E2E only:

```sh
pnpm build && node test/verify/run.mjs   # builds, starts mocks+gateway, runs checks
pnpm build && node test/verify/ui.mjs    # browser checks (banner gate, measurement readout, modal layout, beautified SSE body); SKIPS without playwright-cli
node test/mock-upstream.mjs [port]        # standalone mock upstream (default :9090)
```

`run.mjs` is headless and dependency-free. UI behaviour that only exists in the
DOM lives in `ui.mjs`, which drives a real browser via `playwright-cli` — asserting
on the built bundle's text cannot tell a gated element from an unconditional one.

## URL Layout

| Path | Owner |
|------|-------|
| `/__gateway/app/` | SPA (served from `web/dist/`) |
| `/__gateway/api/config` | Config API (GET/PUT) |
| `/__gateway/api/logs` | Logs API (GET, cursor-paginated) |
| `/__gateway/api/logs/stream` | SSE live tail |
| `/__gateway/api/logs/:id` | Single log record |
| Everything else | Proxied to upstream |

## Architecture Notes

**Config** (`config.json` at root, gitignored):
- Validated with zod. `baseUrl` must be scheme+host only (no path).
- Runtime updates via PUT — no restart needed. Config is immutable; updates atomically swap a frozen object reference.
- PUT replaces object and array nodes (`rewriteRules`, `redact`) wholesale — send the complete node. A partial PUT of `redact` resets the name lists you omit back to schema defaults, it does not merge.

**Proxy core** (`server/src/proxy.ts`):
- Uses `reply.hijack()` — Fastify does not touch the response after that.
- Catch-all content parser buffers ALL bodies as Buffer. JSON parsing is restored only inside `/__gateway/api` scope.
- `TeeTransform` tees a bounded copy for logging without blocking forwarding.
- Streaming label is POST-HOC only (never a routing decision): `text/event-stream` OR (no `Content-Length` AND `chunkCount > 1`).
- Log redaction (`redact.ts`) is applied to a **copy** of the record at `finalizeRecord`, the single `logExchange` caller. Forwarding and `ctx` are never redacted — a redacted `ctx.requestHeaders` would reach the upstream and 401. See `docs/adr/0003`.

**Hook system** (`server/src/hooks.ts`):
- Request hooks run BEFORE forwarding (can mutate `ctx.requestHeaders`).
- Response hooks run AFTER response, BEFORE logging.
- Hooks self-register via side-effect import at startup (see `server/src/hooks/example-audit.ts`).
- Example hook is enabled by default; disable with `GATEWAY_EXAMPLE_HOOKS=0`.
- Hooks see unredacted values, and anything a hook writes into `ctx.meta` is logged verbatim (not covered by redaction).

**Stats** (`server/src/stats.ts`):
- `stats.ttftMs` is the first response BODY byte, timed from the same instant as `durationMs` (gateway entry) — the TTFT the client experienced. Read off `TeeTransform.firstChunkAt` on the stream-through path, off `collectStream` on the buffered one.
- Token counts are ONLY what the upstream reported (`usage` / `usageMetadata`; OpenAI, Anthropic, Gemini; bounded + streaming). Nothing is estimated, so a response without a usage report logs nulls.
- `tokensPerSecond` divides by the observed generation window: `durationMs - ttftMs` when streaming, `durationMs` when bounded. See `docs/adr/0004`.
- Parsing happens at finalize time, after forwarding — never on the client's latency path — and is fail-open: an unparseable or truncated body yields nulls.

**JSONL logger** (`server/src/logger.ts`):
- Single-writer chain with per-link error isolation. UTC-dated files in `logs/`.
- `logEvents` EventEmitter drives the SSE live tail.

## TypeScript Quirks

- ESM everywhere (`"type": "module"`). Server uses `NodeNext` module resolution — imports must use `.js` extensions even for `.ts` source files.
- Server target: ES2022. Web target: ES2020.
- `strict: true` in both packages. Web additionally enforces `noUnusedLocals` and `noUnusedParameters`.

## Ports

| Service | Default | Override |
|---------|---------|----------|
| Gateway | :8080 | `PORT` env |
| Mock upstream | :9090 | CLI arg or `PORT` env |
| Vite dev | :5173 | vite.config.ts |

Vite proxies `/__gateway/api` and `/__gateway/app` to `:8080` in dev mode. SSE buffering is disabled via `X-Accel-Buffering: no`.

## Files to Know

| File | Why it matters |
|------|----------------|
| `server/src/index.ts` | App bootstrap, route registration, proxy catch-all |
| `server/src/proxy.ts` | Core proxy logic — hijack, tee, error classification |
| `server/src/types.ts` | Zod schemas + all shared TypeScript types |
| `server/src/config.ts` | Config load/persist/update (atomic swap) |
| `server/src/hooks.ts` | Hook seam — registerRequestHook / registerResponseHook |
| `server/src/logger.ts` | JSONL append chain + SSE event bus |
| `server/src/upstream.ts` | URL building, header sanitization, timeout options |
| `server/src/redact.ts` | Log-time credential masking, applied to a copy at the `logExchange` funnel |
| `server/src/stats.ts` | TTFT + token-speed measurement and upstream usage parsing |
| `test/verify/run.mjs` | E2E acceptance criteria (C1–C7, A1–A4, AR1, B1, RD1–RD7, RW1–RW8, SHOW1–SHOW2, TS1–TS4) |
| `test/mock-upstream.mjs` | Mock endpoints: /json, /sse, /tokens-sse, /tokens-json, /gemini-stream, /slow, /gzip, /badgzip, /hang, /reset, /creds |

## Gotchas

1. **Build order**: `pnpm build` runs web first because server serves `web/dist/`. Don't reverse this.
2. **config.json is gitignored** — it's runtime state, not source. The server auto-creates it with defaults if missing.
3. **logs/ is gitignored** — JSONL files are ephemeral. Don't commit test artifacts there.
4. **No `as any` or `@ts-ignore`** — strict TypeScript is enforced. Fix type errors properly.
5. **Hook imports are side-effects** — importing a hook module registers it. Don't import hook files in tests unless you want them active.
6. **Proxy body handling** — Fastify's default parsers are removed globally. The catch-all parser returns a Buffer. Don't add new content-type parsers without understanding the encapsulation scope.
7. **Redaction covers headers, query string and `upstreamUrl` — not bodies.** A credential in a request or response body is still logged in plaintext.
