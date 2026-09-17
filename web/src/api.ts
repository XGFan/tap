// Typed fetch wrappers for the LLM Gateway API.
// All endpoints are same-origin in prod under /__gateway/api.

export interface RedactConfig {
  enabled: boolean
  requestHeaders: string[]
  responseHeaders: string[]
  queryParams: string[]
}

export interface GatewayConfig {
  baseUrl: string
  timeoutMs: number
  bodyTimeoutMs: number
  captureBodyLimitBytes: number
  captureRequestBodyLimitBytes: number
  redact: RedactConfig
}

/** TTFT + token throughput for one exchange (mirrors server ExchangeStats). */
export interface ExchangeStats {
  /** ms from exchange start to the first response body byte. */
  ttftMs: number | null
  /** Prompt tokens as reported by the upstream (null when it reported none). */
  inputTokens: number | null
  /** Generated tokens as reported by the upstream. */
  outputTokens: number | null
  /** Output tokens over the observed generation window. */
  tokensPerSecond: number | null
}

export interface LogSummary {
  id: string
  timestamp: string
  method: string
  path: string
  status: number | null
  durationMs: number | null
  streaming: boolean
  error: string | null
  /** Absent when the exchange never reached the upstream. */
  stats?: ExchangeStats
}

/** One Rewrite Rule that fired during an exchange (mirrors server RewriteAnnotation). */
export interface RewriteAnnotation {
  name: string
  target: 'request' | 'response'
  action: 'regexReplace' | 'setBody'
}

export interface LogRecord {
  id: string
  timestamp: string
  method: string
  path: string
  query: string
  upstreamUrl: string
  request: {
    headers: Record<string, string>
    body: string | null
    bodyEncoding: string
    bodyTruncated: boolean
    /** Pre-rewrite body, present only when a request Rewrite Rule changed it. */
    originalBody?: string | null
    originalBodyEncoding?: string
  }
  response: {
    status: number
    headers: Record<string, string>
    body: string | null
    bodyEncoding: string
    bodyDecodable: boolean
    bodyTruncated: boolean
    /** Pre-rewrite body, present only when a response Rewrite Rule changed it. */
    originalBody?: string | null
    originalBodyEncoding?: string
  } | null
  streaming: boolean
  durationMs: number | null
  requestBytes: number | null
  responseBytes: number | null
  error: string | null
  /** Absent when the exchange never reached the upstream. */
  stats?: ExchangeStats
  /** Hook/rule annotations. meta.rewrites lists the Rewrite Rules that fired. */
  meta?: { rewrites?: RewriteAnnotation[] } & Record<string, unknown>
}

const BASE = '/__gateway/api'

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status} ${text}`)
  }
  return res.json() as Promise<T>
}

export function getConfig(): Promise<GatewayConfig> {
  return apiFetch<GatewayConfig>('/config')
}

export function putConfig(patch: Partial<GatewayConfig>): Promise<GatewayConfig> {
  return apiFetch<GatewayConfig>('/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export interface LogsQuery {
  limit?: number
  before?: string
}

/** Backend response shape for GET /logs (cursor-paginated, newest-first). */
interface LogsPage {
  items: LogSummary[]
  nextBefore: string | null
}

export async function getLogs(query: LogsQuery = {}): Promise<LogSummary[]> {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.before) params.set('before', query.before)
  const qs = params.toString()
  const page = await apiFetch<LogsPage>(`/logs${qs ? `?${qs}` : ''}`)
  // The API wraps results as { items, nextBefore }; callers consume the array.
  return page.items
}

export function getLog(id: string): Promise<LogRecord> {
  return apiFetch<LogRecord>(`/logs/${id}`)
}

export async function clearLogs(): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/logs`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status} ${text}`)
  }
  return res.json() as Promise<{ deleted: number }>
}

/** Opens an EventSource for the live log stream. Each message is a LogSummary JSON. */
export function openLogStream(): EventSource {
  return new EventSource(`${BASE}/logs/stream`)
}
