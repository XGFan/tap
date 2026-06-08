import { useState } from 'react'
import ConfigView from './views/ConfigView'
import LogsView from './views/LogsView'

type Tab = 'config' | 'logs'

export default function App() {
  const [tab, setTab] = useState<Tab>('logs')

  return (
    <div>
      <div className="warning-banner">
        ⚠ Logs capture full request headers in plaintext, including Authorization / API keys. Redaction is off by default.
      </div>
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
        {tab === 'config' ? <ConfigView /> : <LogsView />}
      </div>
    </div>
  )
}
