# Gateway E2E Verification Report

Generated: 2026-09-17T14:16:10.238Z

## Summary

| Criterion | Status |
|-----------|--------|
| C1 Pass-through identity | ✅ PASS |
| C2a SSE streaming low-latency + capture | ✅ PASS |
| C2b Gemini-stream low-latency + capture | ✅ PASS |
| C3 Header handling | ✅ PASS |
| C4 JSONL integrity | ✅ PASS |
| C5 Runtime config no-restart | ✅ PASS |
| C6 Hook seam end-to-end | ✅ PASS |
| C7 Single-artifact build+start | ✅ PASS |
| A1 50-concurrent no torn lines | ✅ PASS |
| A2a Client abort /slow | ✅ PASS |
| A2b Upstream /reset socket destroy | ✅ PASS |
| A4 Bad gzip bodyDecodable:false | ✅ PASS |
| AR1 Timeout reaping: /hang reaped, /sse NOT reaped | ✅ PASS |
| C3 Cold start 503 | ✅ PASS |
| B1 Non-UTF8 body→base64, UTF-8 body→utf8 | ✅ PASS |
| RD5 Schema defaults: redact.enabled=true, requestHeaders includes authorization | ✅ PASS |
| RD1 Credential header: upstream verbatim, log masked | ✅ PASS |
| RD1b Basic credentials masked whole (no decodable tail) | ✅ PASS |
| RD1c Cookie headers masked per pair (reveal not positional) | ✅ PASS |
| RD2 Query credential: forwarded verbatim, masked in query and upstreamUrl | ✅ PASS |
| RD3 Response headers masked, client copy untouched | ✅ PASS |
| RD4 Redaction OFF is verbatim | ✅ PASS |
| RD5b Config round-trip: PUT response, GET, config.json agree | ✅ PASS |
| RD6 Names come from config, not hard-coded | ✅ PASS |
| RW1 Request body rewrite reaches upstream + logged | ✅ PASS |
| RW2 Bounded response rewrite reaches client + Content-Length | ✅ PASS |
| RW3 gzip response re-encoded to original Content-Encoding | ✅ PASS |
| RW4 SSE passes through untouched (never buffered) | ✅ PASS |
| RW5 Non-SSE stream (no Content-Length) passes through untouched | ✅ PASS |
| RW6 Body predicate no-match -> original (no rewrite) | ✅ PASS |
| RW7 Over-cap bounded response not rewritten (stream-through) | ✅ PASS |
| RW8 Non-decodable response -> fail-open (original bytes, gateway alive) | ✅ PASS |
| SHOW1 hello -> echo tool_use injected into response | ✅ PASS |
| SHOW2 time -> {{now}} live timestamp in forwarded request | ✅ PASS |
| TS1 Streaming: TTFT distinct from duration, usage merged, rate over decode window | ✅ PASS |
| TS2 Bounded JSON: usage parsed, rate over full duration | ✅ PASS |
| TS3 No usage reported -> TTFT measured, token fields null | ✅ PASS |
| TS4 Log summary API carries stats | ✅ PASS |

**PASS: 38 / FAIL: 0 / NOTE: 0 / Total: 38**

---

## Detail

### C1 — Pass-through identity
**✅ PASS**

status=200 body={"ok":true,"echo":{"x":1}} content-type=application/json

---

### C2a — SSE streaming low-latency + capture
**✅ PASS**

firstByteMs=102 events=true jsonl.streaming=true bodyExcerpt="data: {\"i\":0}\n\ndata: {\"i\":1}\n\ndata: {\"i\":2}\n\ndata: [DONE]\n\n"

---

### C2b — Gemini-stream low-latency + capture
**✅ PASS**

firstByteMs=2 bodyOk=true jsonl.streaming=true

---

### C3 — Header handling
**✅ PASS**

authorization=kept host=localhost:9090 client-Connection-not-echoed=true (undici transport="keep-alive" is expected/out-of-scope)

---

### C4 — JSONL integrity
**✅ PASS**

10 new lines written, all valid ExchangeRecord shape. Sample id=01M2QVJ7ZMZHQ3AY1VTTHKGHHD

---

### C5 — Runtime config no-restart
**✅ PASS**

PID=42460 unchanged, request hit :9091, config.json baseUrl="http://localhost:9091"

---

### C6 — Hook seam end-to-end
**✅ PASS**

x-gateway-test=1 forwarded to upstream (request hook); JSONL meta.audited=true (response hook). Hook module: server/src/hooks/example-audit.ts, imported at startup via index.ts side-effect import. upstreamHeaders['x-gateway-test']="1" record.meta={"audited":true}

---

### C7 — Single-artifact build+start
**✅ PASS**

build exit 0, server running on :8080, /__gateway/app/ status=200, /__gateway/api/config status=200 body={"baseUrl":"http://localhost:9090","timeoutMs":30000,"bodyTimeoutMs":120000,"cap

---

### A1 — 50-concurrent no torn lines
**✅ PASS**

50 requests returned 200, 50 JSONL lines, 0 parse errors

---

### A2a — Client abort /slow
**✅ PASS**

firstChunk received, JSONL error="client_aborted", gateway alive post-abort

---

### A2b — Upstream /reset socket destroy
**✅ PASS**

JSONL record written error="upstream_unreachable", gateway alive. client response: status=502

---

### A4 — Bad gzip bodyDecodable:false
**✅ PASS**

status=200 clientBytes=6 bodyDecodable=false bodyEncoding=base64

---

### AR1 — Timeout reaping: /hang reaped, /sse NOT reaped
**✅ PASS**

/hang: status=0 elapsed=2501ms error="upstream_timeout" reaped=true; /sse: completed=true; gateway alive=true

---

### C3 — Cold start 503
**✅ PASS**

status=503 body={"error":"upstream_not_configured"} jsonl.error="upstream_not_configured" upstreamUrl=null

---

### B1 — Non-UTF8 body→base64, UTF-8 body→utf8
**✅ PASS**

binary body: bodyEncoding="base64"; utf8 body: bodyEncoding="utf8"

---

### RD5 — Schema defaults: redact.enabled=true, requestHeaders includes authorization
**✅ PASS**

GET /config (before any redact PUT) redact={"enabled":true,"requestHeaders":["authorization","proxy-authorization","x-api-key","api-key","x-goog-api-key","x-auth-token","cookie"],"responseHeaders":["set-cookie","authorization"],"queryParams":["key","api_key","apikey","access_token","token"]}

---

### RD1 — Credential header: upstream verbatim, log masked
**✅ PASS**

upstream authorization="Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ" x-api-key="sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ"; log authorization="Bearer sk-ant***WXYZ" x-api-key="sk-ant***WXYZ"; whole-record leak check clean=true

---

### RD1b — Basic credentials masked whole (no decodable tail)
**✅ PASS**

log authorization="Basic ***"; residual tail decodes to ""; leak check clean=true

---

### RD1c — Cookie headers masked per pair (reveal not positional)
**✅ PASS**

log cookie="k=***; other=***"; no leading fragment of the value, names still readable

---

### RD2 — Query credential: forwarded verbatim, masked in query and upstreamUrl
**✅ PASS**

upstream saw key "/json?key=AIzaSyD-abcdefghijklmnopqrstuvwxyz1234567&model=gpt-4"; rec.query="key=AIzaSy***4567&model=gpt-4"; rec.upstreamUrl="http://localhost:9090/json?key=AIzaSy***4567&model=gpt-4" (non-configured "model=gpt-4" survives unmasked — proof redaction is targeted)

---

### RD3 — Response headers masked, client copy untouched
**✅ PASS**

client set-cookie carries real value (writeResponseHead unaffected); log response.headers={"content-type":"application/json","content-length":"11","set-cookie":"session=sess-a***2345; Path=***; HttpOnly","authorization":"Bearer resp-a***2345","date":"Thu, 17 Sep 2026 14:15:58 GMT","connection":"keep-alive","keep-alive":"timeout=5"}

---

### RD4 — Redaction OFF is verbatim
**✅ PASS**

authorization="Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ"; query="key=AIzaSyD-abcdefghijklmnopqrstuvwxyz1234567&model=gpt-4"; upstreamUrl="http://localhost:9090/json?key=AIzaSyD-abcdefghijklmnopqrstuvwxyz1234567&model=gpt-4"

---

### RD5b — Config round-trip: PUT response, GET, config.json agree
**✅ PASS**

redact={"enabled":true,"requestHeaders":["x-custom-key"],"responseHeaders":[],"queryParams":["key"]}

---

### RD6 — Names come from config, not hard-coded
**✅ PASS**

x-custom-key masked="sk-ant***WXYZ"; authorization verbatim="Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ"

---

### RW1 — Request body rewrite reaches upstream + logged
**✅ PASS**

upstream echo={"ok":true,"echo":{"model":"gpt-4o"}}; req.body={"model":"gpt-4o"}; req.originalBody={"model":"gpt-4"}; meta=[{"name":"req-upgrade","target":"request","action":"regexReplace"}]

---

### RW2 — Bounded response rewrite reaches client + Content-Length
**✅ PASS**

client body={"ok":false,"echo":null}; content-length=24 actual=24; log.originalBody={"ok":true,"echo":null}

---

### RW3 — gzip response re-encoded to original Content-Encoding
**✅ PASS**

content-encoding=gzip; content-length=64 actualBytes=64; gunzip(body)={"compressed":true,"data":"HELLO REWRITTEN"}

---

### RW4 — SSE passes through untouched (never buffered)
**✅ PASS**

body intact (has [DONE], no CLOBBERED); streaming=true; meta.rewrites=undefined

---

### RW5 — Non-SSE stream (no Content-Length) passes through untouched
**✅ PASS**

body=[{"a":1},{"b":2},{"c":3}]

---

### RW6 — Body predicate no-match -> original (no rewrite)
**✅ PASS**

client body={"ok":true,"echo":null}; meta.rewrites=undefined

---

### RW7 — Over-cap bounded response not rewritten (stream-through)
**✅ PASS**

cap=5 body={"ok":true,"echo":null}

---

### RW8 — Non-decodable response -> fail-open (original bytes, gateway alive)
**✅ PASS**

clientBytes=7; bodyDecodable=false; meta.rewrites=undefined; alive=true

---

### SHOW1 — hello -> echo tool_use injected into response
**✅ PASS**

control tool_calls=[]; hello tool_calls=[{"type":"function","function":{"name":"echo","arguments":"echo 'hello world'"}}]

---

### SHOW2 — time -> {{now}} live timestamp in forwarded request
**✅ PASS**

control upstream echo={"q":"hello world"}; rewritten upstream echo={"q":"what 2026-09-17 22:16:06 is it"}

---

### TS1 — Streaming: TTFT distinct from duration, usage merged, rate over decode window
**✅ PASS**

stats={"ttftMs":122,"inputTokens":25,"outputTokens":120,"tokensPerSecond":659.3} durationMs=304

---

### TS2 — Bounded JSON: usage parsed, rate over full duration
**✅ PASS**

stats={"ttftMs":82,"inputTokens":11,"outputTokens":7,"tokensPerSecond":85.4} durationMs=82

---

### TS3 — No usage reported -> TTFT measured, token fields null
**✅ PASS**

stats={"ttftMs":102,"inputTokens":null,"outputTokens":null,"tokensPerSecond":null}

---

### TS4 — Log summary API carries stats
**✅ PASS**

summary.stats={"ttftMs":122,"inputTokens":25,"outputTokens":120,"tokensPerSecond":659.3}

