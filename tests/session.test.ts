import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockLlm } from '../src/main/llm/mock'
import { cleanedTranscript, formatTranscript, SessionManager, speakerLabel } from '../src/main/session'
import { Store } from '../src/main/store/store'
import { MockSttProvider } from '../src/main/stt/mock'

const PROMPTS_DIR = resolve(__dirname, '../prompts')

let dir: string
let store: Store
let stt: MockSttProvider
let llm: MockLlm
let manager: SessionManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-session-'))
  store = new Store(join(dir, 'test.db'))
  stt = new MockSttProvider()
  llm = new MockLlm()
  manager = new SessionManager({ store, stt, llm, promptsDir: PROMPTS_DIR })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function startWithContext() {
  return manager.startSession({
    title: 'PM interview',
    scenario: 'interview',
    contextDocs: [{ name: 'Company brief', kind: 'paste', content: 'Acme builds rocket software.\nInterviewer: Dana.' }]
  })
}

describe('speaker labeling', () => {
  it('maps channels and diarization indices to labels', () => {
    expect(speakerLabel({ channel: 0, speaker: null })).toBe('Me')
    expect(speakerLabel({ channel: 1, speaker: 0 })).toBe('Speaker 1')
    expect(speakerLabel({ channel: 1, speaker: 1 })).toBe('Speaker 2')
    expect(speakerLabel({ channel: 1, speaker: null })).toBe('Them')
  })
})

describe('SessionManager', () => {
  it('persists transcript events with speaker labels (write-through)', async () => {
    const session = await startWithContext()
    stt.lastStream!.push({ channel: 0, text: 'Nice to meet you', tsStart: 0, tsEnd: 1500 })
    stt.lastStream!.push({ channel: 1, speaker: 0, text: 'Likewise', tsStart: 1600, tsEnd: 2500 })
    const chunks = store.getChunks(session.id)
    expect(chunks.map((c) => c.speaker)).toEqual(['Me', 'Speaker 1'])
  })

  it('summon returns a context-grounded suggestion and records latency', async () => {
    const session = await startWithContext()
    stt.lastStream!.push({ channel: 1, speaker: 0, text: 'Tell me about yourself', tsStart: 0, tsEnd: 2000 })
    const suggestion = await manager.summon()
    expect(suggestion).not.toBeNull()
    expect(suggestion!.text).toContain('Acme builds rocket software')
    expect(store.getSuggestions(session.id)).toHaveLength(1)
    // The summon request carried the transcript window and the preset.
    expect(llm.suggestCalls[0].transcriptWindow).toContain('Speaker 1: Tell me about yourself')
    expect(llm.suggestCalls[0].systemPrompt).toContain('Maximum 50 words')
  })

  it('summon only sends the last ~2 minutes of transcript', async () => {
    await startWithContext()
    stt.lastStream!.push({ channel: 0, text: 'ancient history', tsStart: 0, tsEnd: 5_000 })
    stt.lastStream!.push({ channel: 0, text: 'recent remark', tsStart: 400_000, tsEnd: 405_000 })
    await manager.summon()
    expect(llm.suggestCalls[0].transcriptWindow).not.toContain('ancient history')
    expect(llm.suggestCalls[0].transcriptWindow).toContain('recent remark')
  })

  it('debounces rapid double summon: second press is ignored but logged', async () => {
    await startWithContext()
    llm.delayMs = 50
    stt.lastStream!.push({ channel: 0, text: 'hello', tsStart: 0, tsEnd: 1000 })
    const [first, second] = await Promise.all([manager.summon(), manager.summon()])
    const results = [first, second]
    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(results.filter((r) => r === null)).toHaveLength(1)
  })

  it('summon without an active session returns null', async () => {
    expect(await manager.summon()).toBeNull()
  })

  it('endSession produces summary + action items and flips status', async () => {
    const session = await startWithContext()
    stt.lastStream!.push({ channel: 0, text: 'I will send the deck', tsStart: 0, tsEnd: 2000 })
    const detail = await manager.endSession()
    expect(detail!.session.status).toBe('ended')
    expect(detail!.session.summary).toContain('Mock summary')
    expect(detail!.actionItems.length).toBeGreaterThan(0)
    expect(manager.active).toBeNull()
    expect(store.getSession(session.id)!.status).toBe('ended')
  })

  it('summarizes oversized context once at start and uses it for summons', async () => {
    await manager.startSession({
      title: 'big context',
      scenario: 'general',
      contextDocs: [{ name: 'huge', kind: 'paste', content: 'x'.repeat(30_000) }]
    })
    stt.lastStream!.push({ channel: 0, text: 'hi', tsStart: 0, tsEnd: 500 })
    await manager.summon()
    expect(llm.suggestCalls[0].contextText).toContain('Mock context summary')
  })

  it('recovers orphaned sessions from a previous crash', async () => {
    const session = await startWithContext()
    stt.lastStream!.push({ channel: 0, text: 'we agreed on X', tsStart: 0, tsEnd: 2000 })
    // Simulate crash: new manager over the same store, no endSession call.
    const manager2 = new SessionManager({ store, stt: new MockSttProvider(), llm, promptsDir: PROMPTS_DIR })
    const recovered = await manager2.recoverOrphanSessions()
    expect(recovered).toBe(1)
    const s = store.getSession(session.id)!
    expect(s.status).toBe('ended')
    expect(s.summary).toContain('Mock summary')
  })

  it('refuses to delete the active session', async () => {
    const session = await startWithContext()
    expect(() => manager.deleteSession(session.id)).toThrow()
  })

  it('rejects a second concurrent session', async () => {
    await startWithContext()
    await expect(startWithContext()).rejects.toThrow('already active')
  })
})

describe('transcript formatting', () => {
  const chunks = [
    { id: 1, sessionId: 's', speaker: 'Me', text: 'Hi.', tsStart: 0, tsEnd: 1000, createdAt: 0 },
    { id: 2, sessionId: 's', speaker: 'Me', text: 'Thanks for the time.', tsStart: 1000, tsEnd: 2000, createdAt: 0 },
    { id: 3, sessionId: 's', speaker: 'Speaker 1', text: 'Of course.', tsStart: 2000, tsEnd: 3000, createdAt: 0 }
  ]

  it('formatTranscript emits one line per chunk', () => {
    expect(formatTranscript(chunks)).toBe('Me: Hi.\nMe: Thanks for the time.\nSpeaker 1: Of course.')
  })

  it('cleanedTranscript merges consecutive same-speaker chunks with timestamps', () => {
    expect(cleanedTranscript(chunks)).toBe(
      '[00:00] Me: Hi. Thanks for the time.\n\n[00:02] Speaker 1: Of course.'
    )
  })
})
