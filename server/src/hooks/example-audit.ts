import { registerRequestHook, registerResponseHook } from '../hooks.js';

/**
 * EXAMPLE HOOK MODULE — safe to delete.
 *
 * Demonstrates the audit/rewrite extension point (user requirement #6) WITHOUT
 * touching proxy.ts. Importing this module once at startup self-registers two
 * hooks:
 *   - a request hook that REWRITES the outbound headers (adds X-Gateway-Test:1,
 *     which is then forwarded upstream), and
 *   - a response hook that ANNOTATES the exchange (ctx.meta.audited = true),
 *     which the proxy persists into the logged ExchangeRecord.meta.
 *
 * Enabled by default so the e2e suite can observe it end-to-end. To disable,
 * set GATEWAY_EXAMPLE_HOOKS=0 (or "false") in the environment. The default
 * redactHeaders hook in hooks.ts remains a no-op; this is the opt-out demo.
 */

const flag = process.env.GATEWAY_EXAMPLE_HOOKS;
const enabled = flag !== '0' && flag?.toLowerCase() !== 'false';

if (enabled) {
  // Rewrite: add a trace/audit header that is forwarded to the upstream. The
  // proxy derives outbound headers from ctx.requestHeaders AFTER request hooks
  // run, so this mutation reaches the upstream.
  registerRequestHook((ctx) => {
    ctx.requestHeaders['x-gateway-test'] = '1';
  });

  // Annotate: mark the exchange as audited. The proxy copies ctx.meta into the
  // logged ExchangeRecord.meta, so this appears in the JSONL.
  registerResponseHook((ctx) => {
    ctx.meta.audited = true;
  });
}
