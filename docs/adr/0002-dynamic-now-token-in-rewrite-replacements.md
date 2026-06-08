---
status: accepted
---

# Dynamic `{{now}}` token in Rewrite Rule replacements

The Rewrite engine originally used purely **static** replacement strings —
`regexReplace.replacement` and `setBody.value` are config literals (decided in
the design grilling: no templating in v1). To support rules like "replace 'time'
with the current timestamp", we added a `{{now}}` / `{{now:FORMAT}}` token that
`expandNowTokens()` substitutes with the live **server-local** time at apply
time. `FORMAT` supports `yyyy MM dd HH mm ss SSS`; bare `{{now}}` defaults to
`yyyy-MM-dd HH:mm:ss`.

This is a deliberate departure from the static-replacement decision: a
replacement is now allowed to be non-deterministic (it reads the clock). We
accept it because it is the smallest change that makes time-injection rules
possible, and it stays declarative (no code hooks).

## Consequences

- Backward compatible: any replacement string **without** the literal `{{now`
  is returned untouched, so existing static rules are unaffected.
- Tokens are expanded **before** `String.prototype.replace` runs; the produced
  timestamp contains no `$`, so `$1` backref handling is undisturbed.
- `rewrite.ts` is no longer side-effect-free (it reads `new Date()`); this is the
  module's only impurity and is confined to `formatNow`.
- Time is **server-local**, not UTC. A rule author wanting UTC must adjust the
  upstream/host timezone or extend the token (out of scope here).
