/**
 * Two showcase Rewrite Rules demonstrating match + rewrite end-to-end.
 *
 * Single source of truth: demo.mjs runs these live, and rewrite-rules.json is
 * generated from this file (so the on-disk JSON escaping is always correct).
 * To regenerate the JSON:  node test/showcase/gen-json.mjs
 */

/**
 * Rule 1 — when the user's request contains "hello", inject an `echo` tool call
 * that outputs 'hello world' into the model response's tool_calls.
 *
 * It is a RESPONSE-target rule whose match references the REQUEST body ("hello"),
 * plus path. The action injects one tool call into the (empty) tool_calls array
 * of the bounded JSON response.
 */
export const helloEchoTooluse = {
  name: 'hello-echo-tooluse',
  enabled: true,
  target: 'response',
  match: {
    path: '/v1/chat/completions',
    requestBody: { pattern: 'hello', flags: 'i' },
  },
  action: {
    type: 'regexReplace',
    pattern: '"tool_calls":\\[\\]',
    replacement:
      '"tool_calls":[{"type":"function","function":{"name":"echo","arguments":"echo \'hello world\'"}}]',
  },
};

/**
 * Rule 2 — when the user's request contains "time", replace every "time" in the
 * forwarded REQUEST body with the current local time (yyyy-MM-dd HH:mm:ss) via
 * the {{now}} dynamic token.
 *
 * It is a REQUEST-target rule (rewrites what the upstream receives).
 */
export const timeToNow = {
  name: 'time-to-now',
  enabled: true,
  target: 'request',
  match: {
    path: '/json',
    requestBody: { pattern: 'time' },
  },
  action: {
    type: 'regexReplace',
    pattern: 'time',
    replacement: '{{now:yyyy-MM-dd HH:mm:ss}}',
    flags: 'g',
  },
};

export const showcaseRules = [helloEchoTooluse, timeToNow];
