---
status: accepted
---

# TTFT and Token Speed from upstream-reported usage

An exchange record now carries a `stats` block: `ttftMs`, `inputTokens`,
`outputTokens`, `tokensPerSecond` (`server/src/stats.ts`). Three decisions in it
are not obvious.

**TTFT is the first response BODY byte, timed from gateway entry.** The same
instant `durationMs` starts from, so the two are comparable and the number is
the TTFT the *client* experienced — gateway overhead, hooks and request rewrite
included — rather than an upstream-only figure the client never sees. The
stream-through path reads it off `TeeTransform.firstChunkAt`, the buffered
rewrite path off `collectStream`; both observe the body before anything is
written downstream. For a Streaming Response that byte carries the first token.
For a Bounded Response the whole body arrives at once, so TTFT is the full
generation time — the honest reading, not a defect.

**Token counts are only ever what the upstream reported.** We parse `usage` /
`usageMetadata` out of the captured body (OpenAI, Anthropic, Gemini; bounded and
streaming) and never estimate — no tokenizer, no character heuristic. A response
that carries no usage report logs nulls, which a viewer shows as "—". A
plausible-looking guess would be indistinguishable from a measurement in the
log, and these numbers exist to be trusted. Anthropic's streaming split
(`message_start` carries input, the final `message_delta` the cumulative output)
and Gemini's per-chunk restatement are both merged last-non-null-wins, because
every dialect that reports more than once reports cumulatively — summing would
multiply-count.

**`tokensPerSecond` divides by a window that differs by response class.**
`durationMs - ttftMs` for a Streaming Response (the prefill preceding the first
token is excluded — the usual output-throughput convention), `durationMs` for a
Bounded one (nothing was observable until generation had finished, so all of it
was generation). One meaning — output tokens over the time spent generating them
— expressed as the best each class allows. Dividing a bounded response by its
transfer time instead would report five-digit rates for a body that arrived in
one chunk.

## Consequences

- Parsing runs at finalize time, after the response is fully forwarded, so it is
  off the client's latency path. It is fail-open: an unparseable, truncated or
  unfamiliar body yields nulls, never an exception into the terminal path.
- Cost is bounded by one substring test over the captured body, then a JSON
  parse of only the `data:` lines that mention usage — a multi-megabyte token
  stream parses a couple of lines.
- `stats` is omitted entirely on the early-error paths (no upstream call, 413,
  connect failure) and on a buffered response whose upstream stream broke.
- Rewritten responses report the **upstream's** counts: a Rewrite Rule may change
  the body the client receives, but the token counts describe what the model
  produced.
- The counts are as truthful as the upstream is. A vendor that omits usage
  unless asked (OpenAI streaming needs `stream_options.include_usage`) yields
  nulls, and that is a property of the traffic, not a gateway bug.
