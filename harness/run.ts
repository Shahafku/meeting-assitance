/**
 * CLI replay harness — the spec's "Phase 0" kept as a permanent test rig.
 *
 * Runs the real pipeline (STT → store → summon → artifacts) without the
 * Electron shell, so the whole loop is testable on any machine.
 *
 * Modes:
 *   Mock STT (scripted transcript, no audio, no keys needed with --mock-llm):
 *     npm run harness -- --fixture tests/fixtures/mock-meeting.json --mock-llm --auto
 *   Live STT (streams a WAV through Deepgram; needs DEEPGRAM_API_KEY):
 *     npm run harness -- --wav path/to/audio.wav
 *
 * Interactive keys: [s]ummon  [e]nd session  [q]uit
 * --auto: summon once after playback, then end and print artifacts (CI mode).
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AnthropicLlm } from '../src/main/llm/anthropic'
import { MockLlm } from '../src/main/llm/mock'
import type { LlmClient } from '../src/main/llm/types'
import { SessionManager } from '../src/main/session'
import { Store } from '../src/main/store/store'
import { DeepgramProvider } from '../src/main/stt/deepgram'
import { MockSttProvider, type MockScriptEvent } from '../src/main/stt/mock'
import type { SttProvider } from '../src/main/stt/types'
import type { ContextDocInput } from '../src/shared/types'

interface Fixture {
  title: string
  scenario: string
  context: ContextDocInput[]
  script: MockScriptEvent[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

function parseWavHeader(buf: Buffer): { sampleRate: number; channels: number; dataOffset: number; dataLength: number } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let offset = 12
  let sampleRate = 16_000
  let channels = 1
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(offset + 8)
      if (format !== 1) throw new Error(`Only PCM WAV supported (got format ${format})`)
      channels = buf.readUInt16LE(offset + 10)
      sampleRate = buf.readUInt32LE(offset + 12)
      const bits = buf.readUInt16LE(offset + 22)
      if (bits !== 16) throw new Error(`Only 16-bit PCM supported (got ${bits}-bit)`)
    } else if (id === 'data') {
      return { sampleRate, channels, dataOffset: offset + 8, dataLength: size }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('No data chunk found in WAV')
}

async function main(): Promise<void> {
  const wavPath = arg('wav')
  const fixturePath = arg('fixture')
  const speed = Number(arg('speed') ?? (flag('auto') ? 20 : 1))
  const dbPath = arg('db') ?? join(process.cwd(), 'data', 'harness.db')

  if (!wavPath && !fixturePath) {
    console.error('Usage: npm run harness -- (--fixture <file.json> | --wav <file.wav>) [--mock-llm] [--auto] [--speed N] [--db path]')
    process.exit(1)
  }

  let llm: LlmClient
  if (flag('mock-llm')) {
    llm = new MockLlm({ delayMs: 30 })
  } else {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      console.error('ANTHROPIC_API_KEY not set — pass --mock-llm to run without it.')
      process.exit(1)
    }
    llm = new AnthropicLlm(key)
  }

  let stt: SttProvider
  let fixture: Fixture | null = null
  let playbackMs = 0

  if (fixturePath) {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
    stt = new MockSttProvider({ script: fixture.script, speed })
    playbackMs = Math.max(...fixture.script.map((e) => e.atMs + (e.durationMs ?? 2000))) / speed
  } else {
    const key = process.env.DEEPGRAM_API_KEY
    if (!key) {
      console.error('DEEPGRAM_API_KEY not set — live WAV mode needs it (use --fixture for mock mode).')
      process.exit(1)
    }
    stt = new DeepgramProvider(key)
  }

  const store = new Store(dbPath)
  const manager = new SessionManager({ store, stt, llm, promptsDir: join(process.cwd(), 'prompts') })

  manager.on('transcript', (c) => console.log(`  ${c.speaker}: ${c.text}`))
  manager.on('status', (s) => console.log(`[status] ${s}`))
  manager.on('error', (e) => console.error('[error]', e instanceof Error ? e.message : e))

  const session = await manager.startSession({
    title: fixture?.title ?? `Harness ${new Date().toISOString()}`,
    scenario: fixture?.scenario ?? 'general',
    contextDocs: fixture?.context ?? []
  })
  console.log(`Session ${session.id} started (scenario: ${session.scenario}). Keys: [s]ummon [e]nd [q]uit`)

  // Live mode: stream the WAV at real-time pace, as the app would.
  let wavDone: Promise<void> = Promise.resolve()
  if (wavPath) {
    const buf = readFileSync(wavPath)
    const wav = parseWavHeader(buf)
    console.log(`Streaming WAV: ${wav.sampleRate} Hz, ${wav.channels} ch, ${(wav.dataLength / 1024).toFixed(0)} KiB`)
    const bytesPerSec = wav.sampleRate * wav.channels * 2
    const chunkBytes = Math.floor(bytesPerSec / 10) // 100ms chunks
    playbackMs = (wav.dataLength / bytesPerSec) * 1000
    wavDone = (async () => {
      for (let off = wav.dataOffset; off < wav.dataOffset + wav.dataLength; off += chunkBytes) {
        manager.sendAudio(buf.subarray(off, Math.min(off + chunkBytes, wav.dataOffset + wav.dataLength)))
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
  }

  async function summon(): Promise<void> {
    console.log('[summon] thinking…')
    const s = await manager.summon()
    if (s) console.log(`\n💡 (${s.latencyMs} ms) ${s.text}\n`)
    else console.log('[summon] ignored (busy or no session)')
  }

  async function endAndReport(): Promise<void> {
    console.log('[ending session…]')
    const detail = await manager.endSession()
    if (!detail) return
    console.log('\n===== SUMMARY =====\n' + (detail.session.summary ?? '(none)'))
    console.log('\n===== ACTION ITEMS =====')
    for (const it of detail.actionItems) console.log(`- ${it.text}${it.owner ? ` (${it.owner})` : ''}`)
    if (detail.actionItems.length === 0) console.log('(none)')
    console.log(`\nTranscript chunks: ${detail.transcript.length}, suggestions: ${detail.suggestions.length}`)
    console.log(`Saved to ${dbPath}`)
    store.close()
    process.exit(0)
  }

  if (flag('auto')) {
    await wavDone
    await new Promise((r) => setTimeout(r, playbackMs + 500))
    await summon()
    await endAndReport()
    return
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', (key: Buffer) => {
      const k = key.toString()
      if (k === 's') void summon()
      else if (k === 'e') void endAndReport()
      else if (k === 'q' || k === '') process.exit(0)
    })
  } else {
    console.log('(stdin is not a TTY — running until playback ends, then finishing)')
    await wavDone
    await new Promise((r) => setTimeout(r, playbackMs + 500))
    await endAndReport()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
