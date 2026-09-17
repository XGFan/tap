# LLM Gateway

A reverse-proxy gateway for LLM APIs. It forwards client traffic to a configured
upstream, captures every request/response exchange for inspection, and can
transform that traffic in flight.

## Language

**Exchange**:
One complete request/response pair passing through the gateway, including the
forwarded request, the upstream response, and the gateway's record of both.
_Avoid_: transaction, call, round-trip

**Upstream**:
The single configured backend the gateway proxies to (its scheme+host).
_Avoid_: origin, target, backend

**Hook**:
A code-level extension point compiled into the server (`registerRequestHook` /
`registerResponseHook`). A developer writes one in TypeScript; it self-registers
at startup. The supported seam for cross-cutting behaviour without editing the
proxy core.
_Avoid_: plugin, middleware, interceptor

**Rewrite Rule**:
A declarative, data-defined rule that **matches** an exchange (by body and/or
other criteria) and, on a match, **rewrites** a body. Distinct from a Hook: a
Rewrite Rule is configuration, not code, and is editable at runtime.
_Avoid_: hook, filter, transform (as a noun)

**Match**:
The predicate side of a Rewrite Rule — the condition that decides whether the
rule applies to a given exchange.
_Avoid_: filter, condition, selector

**Rewrite**:
The action side of a Rewrite Rule — the transformation applied to a body once a
Match succeeds (`regexReplace` or `setBody`). Replacement text is mostly literal
but may contain the `{{now:FORMAT}}` token, expanded to the live server time at
apply time (see [[0002-dynamic-now-token-in-rewrite-replacements]]).
_Avoid_: mutate, patch, edit

**Bounded Response**:
A response the gateway knows the full size of up front (carries a
`Content-Length` and is not `text/event-stream`). The only response class
eligible for rewrite, because rewriting the client-facing bytes requires holding
the whole body.
_Avoid_: complete response, non-streaming response

**Streaming Response**:
Any response without an up-front size — SSE (`text/event-stream`) or an
incremental body sent without `Content-Length`. Always passed through to the
client untouched; not eligible for rewrite.
_Avoid_: chunked response, SSE (SSE is only one kind of Streaming Response)

**Redaction**:
Masking credential-bearing values in the gateway's **record** of an exchange —
configured header names, query params and the query part of `upstreamUrl`. Applied
to a copy at log time: the forwarded request, the client-facing response and the
Hook-visible `ExchangeContext` always carry the original values. Bodies are out of
scope. Distinct from the header *sanitization* in `upstream.ts`, which is forwarding
hygiene (dropping hop-by-hop headers), not log hygiene.
_Avoid_: scrubbing, sanitization, filtering
