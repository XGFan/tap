import type { RewriteRule, RewriteAnnotation } from './types.js';

/**
 * Rewrite Rule engine. No proxy/stream coupling — it takes already decoded body
 * text plus exchange metadata and returns the rewritten text. The proxy owns
 * buffering, decode/encode, and logging; this module owns only matching and the
 * ordered-pipeline rewrite. The sole side effect is reading the clock to expand
 * the {{now}} replacement token (see expandNowTokens).
 *
 * Failure isolation is total: any rule whose match or action throws is skipped
 * (fail-open), so a malformed rule can never break the proxy path.
 */

/** Static (non-pipeline-body) facts about an exchange used by Match predicates. */
export interface MatchContext {
  method: string;
  /** Path only, no query string. */
  path: string;
  /** Response status — present in the response phase, undefined for requests. */
  status?: number;
  /** Content-Type of the body under rewrite (request CT for request-target
   * rules, response CT for response-target rules). */
  contentType?: string;
  /** Decoded request body text, for a response rule's `requestBody` predicate.
   * null/undefined when absent or not UTF-8-decodable. */
  requestBodyText?: string | null;
}

export interface RewriteOutcome {
  /** The final body text after all firing rules. */
  text: string;
  /** The rules that actually changed the body, in firing order. */
  annotations: RewriteAnnotation[];
}

/** Convert a simple path glob (`*` within a segment, `**` across, `?` one char)
 * to an anchored full-match RegExp. Literal characters are regex-escaped. */
function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

/** Test a body regex against text. The `g` flag is irrelevant for a presence
 * test and is stripped to avoid any lastIndex surprises. Never throws. */
function testBodyRegex(bm: { pattern: string; flags?: string }, text: string): boolean {
  try {
    const flags = (bm.flags ?? '').replace(/g/g, '');
    return new RegExp(bm.pattern, flags).test(text);
  } catch {
    return false;
  }
}

/**
 * Evaluate the predicates that do NOT depend on the body being rewritten:
 * method, path, status (response only), contentType, and — for response-target
 * rules — the request-body predicate (which is static at response time). The
 * pipeline-body predicate (requestBody for request rules, responseBody for
 * response rules) is checked separately against the CURRENT body.
 */
function staticMatch(rule: RewriteRule, ctx: MatchContext): boolean {
  const m = rule.match;
  if (m.method && m.method.length > 0) {
    const want = m.method.map((x) => x.toUpperCase());
    if (!want.includes(ctx.method.toUpperCase())) return false;
  }
  if (m.path && !globToRegExp(m.path).test(ctx.path)) return false;
  if (rule.target === 'response' && m.status && m.status.length > 0) {
    if (ctx.status === undefined || !m.status.includes(ctx.status)) return false;
  }
  if (m.contentType) {
    if (!(ctx.contentType ?? '').toLowerCase().includes(m.contentType.toLowerCase())) {
      return false;
    }
  }
  // For a response rule, requestBody is a static predicate against the request.
  if (rule.target === 'response' && m.requestBody) {
    if (ctx.requestBodyText == null) return false;
    if (!testBodyRegex(m.requestBody, ctx.requestBodyText)) return false;
  }
  return true;
}

/** Format the current local time against a token pattern (yyyy MM dd HH mm ss
 * SSS). The one clock read in this module — kept here so action replacements can
 * inject a live timestamp via the {{now}} token. */
function formatNow(fmt: string): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    dd: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    SSS: pad(d.getMilliseconds(), 3),
  };
  return fmt.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (t) => map[t] ?? t);
}

/** Expand {{now}} / {{now:FORMAT}} tokens in an action replacement to the live
 * server-local time. Bare {{now}} defaults to "yyyy-MM-dd HH:mm:ss". Strings
 * without the token are returned untouched (literal replacements still work). */
function expandNowTokens(s: string): string {
  if (!s.includes('{{now')) return s;
  return s.replace(/\{\{now(?::([^}]*))?\}\}/g, (_m, fmt: string | undefined) =>
    formatNow(fmt && fmt.length > 0 ? fmt : 'yyyy-MM-dd HH:mm:ss'),
  );
}

/** Apply a single action to text. regexReplace honours $-backrefs and the g
 * flag; setBody replaces the whole body. Both expand {{now}} tokens first, so a
 * timestamp injected this way carries no `$` and never disturbs backref handling. */
function applyAction(action: RewriteRule['action'], text: string): string {
  if (action.type === 'setBody') return expandNowTokens(action.value);
  const re = new RegExp(action.pattern, action.flags);
  return text.replace(re, expandNowTokens(action.replacement));
}

/**
 * Does ANY enabled rule of `target` pass its static predicates for this
 * exchange? Used by the proxy as the response-buffering gate at response-header
 * time, BEFORE the body is available (responseBody predicates are deliberately
 * not consulted here — a response rule with only a body predicate gates true,
 * forcing a buffer of that non-streaming response).
 */
export function gateMatches(
  target: 'request' | 'response',
  rules: RewriteRule[],
  ctx: MatchContext,
): boolean {
  for (const rule of rules) {
    if (!rule.enabled || rule.target !== target) continue;
    try {
      if (staticMatch(rule, ctx)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Apply all enabled `target` rules to `bodyText` as an ordered pipeline: each
 * rule that matches rewrites the text the next rule sees. Returns the final text
 * plus the rules that actually changed it, or null when nothing changed (so the
 * caller can forward the original untouched). Fully fail-open.
 */
export function applyRewrites(
  target: 'request' | 'response',
  rules: RewriteRule[],
  bodyText: string,
  ctx: MatchContext,
): RewriteOutcome | null {
  let text = bodyText;
  let changed = false;
  const annotations: RewriteAnnotation[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.target !== target) continue;
    try {
      if (!staticMatch(rule, ctx)) continue;
      // Pipeline-body predicate runs against the CURRENT (post-prior-rule) text.
      const bodyPred = target === 'request' ? rule.match.requestBody : rule.match.responseBody;
      if (bodyPred && !testBodyRegex(bodyPred, text)) continue;

      const next = applyAction(rule.action, text);
      if (next !== text) {
        text = next;
        changed = true;
        annotations.push({ name: rule.name, target: rule.target, action: rule.action.type });
      }
    } catch {
      // fail-open: a throwing rule simply does not fire.
      continue;
    }
    // `stop` short-circuits the pipeline once a rule has MATCHED (reached here).
    if (rule.stop) break;
  }

  return changed ? { text, annotations } : null;
}
