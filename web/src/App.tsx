import { useEffect, useState } from 'react'
import { getConfig, type GatewayConfig } from './api'
import ConfigView from './views/ConfigView'
import LogsView from './views/LogsView'

type Tab = 'config' | 'logs'

export default function App() {
  const [tab, setTab] = useState<Tab>('logs')
  const [config, setConfig] = useState<GatewayConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((e: unknown) => setConfigError(String(e)))
  }, [])

  const showBanner = config === null ? configError !== null : !config.redact.enabled

  return (
    <div>
      {showBanner && (
        <div className="warning-banner">
          {configError !== null
            ? '⚠ Could not read gateway config — redaction state unknown. Assume logs are capturing credentials in plaintext.'
            : '⚠ Logs capture request headers, query strings and bodies in plaintext, including Authorization / API keys. Redaction is off.'}
        </div>
      )}
      <div className="tabs">
        <button
          className={`tab-btn ${tab === 'logs' ? 'active' : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs
        </button>
        <button
          className={`tab-btn ${tab === 'config' ? 'active' : ''}`}
          onClick={() => setTab('config')}
        >
          Config
        </button>
      </div>
      <div className="container">
        {tab === 'config' ? (
          <ConfigView config={config} loadError={configError} onSaved={setConfig} />
        ) : (
          <LogsView />
        )}
      </div>
    </div>
  )
}
