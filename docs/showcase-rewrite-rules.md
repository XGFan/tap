# Showcase: Rewrite Rules

Two example [Rewrite Rules](../CONTEXT.md) demonstrating match + rewrite
end-to-end. Definitions live in `test/showcase/rules.mjs` (single source of
truth); `test/showcase/rewrite-rules.json` is generated from it.

## Run the live demo

```sh
pnpm build
node test/showcase/demo.mjs
```

It starts the mock upstream + gateway, installs both rules via the config API,
then prints BEFORE (no match) vs AFTER (match) for each rule. The same behaviour
is asserted in the E2E suite as `SHOW1` / `SHOW2` (`node test/verify/run.mjs`).

## Rule 1 — `hello` → inject an `echo` tool call

When the user's **request** contains `hello`, inject an `echo` tool call that
outputs `hello world` into the model **response**'s `tool_calls`.

- **target**: `response` (rewrites the client-facing body)
- **match**: `path: /v1/chat/completions` AND request body matches `hello` (a
  response rule may reference request-side fields)
- **action**: `regexReplace` the empty `"tool_calls":[]` with a one-element array
  containing the echo call

```text
request  : {"messages":[{"role":"user","content":"hello, help me"}]}
response : ...,"tool_calls":[]                          (upstream)
        -> ...,"tool_calls":[{"type":"function","function":{"name":"echo","arguments":"echo 'hello world'"}}]
```

Only fires for **Bounded Responses** (the mock returns `Content-Length`); a
streaming/SSE tool-call response would pass through untouched (see
[ADR-0001](./adr/0001-buffer-bounded-responses-for-rewrite.md)).

## Rule 2 — `time` → current timestamp

When the user's **request** contains `time`, replace every `time` in the
forwarded **request** body with the current local time `yyyy-MM-dd HH:mm:ss`.

- **target**: `request` (rewrites what the upstream receives)
- **match**: `path: /json` AND request body matches `time`
- **action**: `regexReplace` `time` → `{{now:yyyy-MM-dd HH:mm:ss}}` (global)

```text
request in  : {"q":"what time is it"}
forwarded   : {"q":"what 2026-06-08 12:04:00 is it"}
```

The `{{now:FORMAT}}` token is expanded to the live server time at apply time —
see [ADR-0002](./adr/0002-dynamic-now-token-in-rewrite-replacements.md). Tokens:
`yyyy MM dd HH mm ss SSS`; bare `{{now}}` defaults to `yyyy-MM-dd HH:mm:ss`.

## Load the rules into a running gateway

```sh
curl -X PUT http://localhost:8080/__gateway/api/config \
  -H 'Content-Type: application/json' \
  -d "{\"rewriteRules\": $(cat test/showcase/rewrite-rules.json)}"
```

Then open the SPA at `http://localhost:8080/__gateway/app/`; a rewritten exchange
shows a **rewritten** badge and an original/rewritten toggle in the log detail.
