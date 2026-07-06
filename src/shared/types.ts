export type Scenario = string // preset id, matches a file in /prompts (e.g. "interview", "general")

export interface SessionMeta {
  id: string
  title: string
  scenario: Scenario
  startedAt: number // epoch ms
  endedAt: number | null
  status: 'active' | 'ended'
  summary: string | null
  contextSummary: string | null
}

export interface TranscriptChunk {
  id: number
  sessionId: string
  speaker: string // "Me" | "Speaker 1" | "Speaker 2" | ...
  text: string
  tsStart: number // ms since session start
  tsEnd: number
  createdAt: number // epoch ms
}

export type ContextDocKind = 'paste' | 'pdf' | 'md' | 'txt'

export interface ContextDocInput {
  name: string
  kind: ContextDocKind
  content: string
}

export interface ContextDoc extends ContextDocInput {
  id: number
  sessionId: string
}

export interface Suggestion {
  id: number
  sessionId: string
  text: string
  latencyMs: number
  rating: number // -1 | 0 | 1
  createdAt: number
}

export interface ActionItem {
  id: number
  sessionId: string
  text: string
  owner: string | null
}

export interface SessionArtifacts {
  summary: string
  actionItems: { text: string; owner?: string | null }[]
}

export interface SessionDetail {
  session: SessionMeta
  transcript: TranscriptChunk[]
  suggestions: Suggestion[]
  contextDocs: ContextDoc[]
  actionItems: ActionItem[]
}

export type ListeningStatus = 'idle' | 'listening' | 'degraded' | 'ending'

export interface PresetInfo {
  id: string
  title: string
}

/** Session start payload from the UI. */
export interface StartSessionInput {
  title: string
  scenario: Scenario
  contextDocs: ContextDocInput[]
  micDeviceId?: string
  systemDeviceId?: string
}
