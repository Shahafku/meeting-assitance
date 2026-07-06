import { EventEmitter } from 'node:events'
import type { SttProvider, SttStream, SttStreamOptions, TranscriptEvent } from './types'

export interface MockScriptEvent {
  atMs: number // when the event fires, in transcript time
  channel: number
  speaker?: number | null
  text: string
  durationMs?: number
}

/**
 * Deterministic stand-in for a live STT connection. Two modes:
 *  - scripted: pass a script and it plays back on timers (harness use),
 *    scaled by `speed` (10 = 10x faster than real time).
 *  - manual: call stream.push(...) from tests.
 */
export class MockSttStream extends EventEmitter implements SttStream {
  private timers: NodeJS.Timeout[] = []
  audioBytesReceived = 0

  sendAudio(chunk: Uint8Array): void {
    this.audioBytesReceived += chunk.byteLength
  }

  push(evt: Partial<TranscriptEvent> & { text: string }): void {
    const full: TranscriptEvent = {
      channel: evt.channel ?? 0,
      speaker: evt.speaker ?? null,
      text: evt.text,
      tsStart: evt.tsStart ?? 0,
      tsEnd: evt.tsEnd ?? (evt.tsStart ?? 0) + 1000
    }
    this.emit('transcript', full)
  }

  playScript(script: MockScriptEvent[], speed = 1): void {
    for (const e of script) {
      const t = setTimeout(() => {
        this.push({
          channel: e.channel,
          speaker: e.speaker ?? null,
          text: e.text,
          tsStart: e.atMs,
          tsEnd: e.atMs + (e.durationMs ?? 2000)
        })
      }, e.atMs / speed)
      this.timers.push(t)
    }
  }

  async end(): Promise<void> {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.emit('status', 'closed')
  }
}

export class MockSttProvider implements SttProvider {
  lastStream: MockSttStream | null = null

  constructor(private opts: { script?: MockScriptEvent[]; speed?: number } = {}) {}

  async start(_opts: SttStreamOptions): Promise<SttStream> {
    const stream = new MockSttStream()
    this.lastStream = stream
    setTimeout(() => stream.emit('status', 'connected'), 0)
    if (this.opts.script) stream.playScript(this.opts.script, this.opts.speed ?? 1)
    return stream
  }
}
