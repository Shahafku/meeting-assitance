import { useEffect, useState } from 'react'
import type { SessionDetail, SessionMeta } from '../../shared/types'

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString()
}

function SessionView({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)

  useEffect(() => {
    void window.copilot.getSessionDetail(id).then(setDetail)
  }, [id])

  if (!detail) return <div className="muted">Loading…</div>
  const { session, transcript, suggestions, actionItems, contextDocs } = detail

  const remove = async () => {
    if (!window.confirm(`Delete "${session.title}" and all of its data? This cannot be undone.`)) return
    await window.copilot.deleteSession(id)
    onDeleted()
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack}>← Back</button>
        <h2 style={{ margin: 0, fontSize: 17 }}>{session.title}</h2>
        <span className="muted small">
          {fmtDate(session.startedAt)} · {session.scenario}
        </span>
        <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => void remove()}>
          Delete session
        </button>
      </div>

      <h3>Summary</h3>
      <div className="card" style={{ whiteSpace: 'pre-wrap' }}>{session.summary ?? '(no summary generated)'}</div>

      <h3>Action items</h3>
      {actionItems.length === 0 ? (
        <div className="muted">None recorded.</div>
      ) : (
        <ul>
          {actionItems.map((it) => (
            <li key={it.id}>
              {it.text} {it.owner && <span className="muted">— {it.owner}</span>}
            </li>
          ))}
        </ul>
      )}

      <h3>Suggestions given ({suggestions.length})</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {suggestions.map((s) => (
          <div className="card" key={s.id}>
            {s.text}
            <div className="muted small" style={{ marginTop: 4 }}>
              {new Date(s.createdAt).toLocaleTimeString()} · {(s.latencyMs / 1000).toFixed(1)}s ·{' '}
              {s.rating === 1 ? '👍' : s.rating === -1 ? '👎' : 'unrated'}
            </div>
          </div>
        ))}
        {suggestions.length === 0 && <div className="muted">No suggestions were summoned.</div>}
      </div>

      {contextDocs.length > 0 && (
        <>
          <h3>Context used</h3>
          <div className="muted small">{contextDocs.map((d) => d.name).join(' · ')}</div>
        </>
      )}

      <h3>Transcript</h3>
      <div className="card" style={{ maxHeight: 400, overflowY: 'auto' }}>
        {transcript.map((c) => (
          <p key={c.id} style={{ margin: '4px 0' }}>
            <strong style={{ color: c.speaker === 'Me' ? 'var(--accent)' : 'var(--green)' }}>{c.speaker}:</strong>{' '}
            {c.text}
          </p>
        ))}
        {transcript.length === 0 && <span className="muted">Empty transcript.</span>}
      </div>
    </div>
  )
}

export function History() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = () => void window.copilot.listSessions().then(setSessions)
  useEffect(refresh, [])

  if (selected) {
    return (
      <SessionView
        id={selected}
        onBack={() => {
          setSelected(null)
          refresh()
        }}
        onDeleted={() => {
          setSelected(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div style={{ maxWidth: 720 }}>
      {sessions.length === 0 && <div className="muted">No sessions yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sessions.map((s) => (
          <div
            className="card"
            key={s.id}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
            onClick={() => setSelected(s.id)}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{s.title}</div>
              <div className="muted small">
                {fmtDate(s.startedAt)} · {s.scenario}
                {s.status === 'active' && ' · ⚠ still marked active'}
              </div>
            </div>
            <span className="muted small" style={{ marginLeft: 'auto' }}>
              {s.summary ? s.summary.slice(0, 80) + (s.summary.length > 80 ? '…' : '') : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
