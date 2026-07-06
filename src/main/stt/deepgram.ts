import { EventEmitter } from 'node:events'
import { DeepgramClient } from '@deepgram/sdk'
import { BoundedByteQueue } from './bounded-queue'
import type { SttProvider, SttStream, SttStreamOptions, TranscriptEvent } from './types'

// 16kHz * 2ch * 2 bytes ≈ 64 KB/s → ~5 minutes of audio buffered across outages.
const MAX_BUFFER_BYTES = 64_000 * 300
const CLOSE_GRACE_MS = 3000

interface DgWord {
  word: string
  punctuated_word?: string
  start: number
  end: number
  speaker?: number
}

/**
 * Splits a diarized word list into runs of consecutive words by the same
 * speaker, so one Results message can yield multiple attributed events.
 */
export function wordsToSpeakerRuns(
  words: DgWord[]
): { speaker: number | null; text: string; start: number; end: number }[] {
  const runs: { speaker: number | null; text: string; start: number; end: number }[] = []
  for (const w of words) {
    const speaker = w.speaker ?? null
    const text = w.punctuated_word ?? w.word
    const last = runs[runs.length - 1]
    if (last && last.speaker === speaker) {
      last.text += ' ' + text
      last.end = w.end
    } else {
      runs.push({ speaker, text, start: w.start, end: w.end })
    }
  }
  return runs
}

class DeepgramStream extends EventEmitter implements SttStream {
  private pending = new BoundedByteQueue(MAX_BUFFER_BYTES)
  private open = false
  private ending = false

  constructor(private socket: any) {
    super()
    socket.on('open', () => {
      this.open = true
      for (const chunk of this.pending.drain()) socket.sendMedia(chunk)
      this.emit('status', 'connected')
    })
    socket.on('message', (msg: any) => this.handleMessage(msg))
    socket.on('close', () => {
      this.open = false
      // The SDK socket auto-reconnects; until it does, we buffer and flag degraded.
      this.emit('status', this.ending ? 'closed' : 'degraded')
    })
    socket.on('error', (err: Error) => {
      this.emit('error', err)
      if (!this.ending) this.emit('status', 'degraded')
    })
  }

  private handleMessage(msg: any): void {
    if (msg?.type !== 'Results') return
    if (msg.is_final === false) return
    const channel: number = Array.isArray(msg.channel_index) ? msg.channel_index[0] : 0
    const alt = msg.channel?.alternatives?.[0]
    if (!alt) return
    const transcript: string = (alt.transcript ?? '').trim()
    if (!transcript) return

    const words: DgWord[] = alt.words ?? []
    const hasSpeakers = words.some((w) => w.speaker != null)
    if (hasSpeakers) {
      for (const run of wordsToSpeakerRuns(words)) {
        if (!run.text.trim()) continue
        const evt: TranscriptEvent = {
          channel,
          speaker: run.speaker,
          text: run.text,
          tsStart: Math.round(run.start * 1000),
          tsEnd: Math.round(run.end * 1000)
        }
        this.emit('transcript', evt)
      }
    } else {
      const evt: TranscriptEvent = {
        channel,
        speaker: null,
        text: transcript,
        tsStart: Math.round((msg.start ?? 0) * 1000),
        tsEnd: Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000)
      }
      this.emit('transcript', evt)
    }
  }

  sendAudio(chunk: Uint8Array): void {
    if (this.ending) return
    if (this.open) {
      try {
        this.socket.sendMedia(chunk)
      } catch {
        this.pending.push(chunk)
      }
    } else {
      this.pending.push(chunk)
    }
  }

  async end(): Promise<void> {
    this.ending = true
    try {
      if (this.open) {
        this.socket.sendCloseStream({ type: 'CloseStream' })
        // Give in-flight results a moment to arrive before tearing down.
        await new Promise((r) => setTimeout(r, CLOSE_GRACE_MS))
      }
    } catch {
      // socket already gone — nothing left to flush
    }
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
    this.emit('status', 'closed')
  }
}

export class DeepgramProvider implements SttProvider {
  constructor(private apiKey: string) {}

  async start(opts: SttStreamOptions): Promise<SttStream> {
    const client = new DeepgramClient({ apiKey: this.apiKey })
    const socket = await client.listen.v1.connect({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: opts.sampleRate,
      channels: opts.channels,
      multichannel: 'true',
      diarize: 'true',
      smart_format: 'true',
      punctuate: 'true',
      interim_results: 'false',
      Authorization: `token ${this.apiKey}`
    })
    const stream = new DeepgramStream(socket)
    stream.emit('status', 'connecting')
    socket.connect()
    return stream
  }
}
