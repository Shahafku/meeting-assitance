import { useEffect, useState } from 'react'
import type { ContextDocInput, PresetInfo } from '../../shared/types'
import { guessSystemDevice, listAudioInputs } from '../audio/capture'

export function NewSession({ onStarted }: { onStarted: () => void }) {
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [scenario, setScenario] = useState('')
  const [title, setTitle] = useState('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [micDeviceId, setMicDeviceId] = useState('')
  const [systemDeviceId, setSystemDeviceId] = useState('')
  const [docs, setDocs] = useState<ContextDocInput[]>([])
  const [pasteText, setPasteText] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.copilot.listPresets().then((p) => {
      setPresets(p)
      if (p.length > 0) setScenario((prev) => prev || p[0].id)
    })
    void listAudioInputs().then((inputs) => {
      setDevices(inputs)
      const blackhole = guessSystemDevice(inputs)
      if (blackhole) setSystemDeviceId(blackhole.deviceId)
      const mic = inputs.find((d) => !/blackhole/i.test(d.label))
      if (mic) setMicDeviceId(mic.deviceId)
    })
  }, [])

  const addPaste = () => {
    if (!pasteText.trim()) return
    setDocs((d) => [...d, { name: `Pasted note ${d.length + 1}`, kind: 'paste', content: pasteText.trim() }])
    setPasteText('')
  }

  const addFiles = async () => {
    try {
      const picked = await window.copilot.pickContextFiles()
      setDocs((d) => [...d, ...picked])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      // Anything typed but not yet added still counts as context.
      const allDocs = pasteText.trim()
        ? [...docs, { name: 'Pasted note', kind: 'paste' as const, content: pasteText.trim() }]
        : docs
      await window.copilot.startSession({ title, scenario, contextDocs: allDocs, micDeviceId, systemDeviceId })
      onStarted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  const noBlackhole = devices.length > 0 && !devices.some((d) => /blackhole/i.test(d.label))

  return (
    <div style={{ maxWidth: 640 }}>
      <label>Session title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. PM interview — Acme" />

      <label>Scenario preset</label>
      <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>

      <label>Microphone (transcribed as “Me”)</label>
      <select value={micDeviceId} onChange={(e) => setMicDeviceId(e.target.value)}>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Device ${d.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>

      <label>System audio device (the other participants)</label>
      <select value={systemDeviceId} onChange={(e) => setSystemDeviceId(e.target.value)}>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Device ${d.deviceId.slice(0, 8)}`}
          </option>
        ))}
      </select>
      {noBlackhole && (
        <div className="small" style={{ color: 'var(--orange)', marginTop: 4 }}>
          No BlackHole device found — remote voices won’t be captured. See the README for the one-time audio setup.
        </div>
      )}

      <label>Pre-meeting context (company info, your CV, talking points…)</label>
      <textarea
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        placeholder="Paste prep material here…"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={addPaste} disabled={!pasteText.trim()}>
          Add pasted text
        </button>
        <button onClick={() => void addFiles()}>Add files (PDF, MD, TXT)</button>
      </div>

      {docs.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {docs.map((d, i) => (
            <div key={i} className="card" style={{ display: 'flex', alignItems: 'center', padding: '8px 12px' }}>
              <span>
                {d.name} <span className="muted small">({d.kind}, {d.content.length.toLocaleString()} chars)</span>
              </span>
              <button
                className="danger"
                style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 12 }}
                onClick={() => setDocs((cur) => cur.filter((_, j) => j !== i))}
              >
                remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: 'var(--red)', marginTop: 12 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="primary" onClick={() => void start()} disabled={starting || !scenario}>
          {starting ? 'Starting…' : 'Start listening'}
        </button>
        <span className="muted small" style={{ marginLeft: 10 }}>
          A “● Listening” indicator stays visible while capture is on.
        </span>
      </div>
    </div>
  )
}
