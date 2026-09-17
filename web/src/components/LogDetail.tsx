import { useEffect, useState } from 'react'
import JsonView from '@uiw/react-json-view'
import { githubLightTheme } from '@uiw/react-json-view/githubLight'
import { getLog, type ExchangeStats, type LogRecord } from '../api'

interface Props {
  id: string
  onClose: () => void
}

function parseJsonBody(value: string): { parsed: unknown; pretty: string; isJson: boolean } {
  try {
    const parsed = JSON.parse(value)
    return { parsed, pretty: JSON.stringify(parsed, null, 2), isJson: true }
  } catch {
    return { parsed: null, pretty: value, isJson: false }
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button className="copy-btn" onClick={copy}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function HeaderTable({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) {
    return <p style={{ color: '#888', fontSize: 12, margin: 0 }}>No headers</p>
  }
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: '38%' }}>Name</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td style={{ fontFamily: 'monospace', fontSize: 12, color: '#555' }}>{k}</td>
            <td style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function BodyBlock({
  body,
  encoding,
  truncated,
  decodable,
  contentType,
  originalBody,
  originalBodyEncoding,
}: {
  body: string | null
  encoding: string
  truncated: boolean
  decodable?: boolean
  contentType?: string
  originalBody?: string | null
  originalBodyEncoding?: string
}) {
  // Hooks must run before any early return.
  const [view, setView] = useState<'tree' | 'raw'>('tree')
  const [source, setSource] = useState<'rewritten' | 'original'>('rewritten')

  // originalBody is present ONLY when a Rewrite Rule changed this body.
  const wasRewritten = originalBody !== undefined
  const showingOriginal = wasRewritten && source === 'original'
  const activeBody = showingOriginal ? originalBody ?? null : body
  const activeEncoding = showingOriginal ? originalBodyEncoding ?? 'utf8' : encoding

  const sourceToggle = wasRewritten ? (
    <button
      className="copy-btn"
      onClick={() => setSource((s) => (s === 'rewritten' ? 'original' : 'rewritten'))}
    >
      {source === 'rewritten' ? 'Show original' : 'Show rewritten'}
    </button>
  ) : null

  if (activeBody === null) {
    return (
      <div className="body-section">
        <div className="body-section-label">
          Body
          {wasRewritten && <span className="badge badge-rewrite">rewritten</span>}
          {sourceToggle}
        </div>
        <p style={{ color: '#888', fontSize: 12, margin: 0 }}>No body captured</p>
      </div>
    )
  }

  const isBase64 = activeEncoding === 'base64'
  const trimmed = activeBody.trimStart()
  const looksJson =
    !isBase64 &&
    ((contentType?.includes('json') ?? false) ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('['))

  const { parsed, pretty, isJson } = looksJson
    ? parseJsonBody(activeBody)
    : { parsed: null, pretty: activeBody, isJson: false }

  // The tree view only makes sense for objects/arrays — top-level JSON
  // primitives (a bare string/number) fall back to the raw text view.
  const treeable = isJson && parsed !== null && typeof parsed === 'object'
  const displayText = isJson ? pretty : activeBody
  const showTree = treeable && view === 'tree'

  return (
    <div className="body-section">
      <div className="body-section-label">
        Body
        {wasRewritten && <span className="badge badge-rewrite">rewritten</span>}
        {truncated && <span className="badge badge-warn">truncated</span>}
        {isBase64 && <span className="badge badge-warn">base64</span>}
        {decodable === false && <span className="badge badge-warn">not decodable</span>}
        {sourceToggle}
        {treeable && (
          <button
            className="copy-btn"
            onClick={() => setView((v) => (v === 'tree' ? 'raw' : 'tree'))}
          >
            {view === 'tree' ? 'Raw' : 'Tree'}
          </button>
        )}
        <CopyButton text={displayText} />
      </div>
      {wasRewritten && (
        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
          Showing <strong>{source}</strong> body
        </div>
      )}
      {showTree ? (
        <div className="json-tree-block">
          <JsonView
            value={parsed as object}
            style={githubLightTheme}
            collapsed={2}
            displayDataTypes={false}
            enableClipboard
          />
        </div>
      ) : (
        <div className="code-block">
          <pre>{displayText}</pre>
        </div>
      )}
    </div>
  )
}

/**
 * One line of measurements, skipping whatever was not measurable: token counts
 * are only there when the upstream reported them, and a rate needs both a count
 * and a non-zero generation window.
 */
function statsLine(stats: ExchangeStats): string | null {
  const parts: string[] = []
  if (stats.ttftMs !== null) parts.push(`TTFT: ${stats.ttftMs}ms`)
  if (stats.inputTokens !== null) parts.push(`In: ${stats.inputTokens} tok`)
  if (stats.outputTokens !== null) parts.push(`Out: ${stats.outputTokens} tok`)
  if (stats.tokensPerSecond !== null) parts.push(`${stats.tokensPerSecond} tok/s`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function statusBadgeClass(status: number): string {
  if (status < 300) return 'badge-2xx'
  if (status < 400) return 'badge-3xx'
  if (status < 500) return 'badge-4xx'
  return 'badge-5xx'
}

export default function LogDetail({ id, onClose }: Props) {
  const [record, setRecord] = useState<LogRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getLog(id)
      .then(setRecord)
      .catch((e: unknown) => setError(String(e)))
  }, [id])

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="log-detail-overlay" onClick={handleBackdrop}>
      <div className="log-detail-modal">
        <button className="log-detail-close" onClick={onClose} aria-label="Close">×</button>

        {error && <p className="error-msg">Failed to load record: {error}</p>}
        {!record && !error && <p style={{ color: '#888' }}>Loading…</p>}

        {record && (
          <>
            {/* Summary row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
              <code style={{ fontWeight: 700 }}>{record.method}</code>
              <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                {record.path}{record.query ? `?${record.query}` : ''}
              </code>
              {record.response && (
                <span className={`badge ${statusBadgeClass(record.response.status)}`}>
                  {record.response.status}
                </span>
              )}
              {record.streaming && <span className="badge badge-stream">SSE</span>}
              {record.durationMs !== null && (
                <span style={{ fontSize: 12, color: '#555' }}>{record.durationMs}ms</span>
              )}
              {record.error && (
                <span className="badge badge-err" title={record.error}>ERR</span>
              )}
              {record.meta?.rewrites && record.meta.rewrites.length > 0 && (
                <span
                  className="badge badge-rewrite"
                  title={record.meta.rewrites.map((r) => `${r.target}:${r.name}`).join(', ')}
                >
                  rewritten ×{record.meta.rewrites.length}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
              {new Date(record.timestamp).toLocaleString()} · ID: <code>{record.id}</code>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
              Upstream: <code>{record.upstreamUrl}</code>
            </div>
            {record.error && (
              <div className="error-msg" style={{ marginBottom: 12 }}>
                Error: {record.error}
              </div>
            )}
            {record.stats && statsLine(record.stats) !== null && (
              <div className="stats-line" style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
                {statsLine(record.stats)}
              </div>
            )}
            {(record.requestBytes !== null || record.responseBytes !== null) && (
              <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
                {record.requestBytes !== null && <>Req: {record.requestBytes}B</>}
                {record.requestBytes !== null && record.responseBytes !== null && ' · '}
                {record.responseBytes !== null && <>Resp: {record.responseBytes}B</>}
              </div>
            )}

            <div className="detail-panes">
              {/* Request pane */}
              <div className="pane">
                <div className="pane-header">Request</div>
                <div className="pane-body">
                  <HeaderTable headers={record.request.headers} />
                  <BodyBlock
                    body={record.request.body}
                    encoding={record.request.bodyEncoding}
                    truncated={record.request.bodyTruncated}
                    contentType={record.request.headers['content-type']}
                    originalBody={record.request.originalBody}
                    originalBodyEncoding={record.request.originalBodyEncoding}
                  />
                </div>
              </div>

              {/* Response pane */}
              <div className="pane">
                <div className="pane-header">Response</div>
                <div className="pane-body">
                  {record.response === null ? (
                    <p style={{ color: '#888', fontSize: 12 }}>No response captured</p>
                  ) : (
                    <>
                      <HeaderTable headers={record.response.headers} />
                      <BodyBlock
                        body={record.response.body}
                        encoding={record.response.bodyEncoding}
                        truncated={record.response.bodyTruncated}
                        decodable={record.response.bodyDecodable}
                        contentType={record.response.headers['content-type']}
                        originalBody={record.response.originalBody}
                        originalBodyEncoding={record.response.originalBodyEncoding}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
