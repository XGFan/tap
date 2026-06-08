# Gateway E2E Verification Report

Generated: 2026-06-08T02:06:47.835Z

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

**PASS: 15 / FAIL: 0 / NOTE: 0 / Total: 15**

---

## Detail

### C1 — Pass-through identity
**✅ PASS**

status=200 body={"ok":true,"echo":{"x":1}} content-type=application/json

---

### C2a — SSE streaming low-latency + capture
**✅ PASS**

firstByteMs=104 events=true jsonl.streaming=true bodyExcerpt="data: {\"i\":0}\n\ndata: {\"i\":1}\n\ndata: {\"i\":2}\n\ndata: [DONE]\n\n"

---

### C2b — Gemini-stream low-latency + capture
**✅ PASS**

firstByteMs=7 bodyOk=true jsonl.streaming=true

---

### C3 — Header handling
**✅ PASS**

authorization=kept host=localhost:9090 client-Connection-not-echoed=true (undici transport="keep-alive" is expected/out-of-scope)

---

### C4 — JSONL integrity
**✅ PASS**

10 new lines written, all valid ExchangeRecord shape. Sample id=01KTJFPS6Z0M04BQ993HWBBSWW

---

### C5 — Runtime config no-restart
**✅ PASS**

PID=87017 unchanged, request hit :9091, config.json baseUrl="http://localhost:9091"

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

/hang: status=0 elapsed=2031ms error="upstream_timeout" reaped=true; /sse: completed=true; gateway alive=true

---

### C3 — Cold start 503
**✅ PASS**

status=503 body={"error":"upstream_not_configured"} jsonl.error="upstream_not_configured" upstreamUrl=null

---

### B1 — Non-UTF8 body→base64, UTF-8 body→utf8
**✅ PASS**

binary body: bodyEncoding="base64"; utf8 body: bodyEncoding="utf8"

