import type { EventEmitter } from 'node:events'

/**
 * One finalized piece of transcribed speech.
 * Channel 0 = the user's microphone ("Me").
 * Channel 1 = system audio (everyone else), diarized into speaker indices.
 */
export interface TranscriptEvent {
  channel: number
  speaker: number | null // diarization index within the channel, if available
  text: string
  tsStart: number // ms from stream start
  tsEnd: number
}

export type SttStatus = 'connecting' | 'connected' | 'degraded' | 'closed'

export interface SttStreamOptions {
  sampleRate: number
  channels: number
}

/**
 * Live transcription stream. Events:
 *  - 'transcript' (TranscriptEvent)  — finalized text
 *  - 'status'     (SttStatus)       — connection health (drives the "degraded" badge)
 *  - 'error'      (Error)
 */
export interface SttStream extends EventEmitter {
  /** Raw PCM (16-bit LE, interleaved when channels > 1). Safe to call while disconnected — audio is buffered. */
  sendAudio(chunk: Uint8Array): void
  /** Flush and close. Resolves once remaining results have been received (or a timeout passes). */
  end(): Promise<void>
}

export interface SttProvider {
  start(opts: SttStreamOptions): Promise<SttStream>
}
