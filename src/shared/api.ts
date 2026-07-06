import type {
  ContextDocInput,
  ListeningStatus,
  PresetInfo,
  SessionDetail,
  SessionMeta,
  StartSessionInput,
  Suggestion,
  TranscriptChunk
} from './types'

export interface CurrentSessionState {
  session: SessionMeta | null
  status: ListeningStatus
  micDeviceId?: string
  systemDeviceId?: string
}

export type CopilotEvent =
  | { type: 'transcript'; chunk: TranscriptChunk }
  | { type: 'status'; status: ListeningStatus }
  | { type: 'suggestion'; suggestion: Suggestion }
  | { type: 'session-started'; session: SessionMeta }
  | { type: 'session-ended'; sessionId: string }

/** The bridge the preload script exposes to both renderer windows. */
export interface CopilotApi {
  listPresets(): Promise<PresetInfo[]>
  startSession(input: StartSessionInput): Promise<SessionMeta>
  endSession(): Promise<SessionDetail | null>
  getCurrentSession(): Promise<CurrentSessionState>
  summon(): Promise<Suggestion | null>
  rateSuggestion(id: number, rating: number): Promise<void>
  listSessions(): Promise<SessionMeta[]>
  getSessionDetail(id: string): Promise<SessionDetail | null>
  deleteSession(id: string): Promise<void>
  pickContextFiles(): Promise<ContextDocInput[]>
  sendAudioChunk(buf: ArrayBuffer): void
  onEvent(cb: (evt: CopilotEvent) => void): () => void
}

declare global {
  interface Window {
    copilot: CopilotApi
  }
}
