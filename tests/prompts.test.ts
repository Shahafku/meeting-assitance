import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPresets, loadPreset } from '../src/main/prompts'

const PROMPTS_DIR = resolve(__dirname, '../prompts')

describe('presets', () => {
  it('ships at least the two v1 presets (R4)', () => {
    const ids = listPresets(PROMPTS_DIR).map((p) => p.id)
    expect(ids).toContain('interview')
    expect(ids).toContain('general')
  })

  it('every preset carries the anti-hallucination guard and the word cap (R3/R5)', () => {
    for (const p of listPresets(PROMPTS_DIR)) {
      const content = loadPreset(PROMPTS_DIR, p.id)
      expect(content).toContain('Maximum 50 words')
      expect(content.toLowerCase()).toContain('never invent')
    }
  })

  it('presets differ in style rules (switching preset changes behavior)', () => {
    expect(loadPreset(PROMPTS_DIR, 'interview')).not.toBe(loadPreset(PROMPTS_DIR, 'general'))
  })

  it('rejects path-traversal preset ids', () => {
    expect(() => loadPreset(PROMPTS_DIR, '../secret')).toThrow()
  })
})
