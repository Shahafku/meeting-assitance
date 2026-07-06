import { useCallback, useEffect, useRef, useState } from 'react'
import type { ListeningStatus, SessionMeta, Suggestion, TranscriptChunk } from '../../shared/types'
import { startCapture, type CaptureHandles } from '../audio/capture'

const STATUS_LABEL: Record<ListeningStatus, string> = {
  idle: 'Idle',
  listening: '● Listening',
  degraded: '◐ Transcription degraded',
  ending: 'Saving…'
}

function RatingButtons({ suggestion }: { suggestion: Suggestion }) {
  const [rating, setRating] = useState(suggestion.rating)
  const rate = (value: number) => {
    const next = rating === value ? 0 : value
    setRating(next)
    void window.copilot.rateSuggestion(suggestion.id, next)
  }
  return (
    <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
      <button
        onClick={() => rate(1)}
        title="Actually helped"
        style={{ padding: '2px 8px', opacity: rating === 1 ? 1 : 0.4 }}
      >
        👍
      </button>{' '}
      <button
        onClick={() => rate(-1)}
        title="Not useful"
        style={{ padding: '2px 8px', opacity: rating === -1 ? 1 : 0.4 }}
      >
        👎
      </button>
    </span>
  )
}

export function App() {
  const [session, setSession] = useState<SessionMeta | null>(null)
  const [status, setStatus] = useState<ListeningStatus>('idle')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [thinking, setThinking] = useState(false)
  const [lastLine, setLastLine] = useState<TranscriptChunk | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const capture = useRef<CaptureHandles | null>(null)

  const stopCapture = useCallback(() => {
    capture.current?.stop()
    capture.current = null
  }, [])

  useEffect(() => {
    let disposed = false

    async function boot() {
      const state = await window.copilot.getCurrentSession()
      if (disposed) return
      setSession(state.session)
      setStatus(state.status)
      if (state.session) {
        const detail = await window.copilot.getSessionDetail(state.session.id)
        if (detail && !disposed) setSuggestions(detail.suggestions)
        try {
          capture.current = await startCapture({
            micDeviceId: state.micDeviceId,
            systemDeviceId: state.systemDeviceId,
            onChunk: (buf) => window.copilot.sendAudioChunk(buf)
          })
        } catch (err) {
          setCaptureError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    void boot()

    const off = window.copilot.onEvent((evt) => {
      if (evt.type === 'status') setStatus(evt.status)
      else if (evt.type === 'suggestion') {
        setSuggestions((prev) => [...prev, evt.suggestion])
        setThinking(false)
      } else if (evt.type === 'transcript') setLastLine(evt.chunk)
      else if (evt.type === 'session-ended') {
        stopCapture()
        setSession(null)
      } else if (evt.type === 'session-started') setSession(evt.session)
    })

    return () => {
      disposed = true
      off()
      stopCapture()
    }
  }, [stopCapture])

  const summon = async () => {
    setThinking(true)
    const s = await window.copilot.summon()
    if (!s) setThinking(false) // debounced or no session
  }

  const latest = suggestions[suggestions.length - 1]
  const history = suggestions.slice(0, -1).reverse()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: 12, gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={`dot ${status}`} />
        <strong style={{ fontSize: 13 }}>{STATUS_LABEL[status]}</strong>
        <span className="muted small" style={{ marginLeft: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
          {session?.title ?? ''}
        </span>
        <button className="danger" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => void window.copilot.endSession()} disabled={!session}>
          End
        </button>
      </div>

      {captureError && (
        <div className="card" style={{ borderColor: 'var(--red)' }}>
          <strong>Audio capture failed:</strong> <span className="small">{captureError}</span>
        </div>
      )}

      <button className="primary" onClick={summon} disabled={!session || thinking}>
        {thinking ? 'Thinking…' : 'Summon suggestion  (⌘⇧Space)'}
      </button>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {latest ? (
          <div className="card" style={{ borderColor: 'var(--accent)' }}>
            <div style={{ fontSize: 15, lineHeight: 1.5 }}>{latest.text}</div>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
              <span className="muted small">{(latest.latencyMs / 1000).toFixed(1)}s</span>
              <RatingButtons suggestion={latest} />
            </div>
          </div>
        ) : (
          <div className="muted small" style={{ textAlign: 'center', marginTop: 30 }}>
            Press the hotkey when you want one short, context-grounded suggestion.
          </div>
        )}
        {history.map((s) => (
          <div className="card" key={s.id} style={{ opacity: 0.75 }}>
            <div>{s.text}</div>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
              <span className="muted small">{new Date(s.createdAt).toLocaleTimeString()}</span>
              <RatingButtons suggestion={s} />
            </div>
          </div>
        ))}
      </div>

      <div className="muted small" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, minHeight: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {lastLine ? `${lastLine.speaker}: ${lastLine.text}` : 'Waiting for speech…'}
      </div>
    </div>
  )
}
