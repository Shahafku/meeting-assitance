import { useEffect, useState } from 'react'
import type { ListeningStatus, SessionMeta } from '../../shared/types'
import { History } from './History'
import { NewSession } from './NewSession'

export function App() {
  const [tab, setTab] = useState<'new' | 'history'>('new')
  const [active, setActive] = useState<SessionMeta | null>(null)
  const [status, setStatus] = useState<ListeningStatus>('idle')

  useEffect(() => {
    void window.copilot.getCurrentSession().then((s) => {
      setActive(s.session)
      setStatus(s.status)
    })
    return window.copilot.onEvent((evt) => {
      if (evt.type === 'session-started') setActive(evt.session)
      else if (evt.type === 'session-ended') setActive(null)
      else if (evt.type === 'status') setStatus(evt.status)
    })
  }, [])

  return (
    <div style={{ padding: '18px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Meeting Copilot</h1>
        <span className={`dot ${status}`} style={{ marginLeft: 6 }} />
        <span className="muted small">{status === 'idle' ? 'not listening' : status}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setTab('new')} style={tab === 'new' ? { borderColor: 'var(--accent)' } : {}}>
            {active ? 'Current session' : 'New session'}
          </button>
          <button
            onClick={() => setTab('history')}
            style={tab === 'history' ? { borderColor: 'var(--accent)' } : {}}
          >
            History
          </button>
        </div>
      </div>

      {tab === 'history' ? (
        <History />
      ) : active ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>
            <span className={`dot ${status}`} />
            {active.title}
          </h2>
          <p className="muted">
            Started {new Date(active.startedAt).toLocaleTimeString()} · preset “{active.scenario}”.
            <br />
            The suggestion window is floating on top — press ⌘⇧Space anytime for one suggestion.
          </p>
          <button className="danger" onClick={() => void window.copilot.endSession()}>
            End session &amp; save artifacts
          </button>
        </div>
      ) : (
        <NewSession onStarted={() => setTab('new')} />
      )}
    </div>
  )
}
