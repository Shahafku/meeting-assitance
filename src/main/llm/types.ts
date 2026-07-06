import type { SessionArtifacts } from '../../shared/types'

export interface SuggestInput {
  systemPrompt: string // scenario preset content
  contextText: string // (possibly summarized) prep material
  transcriptWindow: string // last ~2 minutes, "Speaker: text" lines
}

export interface SuggestResult {
  text: string
  latencyMs: number
}

export interface ArtifactsInput {
  transcriptText: string
  contextText: string
}

export interface LlmClient {
  suggest(input: SuggestInput): Promise<SuggestResult>
  artifacts(input: ArtifactsInput): Promise<SessionArtifacts>
  summarizeContext(text: string): Promise<string>
}
