---
status: accepted
---

# Buffer bounded responses (only) to enable response Rewrite Rules

To let a Rewrite Rule change the bytes a client actually receives, the gateway
must hold the whole response body before sending it — which contradicts the
core proxy invariant of "always-stream-through, ONE forwarding path" recorded in
AGENTS.md. We accept a narrow exception: when a response Rewrite Rule's
non-body criteria match and the response is a **Bounded Response** (carries
`Content-Length`, not `text/event-stream`), the proxy buffers that one response,
rewrites it, re-encodes it to the original `Content-Encoding`, recomputes
`Content-Length`, and then sends it. Every other response — all Streaming
Responses (SSE and any body without `Content-Length`) and any response no rule
targets — keeps the existing zero-latency stream-through path untouched.

## Considered options

- **Buffer every response.** Rejected: kills SSE/token-stream latency, the
  gateway's main use case.
- **Rewrite the logged copy only, never the client bytes.** Rejected: does not
  satisfy the requirement that rewrites reach the client.
- **Buffer bounded responses only; pass all streaming responses through.**
  Chosen: preserves streaming behaviour everywhere it matters; rewriting is
  available exactly where the body size is known up front.

## Consequences

- A response targeted by a rule but **not decodable** (unknown/multi-layer
  `Content-Encoding`, corrupt bytes) cannot be text-rewritten or re-encoded, so
  it **fails open** — original bytes are forwarded unchanged.
- A Bounded Response whose `Content-Length` exceeds `captureBodyLimitBytes` is
  **not** buffered; it streams through unchanged (rewrite skipped).
- Rewriting **streaming** responses (SSE, Gemini-style incremental JSON) is out
  of scope and intentionally not supported in v1.
- The proxy now has two response dispositions (stream-through vs buffer-rewrite)
  decided at response-header time. The buffering branch must converge back onto
  the same logging/finalize path so observability stays uniform.
