---
status: accepted
---

# Redact at the log-record build, not in a hook

AGENTS.md and CONTEXT.md both name the Hook as "the supported seam for
cross-cutting behaviour without editing the proxy core", and `hooks.ts` shipped a
`redactHeaders` request hook as the advertised redaction point — a no-op left for
someone to fill in. Filling it in as written would have been wrong: a request hook
runs before forwarding and can mutate `ctx.requestHeaders`, but that is the same
object the proxy reads to build the outbound request. Redacting it there does not
give the log a masked copy — it gives the upstream a masked `Authorization` header,
which fails auth (401). This change edits the proxy core directly (`proxy.ts`,
`redact.ts`) and deletes `redactHeaders`.

## Considered options

- **Redact in a request hook.** Rejected: mutates the forwarding source. Any hook
  touching `ctx.requestHeaders` changes what actually reaches the upstream — the
  seam that is supposed to be side-effect-free for logging purposes cannot also be
  the redaction point.
- **Redact at each `ExchangeRecord` build site.** Rejected: four divergent call
  sites is a leak waiting for the next feature — a fifth site added later that
  forgets to call the masker logs credentials in plaintext with nothing to catch it.
- **Redact a copy at the single `logExchange` funnel.** Chosen: `logExchange` has
  exactly one call site (`finalizeRecord` in `proxy.ts`), so this is the one place
  every record passes through regardless of how it was built. `redactForLog`
  returns a new `ExchangeRecord`; the original is untouched and keeps flowing to
  the client and into `ctx`.

## Consequences

- `ctx` stays truthful — hooks continue to see real, unredacted values.
- A new `ExchangeRecord`-producing code path is covered for free; there is nothing
  to remember to call.
- `record.meta` is a known **unredacted** hole: a hook that copies a header value
  into `ctx.meta` leaks it into the log verbatim. Redaction does not inspect `meta`.
- Request and response **bodies** are not redacted — a credential in a body is
  still logged in plaintext.
- A credential embedded in the request **path** (not headers or query) is not
  covered.
- A masked `upstreamUrl` is a display string only, not a URL you can replay.
- `PUT /config` replaces the `redact` node wholesale, like `rewriteRules` — a
  partial PUT omitting a name list resets that list to its schema default rather
  than merging.
- The scheme/secret split in `maskValue` caps the scheme group at 12 characters
  (`{0,11}` after the leading letter). This is a security bound, not a style
  choice: an uncapped group lets a credential that happens to be alnum-plus-hyphen
  and is followed by whitespace (e.g. `sk-ant-abc123def456 v2`) get parsed as its
  own "scheme" and kept verbatim instead of masked. Widening the cap reopens that
  leak. Schemes longer than the cap exist — AWS SigV4's `AWS4-HMAC-SHA256` (16),
  `SCRAM-SHA-256` (13) — and fall through to whole-value masking, losing the
  scheme from the log line. That is over-masking, the safe direction, and is not
  a reason to widen the cap.
- The lead/tail reveal assumes an **opaque token**. Two value formats break that
  assumption and are handled by format, not by field name (which stays
  config-driven): `Basic` credentials are masked whole, because base64's
  4-char/3-byte alignment makes the revealed tail decode to the last bytes of the
  cleartext password; and `cookie`/`set-cookie` are masked per `name=value` pair,
  because a positional reveal across a list starts inside the first name and ends
  inside the last segment, exposing leading characters of a real value. Both are
  about how a value is encoded, not about which fields are secret.
- Error-path records (`finalizeEarly` in `proxy.ts`, the 503/413/502/504 cases)
  hardcode `response.headers` to `{ 'content-type': 'application/json' }`, so no
  configured response-header name can ever appear on those records — redaction
  runs over them harmlessly. "Response headers are redacted" does not mean the
  error paths carry real response headers to redact in the first place.
- `redactForLog`'s catch branch (fail-closed: drop headers rather than log them
  raw) is unreachable by construction — every operation in the `try` is a pure
  string op over an escaped-literal regex, which cannot throw. It is kept as a
  backstop, not because it is exercised; no test covers it.
