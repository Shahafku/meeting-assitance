import type { SessionArtifacts } from '../../shared/types'
import type { ArtifactsInput, LlmClient, SuggestInput, SuggestResult } from './types'

/**
 * Deterministic LLM stand-in for tests and offline harness runs.
 * The suggestion echoes a line from the prep material so tests can verify
 * context grounding end-to-end (R3 acceptance analogue).
 */
export class MockLlm implements LlmClient {
  suggestCalls: SuggestInput[] = []
  delayMs: number

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0
  }

  async suggest(input: SuggestInput): Promise<SuggestResult> {
    this.suggestCalls.push(input)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    const contextFact =
      input.contextText.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#')) ??
      'your prep material'
    return {
      text: `Consider referencing: ${contextFact.trim().slice(0, 120)}`,
      latencyMs: this.delayMs
    }
  }

  async artifacts(input: ArtifactsInput): Promise<SessionArtifacts> {
    const lines = input.transcriptText.split('\n').filter((l) => l.trim() !== '')
    return {
      summary: `Mock summary of a meeting with ${lines.length} transcript lines.`,
      actionItems: [{ text: 'Follow up on the discussed topics', owner: 'Me' }]
    }
  }

  async summarizeContext(text: string): Promise<string> {
    return `Mock context summary (${text.length} chars compressed).`
  }
}
