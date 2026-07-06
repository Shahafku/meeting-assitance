import Anthropic from '@anthropic-ai/sdk'
import type { SessionArtifacts } from '../../shared/types'
import { capWords, extractJsonObject } from './text-utils'
import type { ArtifactsInput, LlmClient, SuggestInput, SuggestResult } from './types'

// Summon path needs speed (≤5s hotkey-to-render); artifacts can afford a larger model.
const SUGGEST_MODEL = process.env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001'
const ARTIFACT_MODEL = process.env.ARTIFACT_MODEL || 'claude-sonnet-5'
const MAX_SUGGESTION_WORDS = 60

const ARTIFACTS_SYSTEM = `You turn a raw meeting transcript into concise artifacts.
Respond with ONLY a JSON object, no prose, in this exact shape:
{"summary": "<5-10 sentence summary of the meeting>", "action_items": [{"text": "<the action>", "owner": "<who, if stated or clearly inferable, else null>"}]}
Only include action items that were actually agreed or clearly implied in the transcript. If there are none, use an empty array.`

const CONTEXT_SUMMARY_SYSTEM = `You compress meeting prep material. Preserve every concrete fact: names, titles, companies, products, numbers, dates, and the user's own talking points. Drop filler and repetition. Output plain text, at most ~800 words.`

export class AnthropicLlm implements LlmClient {
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async suggest(input: SuggestInput): Promise<SuggestResult> {
    const started = Date.now()
    const res = await this.client.messages.create({
      model: SUGGEST_MODEL,
      max_tokens: 200,
      system: input.systemPrompt,
      messages: [
        {
          role: 'user',
          content: `<prep_material>\n${input.contextText || '(no prep material provided)'}\n</prep_material>\n\n<transcript_last_2_minutes>\n${input.transcriptWindow || '(no speech captured yet)'}\n</transcript_last_2_minutes>\n\nGive me ONE suggestion right now.`
        }
      ]
    })
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join(' ')
    return { text: capWords(text, MAX_SUGGESTION_WORDS), latencyMs: Date.now() - started }
  }

  async artifacts(input: ArtifactsInput): Promise<SessionArtifacts> {
    const res = await this.client.messages.create({
      model: ARTIFACT_MODEL,
      max_tokens: 2000,
      system: ARTIFACTS_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `<prep_material>\n${input.contextText || '(none)'}\n</prep_material>\n\n<transcript>\n${input.transcriptText}\n</transcript>`
        }
      ]
    })
    const raw = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join(' ')
    const parsed = extractJsonObject(raw) as {
      summary?: string
      action_items?: { text?: string; owner?: string | null }[]
    } | null
    if (!parsed || typeof parsed.summary !== 'string') {
      // Degraded parse: keep the raw text as the summary rather than losing it.
      return { summary: raw.trim(), actionItems: [] }
    }
    return {
      summary: parsed.summary,
      actionItems: (parsed.action_items ?? [])
        .filter((it) => typeof it?.text === 'string' && it.text.trim() !== '')
        .map((it) => ({ text: it.text as string, owner: it.owner ?? null }))
    }
  }

  async summarizeContext(text: string): Promise<string> {
    const res = await this.client.messages.create({
      model: ARTIFACT_MODEL,
      max_tokens: 1500,
      system: CONTEXT_SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: text }]
    })
    return res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join(' ')
      .trim()
  }
}
