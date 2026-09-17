# test/ — Gateway Verification Suite

## Mock Upstream Server

`test/mock-upstream.mjs` is a standalone Node.js HTTP server (no npm dependencies) used by the end-to-end verification suite to simulate various upstream behaviours.

### Start

```sh
node test/mock-upstream.mjs [port]   # default port 9090
PORT=9091 node test/mock-upstream.mjs
```

### Endpoints

| Method | Path | Description | Used by |
|--------|------|-------------|---------|
| GET/POST | `/json` | 200 JSON `{"ok":true,"echo":<body>}` with fixed `Content-Length` | Pass-through identity, header checks |
| POST | `/sse` | `text/event-stream`; emits `data: {"i":N}` × 3 at 100 ms intervals then `data: [DONE]`, each flushed immediately | Streaming low-latency + full-capture test |
| POST | `/tokens-sse` | Anthropic-shaped `text/event-stream`: 120 ms before the first event, then `message_start` (`input_tokens`), 3 deltas 60 ms apart, `message_delta` (`output_tokens`) | TS1/TS4 + UI4/UI5: TTFT and token speed |
| POST | `/tokens-json` | OpenAI-shaped bounded JSON with `usage.prompt_tokens` / `completion_tokens`, sent after an 80 ms pause | TS2: usage from a Bounded Response |
| POST | `/gemini-stream` | `application/json`, **no** `Content-Length`; streams `[{"a":1},` → `{"b":2},` → `{"c":3}]` in 3 chunks | Gemini-style incremental JSON / JSONL integrity |
| POST | `/slow` | Sends 1 chunk immediately, then sleeps 5 s before ending | Client-abort (A2/M3) + body-timeout reaping (AR1) |
| GET | `/gzip` | Valid gzip-compressed JSON body with correct `Content-Encoding: gzip` | Gzip pass-through / decompression |
| GET | `/badgzip` | `Content-Encoding: gzip` header but truncated garbage bytes | A4 bad-gzip: `bodyDecodable:false` in JSONL log |
| GET | `/hang` | Sends headers + 1 chunk, then holds connection open forever | AR1: body-timeout reaps hung upstream while SSE is NOT reaped |
| POST | `/reset` | Accepts request then calls `req.socket.destroy()` mid-body | A2/M3: client-abort + `/reset`; no crash + one JSONL line |
| GET | `/creds` | 200 JSON `{"ok":true}` with `Set-Cookie` and `Authorization` response headers carrying credential-shaped values | Redaction tests: response-header masking (RD3) |
| GET | `/__seen` | Returns JSON map of all recorded requests (method, path, headers) | Header pass-through assertions: `Authorization` kept, `Host` rewritten, `Connection` stripped |

### Notes

- The server records the last request per path in memory; `/__seen` returns the full map so tests can verify headers from any prior endpoint hit.
- `/hang` never ends — tests must use a short `bodyTimeout` or `--max-time` to avoid hanging indefinitely.
- `/reset` will cause curl to exit with code 52 (empty reply) — this is the expected behaviour.

## Verification Suite

`test/verify/` contains the end-to-end scripts for task #7. They require the gateway (`:8080`) and mock upstream (`:9090`) to both be running. See individual scripts for usage.
