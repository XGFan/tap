import type {
  ExchangeContext,
  ExchangeRecord,
  RequestHook,
  ResponseHook,
} from './types.js';

/**
 * The hook seam — the supported extension point for cross-cutting behavior
 * (auditing, request/response rewriting) WITHOUT editing proxy.ts.
 *
 * Redaction is NOT a hook. A request hook mutating ctx.requestHeaders changes
 * what the upstream receives (proxy.ts sanitizeRequestHeaders reads that same
 * object), so redacting there breaks auth. Log redaction happens in redact.ts,
 * applied to a copy at log time — see docs/adr/0003. Hooks see unredacted
 * values; anything a hook writes into ctx.meta is logged verbatim.
 *
 * The proxy core calls runRequestHooks(ctx) before forwarding upstream and
 * runResponseHooks(ctx, record) in the pipeline callback right before the
 * record is persisted. Hooks run sequentially in registration order and are
 * awaited, so an async hook (e.g. an audit write) completes before the next.
 *
 * How to plug in a future hook (no proxy.ts changes needed):
 *
 *   // audit-hook.ts
 *   import { registerResponseHook } from './hooks.js';
 *   registerResponseHook(async (ctx, record) => {
 *     if (record.error) await auditStore.write({ id: ctx.id, error: record.error });
 *   });
 *
 *   // rewrite-hook.ts — mutate the OUTBOUND context before forwarding
 *   import { registerRequestHook } from './hooks.js';
 *   registerRequestHook((ctx) => {
 *     ctx.requestHeaders['x-trace-id'] = ctx.id; // forwarded upstream
 *   });
 *
 * Then import that module once at startup (e.g. from index.ts) so its
 * top-level registerXHook() call runs. The proxy is unaware of any specific
 * hook; it only invokes the runners.
 */

const requestHooks: RequestHook[] = [];
const responseHooks: ResponseHook[] = [];

/** Register a request-phase hook (runs before the upstream call). */
export function registerRequestHook(hook: RequestHook): void {
  requestHooks.push(hook);
}

/** Register a response-phase hook (runs after the response, before logging). */
export function registerResponseHook(hook: ResponseHook): void {
  responseHooks.push(hook);
}

/** Run all request hooks sequentially, awaiting each. */
export async function runRequestHooks(ctx: ExchangeContext): Promise<void> {
  for (const hook of requestHooks) {
    await hook(ctx);
  }
}

/** Run all response hooks sequentially, awaiting each. */
export async function runResponseHooks(
  ctx: ExchangeContext,
  record: ExchangeRecord,
): Promise<void> {
  for (const hook of responseHooks) {
    await hook(ctx, record);
  }
}
