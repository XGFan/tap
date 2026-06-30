# Gateway E2E Verification Report

Generated: 2026-06-30T09:38:11.524Z

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

**PASS: 25 / FAIL: 0 / NOTE: 0 / Total: 25**

---

## Detail

### C1 — Pass-through identity
**✅ PASS**

status=200 body={"ok":true,"echo":{"x":1}} content-type=application/json

---

### C2a — SSE streaming low-latency + capture
**✅ PASS**

firstByteMs=103 events=true jsonl.streaming=true bodyExcerpt="data: {\"i\":0}\n\ndata: {\"i\":1}\n\ndata: {\"i\":2}\n\ndata: [DONE]\n\n"

---

### C2b — Gemini-stream low-latency + capture
**✅ PASS**

firstByteMs=6 bodyOk=true jsonl.streaming=true

---

### C3 — Header handling
**✅ PASS**

authorization=kept host=localhost:9090 client-Connection-not-echoed=true (undici transport="keep-alive" is expected/out-of-scope)

---

### C4 — JSONL integrity
**✅ PASS**

10 new lines written, all valid ExchangeRecord shape. Sample id=01KWBY90ATCCGFD16HB8NNBJBB

---

### C5 — Runtime config no-restart
**✅ PASS**

PID=14171 unchanged, request hit :9091, config.json baseUrl="http://localhost:9091"

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

/hang: status=0 elapsed=2502ms error="upstream_timeout" reaped=true; /sse: completed=true; gateway alive=true

---

### C3 — Cold start 503
**✅ PASS**

status=503 body={"error":"upstream_not_configured"} jsonl.error="upstream_not_configured" upstreamUrl=null

---

### B1 — Non-UTF8 body→base64, UTF-8 body→utf8
**✅ PASS**

binary body: bodyEncoding="base64"; utf8 body: bodyEncoding="utf8"

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

control upstream echo={"q":"hello world"}; rewritten upstream echo={"q":"what 2026-06-30 17:38:11 is it"}

