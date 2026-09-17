import { useEffect, useRef, useState } from 'react'
import { clearLogs, getLogs, openLogStream, type LogSummary } from '../api'
import LogDetail from '../components/LogDetail'

const PAGE_SIZE = 50

/** A token count / rate, or an em dash when the upstream reported none. */
function metric(value: number | null | undefined, unit: string): string {
  return value === null || value === undefined ? '—' : `${value}${unit}`
}

function statusBadge(status: number | null, error: string | null): JSX.Element {
  if (error && !status) {
    return <span className="badge badge-err">ERR</span>
  }
  if (!status) return <span className="badge badge-err">—</span>
  const cls =
    status < 300 ? 'badge-2xx' :
    status < 400 ? 'badge-3xx' :
    status < 500 ? 'badge-4xx' : 'badge-5xx'
  return <span className={`badge ${cls}`}>{status}</span>
}

export default function LogsView() {
  const [logs, setLogs] = useState<LogSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [liveMode, setLiveMode] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  // Initial load
  useEffect(() => {
    loadLogs()
  }, [])

  async function loadLogs(before?: string) {
    setLoading(true)
    setLoadError(null)
    try {
      const results = await getLogs({ limit: PAGE_SIZE, before })
      if (before) {
        setLogs((prev) => [...prev, ...results])
      } else {
        setLogs(results)
      }
      setHasMore(results.length === PAGE_SIZE)
    } catch (e: unknown) {
      setLoadError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function loadMore() {
    const oldest = logs[logs.length - 1]
    if (oldest) loadLogs(oldest.id)
  }

  // Live tail toggle
  useEffect(() => {
    if (liveMode) {
      const es = openLogStream()
      esRef.current = es
      es.onmessage = (evt) => {
        try {
          const summary = JSON.parse(evt.data) as LogSummary
          setLogs((prev) => [summary, ...prev])
        } catch {
          // ignore malformed frames
        }
      }
      es.onerror = () => {
        // EventSource auto-reconnects; no action needed
      }
      return () => {
        es.close()
        esRef.current = null
      }
    }
  }, [liveMode])

  function toggleLive() {
    setLiveMode((v) => !v)
  }

  function refresh() {
    loadLogs()
  }

  async function handleClear() {
    if (!window.confirm('Clear all request logs? This cannot be undone.')) return
    setClearing(true)
    try {
      await clearLogs()
      setLogs([])
      setHasMore(false)
    } catch (e: unknown) {
      setLoadError(String(e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div>
      <div className="card" style={{ padding: '12px 20px' }}>
        <div className="logs-toolbar">
          <strong style={{ fontSize: 15 }}>Request Logs</strong>
          <button className="btn" onClick={refresh} disabled={loading}>
            Refresh
          </button>
          <button
            className={`btn ${liveMode ? 'btn-danger' : 'btn-primary'}`}
            onClick={toggleLive}
          >
            {liveMode ? (
              <>
                <span className="live-dot" style={{ marginRight: 6 }} />
                Stop Live Tail
              </>
            ) : (
              'Live Tail'
            )}
          </button>
          <button className="btn btn-danger" onClick={handleClear} disabled={clearing || loading}>
            {clearing ? 'Clearing…' : 'Clear Logs'}
          </button>
          {liveMode && (
            <span style={{ fontSize: 12, color: '#16a34a' }}>
              Streaming new requests…
            </span>
          )}
        </div>

        {loadError && <p className="error-msg">{loadError}</p>}

        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Method</th>
              <th>Path</th>
              <th>Status</th>
              <th>Duration</th>
              <th title="Time to first token — first response byte">TTFT</th>
              <th title="Output tokens per second, as reported by the upstream">Tok/s</th>
              <th>Stream</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && !loading && (
              <tr>
                <td colSpan={9} style={{ color: '#888', textAlign: 'center', padding: '20px 0' }}>
                  No logs yet.
                </td>
              </tr>
            )}
            {logs.map((log) => (
              <tr key={log.id} onClick={() => setSelectedId(log.id)}>
                <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#555' }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </td>
                <td>
                  <code style={{ fontSize: 12 }}>{log.method}</code>
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 12, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.path}
                </td>
                <td>{statusBadge(log.status, log.error)}</td>
                <td style={{ fontSize: 12 }}>
                  {log.durationMs !== null ? `${log.durationMs}ms` : '—'}
                </td>
                <td style={{ fontSize: 12 }}>{metric(log.stats?.ttftMs, 'ms')}</td>
                <td style={{ fontSize: 12 }}>{metric(log.stats?.tokensPerSecond, '')}</td>
                <td>
                  {log.streaming && <span className="badge badge-stream">SSE</span>}
                </td>
                <td style={{ fontSize: 12, color: '#c53030', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.error ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {loading && (
          <p style={{ textAlign: 'center', color: '#888', padding: '12px 0' }}>Loading…</p>
        )}

        {hasMore && !loading && (
          <div style={{ textAlign: 'center', marginTop: 12 }}>
            <button className="btn" onClick={loadMore}>Load more</button>
          </div>
        )}
      </div>

      {selectedId && (
        <LogDetail id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  )
}
