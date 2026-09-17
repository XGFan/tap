import type { ExchangeRecord, RedactConfig } from './types.js';

/**
 * Log-time credential masking.
 *
 * Applied to a COPY of the ExchangeRecord at the single logExchange call site
 * (finalizeRecord in proxy.ts) — never to the forwarding path and never to the
 * hook-visible ExchangeContext: record.request.headers IS ctx.requestHeaders,
 * the object sanitizeRequestHeaders builds the outbound headers from, so
 * mutating it here would redact what the upstream receives -> 401. Every helper
 * below returns a NEW object. See docs/adr/0003.
 *
 * Bodies and record.meta are out of scope and pass through verbatim.
 */

const MASK = '***';
const KEEP_LEAD = 6; // enough for "sk-ant", "sk-pro", "AIzaSy"
const KEEP_TAIL = 4; // enough to tell two live opaque keys apart / spot rotation
const MIN_HIDDEN = 10; // never reveal unless at least this many chars stay hidden
const MIN_REVEALABLE = KEEP_LEAD + KEEP_TAIL + MIN_HIDDEN; // = 20

/**
 * Splits "Bearer <token>" into scheme + gap + secret. The {0,11} cap is a
 * SECURITY bound, not cosmetic: an unbounded group lets a credential that is
 * itself alnum+hyphen and followed by whitespace pose as the scheme and get
 * kept verbatim (e.g. "sk-ant-abc123def456 v2"). The cap clears the schemes
 * this gateway actually sees (Bearer, Basic, Token, Negotiate at 9) while
 * excluding anything longer than 12 chars. Longer schemes DO exist — AWS SigV4's
 * "AWS4-HMAC-SHA256" (16) and "SCRAM-SHA-256" (13) — and they fall through to
 * whole-value masking. That is over-masking, the safe direction; do NOT widen
 * the cap to accommodate them, it reopens the leak above. The gap is captured
 * so "Bearer\t\tsk-..." is not rewritten with a single space.
 */
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9-]{0,11})([ \t]+)(\S.*)$/;

/**
 * Auth schemes whose credential is ENCODED CLEARTEXT rather than an opaque
 * token. Base64 packs 3 bytes into 4 chars, so revealing the last 4 characters
 * of a Basic credential decodes cleanly on its own to the last 3 bytes of the
 * password: "Basic YWRtaW***S2Nk" gives up "Kcd" of "Tr0ub4dor&3xKcd". The
 * lead/tail reveal exists to tell opaque keys apart and spot rotation — against
 * a human-chosen password it just hands over the plaintext ending, so these are
 * masked whole. Matched case-insensitively on the scheme only; this is about
 * the ENCODING, not about which headers get redacted (that stays config-driven).
 */
const CLEARTEXT_SCHEMES = new Set(['basic']);

/**
 * Headers whose value is a "name=value; name=value" LIST rather than one opaque
 * token. The lead/tail reveal is POSITIONAL, so across a list it starts inside
 * the first pair's name and ends inside the last segment: "k=SECRETVALUE…" gave
 * up "k=SECR***er=1" — four leading characters of a real value — and a cookie
 * with attributes gave "sessio***Only", revealing the name and a constant from
 * "HttpOnly". Masking each value on its own re-anchors the reveal to the value
 * it belongs to and keeps the names readable. Like CLEARTEXT_SCHEMES this is
 * about the value's FORMAT, not about which headers are secret — that stays
 * config-driven.
 */
const STRUCTURED_HEADERS = new Set(['cookie', 'set-cookie']);

/** Mask the secret itself: full mask when too short to reveal anything safely. */
function maskSecret(secret: string): string {
  if (secret.length < MIN_REVEALABLE) return MASK;
  return `${secret.slice(0, KEEP_LEAD)}${MASK}${secret.slice(-KEEP_TAIL)}`;
}

/** Mask one header/param value: keep an auth scheme, a short lead and the last 4. */
export function maskValue(value: string): string {
  if (value === '') return ''; // an empty value carries no secret
  const m = SCHEME_RE.exec(value);
  if (m !== null) {
    const secret = CLEARTEXT_SCHEMES.has(m[1].toLowerCase()) ? MASK : maskSecret(m[3]);
    return `${m[1]}${m[2]}${secret}`;
  }
  return maskSecret(value);
}

/** Mask a "name=value; name=value" list one value at a time, names left intact. */
function maskPairList(value: string): string {
  return value
    .split(';')
    .map((segment) => {
      const eq = segment.indexOf('=');
      if (eq === -1) return segment; // valueless attribute (HttpOnly, Secure)
      return `${segment.slice(0, eq + 1)}${maskSecret(segment.slice(eq + 1))}`;
    })
    .join(';');
}

/** Mask one header value, picking the strategy from the header's format. */
function maskHeaderValue(name: string, value: string): string {
  if (value === '') return '';
  if (STRUCTURED_HEADERS.has(name)) return maskPairList(value);
  return maskValue(value);
}

/**
 * Return a NEW header record with every configured name masked. Never mutates
 * the input — the caller's object is the live forwarding/hook object. Array
 * values are masked element-wise, preserving arity (a multi-set-cookie response
 * still shows how many cookies there were).
 */
export function redactHeaderRecord(
  headers: Record<string, string | string[]>,
  names: readonly string[],
): Record<string, string | string[]> {
  const targets = new Set(names);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (!targets.has(lower)) {
      out[key] = value;
      continue;
    }
    out[key] = Array.isArray(value)
      ? value.map((v) => maskHeaderValue(lower, v))
      : maskHeaderValue(lower, value);
  }
  return out;
}

/** Escape a literal param name for embedding in a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mask configured params inside a raw query string (no leading "?"). Regex, not
 * URLSearchParams: the latter re-encodes and re-orders every param on
 * serialization, which would corrupt the record for params we must not touch.
 * Values are masked AS ENCODED — a masked query is a display string, not a URL
 * you can replay.
 */
export function redactQueryString(query: string, names: readonly string[]): string {
  if (query === '' || names.length === 0) return query;
  let out = query;
  for (const name of names) {
    // The (^|&) anchor is what keeps a "key" rule off "apikey="/"api_key=".
    const re = new RegExp(`(^|&)(${escapeRe(name)})=([^&]*)`, 'gi');
    out = out.replace(
      re,
      (_m, pre: string, key: string, val: string) => `${pre}${key}=${maskValue(val)}`,
    );
  }
  return out;
}

/**
 * Mask configured params inside a full URL's query part. Takes the record's
 * known `query` and matches it as an exact SUFFIX rather than splitting on the
 * first "?": baseUrl's refine only constrains pathname, so "http://host?x=1" is
 * accepted and buildUpstreamUrl then yields "http://host?x=1/json?key=SECRET",
 * where a first-"?" split would leave the real credential unmasked.
 *
 * When the client sent NO query, any "?" in the URL came from baseUrl itself
 * (e.g. an operator setting baseUrl to ".../v1beta?key=SECRET"), so there is no
 * client query to confuse it with and splitting at the first "?" is then both
 * safe and necessary — without it that credential is logged verbatim on every
 * request.
 */
export function redactUrl(
  url: string | null,
  query: string,
  names: readonly string[],
): string | null {
  if (url === null) return null;
  if (query !== '' && url.endsWith(query)) {
    return url.slice(0, url.length - query.length) + redactQueryString(query, names);
  }
  // No client query, or the shapes disagree (only reachable if a hook rewrote
  // ctx.upstreamUrl). Fall back to the first "?" rather than returning the URL
  // untouched — masking the wrong span beats logging a credential raw.
  const i = url.indexOf('?');
  if (i === -1) return url;
  return url.slice(0, i + 1) + redactQueryString(url.slice(i + 1), names);
}

/**
 * The single entry point the proxy calls: a redacted COPY of the record, or the
 * same reference when redaction is off.
 */
export function redactForLog(record: ExchangeRecord, cfg: RedactConfig): ExchangeRecord {
  // Inside the try, and deliberately NOT optional-chained: on a malformed cfg the
  // property access throws into the fail-closed branch below, instead of either
  // returning the record unredacted or escaping finalizeRecord into an
  // already-hijacked reply. `enabled: false` is the only way to get the record back.
  try {
    if (!cfg.enabled) return record; // AC4: byte-identical, same reference
    return {
      ...record,
      query: redactQueryString(record.query, cfg.queryParams),
      upstreamUrl: redactUrl(record.upstreamUrl, record.query, cfg.queryParams),
      request: {
        ...record.request,
        headers: redactHeaderRecord(record.request.headers, cfg.requestHeaders),
      },
      response: {
        ...record.response,
        headers: redactHeaderRecord(record.response.headers, cfg.responseHeaders),
      },
    };
  } catch {
    // Unreachable by construction (pure string ops, escaped regexes). If it ever
    // fires, fail CLOSED: drop the headers rather than log them raw.
    return {
      ...record,
      query: record.query === '' ? '' : MASK,
      upstreamUrl: record.upstreamUrl === null ? null : MASK,
      request: { ...record.request, headers: {} },
      response: { ...record.response, headers: {} },
    };
  }
}
