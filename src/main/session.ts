import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ContextDocInput,
  ListeningStatus,
  SessionDetail,
  SessionMeta,
  StartSessionInput,
  Suggestion,
  TranscriptChunk
} from '../shared/types'
import { CONTEXT_SUMMARIZE_THRESHOLD_CHARS, TRANSCRIPT_WINDOW_MS } from './config'
import type { LlmClient } from './llm/types'
import { loadPreset } from './prompts'
import type { Store } from './store/store'
import type { SttProvider, SttStream, TranscriptEvent } from './stt/types'

export interface SessionManagerDeps {
  store: Store
  stt: SttProvider
  llm: LlmClient
  promptsDir: string
  sampleRate?: number
  channels?: number
}

/** Channel 0 is the mic; channel 1 is system audio, diarized. */
export function speakerLabel(evt: Pick<TranscriptEvent, 'channel' | 'speaker'>): string {
  if (evt.channel === 0) return 'Me'
  return evt.speaker != null ? `Speaker ${evt.speaker + 1}` : 'Them'
}

/** "Speaker: text" lines for prompt injection. */
export function formatTranscript(chunks: TranscriptChunk[]): string {
  return chunks.map((c) => `${c.speaker}: ${c.text}`).join('\n')
}

function fmtTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`
}

/**
 * "Cleaned transcript" (R7): consecutive chunks by the same speaker are
 * merged into one timestamped paragraph. Done locally and deterministically —
 * regenerating a full transcript through the LLM would be slow, expensive,
 * and riskier than a merge.
 */
export function cleanedTranscript(chunks: TranscriptChunk[]): string {
  const parts: string[] = []
  let curSpeaker: string | null = null
  let curStart = 0
  let curTexts: string[] = []
  const flush = () => {
    if (curSpeaker != null && curTexts.length > 0) {
      parts.push(`${fmtTimestamp(curStart)} ${curSpeaker}: ${curTexts.join(' ')}`)
    }
  }
  for (const c of chunks) {
    if (c.speaker !== curSpeaker) {
      flush()
      curSpeaker = c.speaker
      curStart = c.tsStart
      curTexts = []
    }
    curTexts.push(c.text)
  }
  flush()
  return parts.join('\n\n')
}

/**
 * Orchestrates one live session: audio in → transcript chunks (write-through
 * to SQLite), hotkey → one suggestion, end → artifacts.
 *
 * Events:
 *  - 'transcript' (TranscriptChunk)
 *  - 'status'     (ListeningStatus)
 *  - 'suggestion' (Suggestion)
 *  - 'ended'      (sessionId: string)
 */
export class SessionManager extends EventEmitter {
  private store: Store
  private stt: SttProvider
  private llm: LlmClient
  private promptsDir: string
  private sampleRate: number
  private channels: number

  private activeSession: SessionMeta | null = null
  private stream: SttStream | null = null
  private summonInFlight = false
  private status: ListeningStatus = 'idle'

  constructor(deps: SessionManagerDeps) {
    super()
    this.store = deps.store
    this.stt = deps.stt
    this.llm = deps.llm
    this.promptsDir = deps.promptsDir
    this.sampleRate = deps.sampleRate ?? 16_000
    this.channels = deps.channels ?? 2
  }

  get active(): SessionMeta | null {
    return this.activeSession
  }

  get listeningStatus(): ListeningStatus {
    return this.status
  }

  private setStatus(s: ListeningStatus): void {
    this.status = s
    this.emit('status', s)
  }

  async startSession(input: Pick<StartSessionInput, 'title' | 'scenario' | 'contextDocs'>): Promise<SessionMeta> {
    if (this.activeSession) throw new Error('A session is already active')
    // Validate the preset before creating anything.
    loadPreset(this.promptsDir, input.scenario)

    const session = this.store.createSession({
      id: randomUUID(),
      title: input.title || `Session ${new Date().toLocaleString()}`,
      scenario: input.scenario,
      startedAt: Date.now()
    })
    for (const doc of input.contextDocs) this.store.addContextDoc(session.id, doc)

    // Long prep material gets compressed once, up front, so every summon stays fast.
    const rawContext = this.assembleContext(input.contextDocs)
    if (rawContext.length > CONTEXT_SUMMARIZE_THRESHOLD_CHARS) {
      try {
        const summary = await this.llm.summarizeContext(rawContext)
        this.store.setContextSummary(session.id, summary)
      } catch (err) {
        // Non-fatal: fall back to truncated raw context at summon time.
        this.emit('error', err)
      }
    }

    this.activeSession = this.store.getSession(session.id)
    const stream = await this.stt.start({ sampleRate: this.sampleRate, channels: this.channels })
    this.stream = stream
    stream.on('transcript', (evt: TranscriptEvent) => this.onTranscript(evt))
    stream.on('status', (s: string) => {
      if (!this.activeSession) return
      if (s === 'connected') this.setStatus('listening')
      else if (s === 'degraded') this.setStatus('degraded')
    })
    stream.on('error', (err: Error) => this.emit('error', err))
    this.setStatus('listening')
    return this.activeSession!
  }

  private assembleContext(docs: ContextDocInput[]): string {
    return docs.map((d) => `## ${d.name}\n${d.content}`).join('\n\n')
  }

  private contextForPrompt(): string {
    if (!this.activeSession) return ''
    const session = this.store.getSession(this.activeSession.id)
    if (session?.contextSummary) return session.contextSummary
    const raw = this.assembleContext(this.store.getContextDocs(this.activeSession.id))
    // Defensive cap in case summarization failed on an oversized upload.
    return raw.length > CONTEXT_SUMMARIZE_THRESHOLD_CHARS
      ? raw.slice(0, CONTEXT_SUMMARIZE_THRESHOLD_CHARS)
      : raw
  }

  private onTranscript(evt: TranscriptEvent): void {
    if (!this.activeSession) return
    const chunk = this.store.appendChunk(this.activeSession.id, {
      speaker: speakerLabel(evt),
      text: evt.text,
      tsStart: evt.tsStart,
      tsEnd: evt.tsEnd
    })
    this.emit('transcript', chunk)
  }

  sendAudio(chunk: Uint8Array): void {
    this.stream?.sendAudio(chunk)
  }

  /**
   * Hotkey handler (R5). Returns null when there is no active session or a
   * request is already in flight (rapid double-press → second press ignored).
   * Every press is logged either way — that log is the P2 dataset.
   */
  async summon(): Promise<Suggestion | null> {
    const pressedAt = Date.now()
    if (!this.activeSession || this.summonInFlight) {
      this.store.logHotkey(this.activeSession?.id ?? null, pressedAt, false)
      return null
    }
    this.summonInFlight = true
    this.store.logHotkey(this.activeSession.id, pressedAt, true)
    try {
      const systemPrompt = loadPreset(this.promptsDir, this.activeSession.scenario)
      const windowChunks = this.store.getRecentChunks(this.activeSession.id, TRANSCRIPT_WINDOW_MS)
      const result = await this.llm.suggest({
        systemPrompt,
        contextText: this.contextForPrompt(),
        transcriptWindow: formatTranscript(windowChunks)
      })
      const suggestion = this.store.addSuggestion(
        this.activeSession.id,
        result.text,
        Date.now() - pressedAt
      )
      this.emit('suggestion', suggestion)
      return suggestion
    } finally {
      this.summonInFlight = false
    }
  }

  rateSuggestion(id: number, rating: number): void {
    this.store.rateSuggestion(id, rating)
  }

  async endSession(): Promise<SessionDetail | null> {
    if (!this.activeSession) return null
    const sessionId = this.activeSession.id
    this.setStatus('ending')
    try {
      await this.stream?.end()
    } catch {
      /* stream already dead — artifacts still get generated */
    }
    this.stream = null
    await this.finalizeSession(sessionId)
    this.activeSession = null
    this.setStatus('idle')
    this.emit('ended', sessionId)
    return this.store.getSessionDetail(sessionId)
  }

  private async finalizeSession(sessionId: string): Promise<void> {
    const chunks = this.store.getChunks(sessionId)
    let summary: string | null = null
    if (chunks.length > 0) {
      try {
        const docs = this.store.getContextDocs(sessionId)
        const artifacts = await this.llm.artifacts({
          transcriptText: cleanedTranscript(chunks),
          contextText: this.assembleContext(docs)
        })
        summary = artifacts.summary
        this.store.addActionItems(sessionId, artifacts.actionItems)
      } catch (err) {
        // Transcript is already safe on disk; a failed summary is recoverable later.
        this.emit('error', err)
      }
    }
    this.store.endSession(sessionId, Date.now(), summary)
  }

  /**
   * Crash recovery: sessions left 'active' by a previous run are closed and
   * their artifacts generated from whatever transcript survived (write-through
   * means nearly all of it).
   */
  async recoverOrphanSessions(): Promise<number> {
    const orphans = this.store.getActiveSessions()
    for (const s of orphans) await this.finalizeSession(s.id)
    return orphans.length
  }

  deleteSession(sessionId: string): void {
    if (this.activeSession?.id === sessionId) throw new Error('Cannot delete the active session')
    this.store.deleteSession(sessionId)
  }
}
