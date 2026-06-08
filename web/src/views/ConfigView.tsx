import { useEffect, useState } from 'react'
import { getConfig, putConfig, type GatewayConfig } from '../api'

function validateBaseUrl(value: string): string | null {
  if (!value.trim()) return 'baseUrl is required'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Must be a valid URL (e.g. https://api.openai.com)'
  }
  // scheme+host only — no path beyond the root, no search, no hash
  if (url.pathname !== '/' && url.pathname !== '') {
    return 'baseUrl must be scheme+host only — no path (the gateway forwards the client path verbatim)'
  }
  if (url.search || url.hash) {
    return 'baseUrl must not include query string or hash'
  }
  return null
}

export default function ConfigView() {
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [form, setForm] = useState<GatewayConfig | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c)
        setForm(c)
      })
      .catch((e: unknown) => setLoadError(String(e)))
  }, [])

  function handleChange(field: keyof GatewayConfig, value: string) {
    if (!form) return
    setSaveSuccess(false)
    setSaveError(null)
    if (field === 'baseUrl') {
      setBaseUrlError(validateBaseUrl(value))
      setForm({ ...form, baseUrl: value })
    } else {
      setForm({ ...form, [field]: Number(value) })
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return
    const err = validateBaseUrl(form.baseUrl)
    if (err) {
      setBaseUrlError(err)
      return
    }
    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const updated = await putConfig(form)
      setConfig(updated)
      setForm(updated)
      setSaveSuccess(true)
    } catch (e: unknown) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    if (!config) return
    setForm(config)
    setBaseUrlError(null)
    setSaveError(null)
    setSaveSuccess(false)
  }

  if (loadError) {
    return (
      <div className="card">
        <p className="error-msg">Failed to load config: {loadError}</p>
      </div>
    )
  }

  if (!form) {
    return <div className="card">Loading…</div>
  }

  return (
    <div className="card">
      <h2>Gateway Config</h2>
      <form onSubmit={handleSave}>
        <div className="form-row">
          <label htmlFor="baseUrl">Base URL</label>
          <input
            id="baseUrl"
            type="text"
            value={form.baseUrl}
            onChange={(e) => handleChange('baseUrl', e.target.value)}
            placeholder="https://api.openai.com"
          />
          {baseUrlError && <span className="error-msg">{baseUrlError}</span>}
          <span className="hint">Scheme + host only. The gateway appends the client's full path verbatim.</span>
        </div>

        <div className="form-row">
          <label htmlFor="timeoutMs">Timeout (ms)</label>
          <input
            id="timeoutMs"
            type="number"
            min={0}
            value={form.timeoutMs}
            onChange={(e) => handleChange('timeoutMs', e.target.value)}
          />
        </div>

        <div className="form-row">
          <label htmlFor="bodyTimeoutMs">Body Timeout (ms)</label>
          <input
            id="bodyTimeoutMs"
            type="number"
            min={0}
            value={form.bodyTimeoutMs}
            onChange={(e) => handleChange('bodyTimeoutMs', e.target.value)}
          />
        </div>

        <div className="form-row">
          <label htmlFor="captureBodyLimitBytes">Capture Response Body Limit (bytes)</label>
          <input
            id="captureBodyLimitBytes"
            type="number"
            min={0}
            value={form.captureBodyLimitBytes}
            onChange={(e) => handleChange('captureBodyLimitBytes', e.target.value)}
          />
        </div>

        <div className="form-row">
          <label htmlFor="captureRequestBodyLimitBytes">Capture Request Body Limit (bytes)</label>
          <input
            id="captureRequestBodyLimitBytes"
            type="number"
            min={0}
            value={form.captureRequestBodyLimitBytes}
            onChange={(e) => handleChange('captureRequestBodyLimitBytes', e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !!baseUrlError}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn" onClick={handleReset}>
            Reset
          </button>
        </div>

        {saveSuccess && <p className="success-msg">Config saved.</p>}
        {saveError && <p className="error-msg">{saveError}</p>}
      </form>
    </div>
  )
}
