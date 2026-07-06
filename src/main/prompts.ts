import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PresetInfo } from '../shared/types'

/**
 * Scenario presets are plain markdown files in /prompts — editable config,
 * not code (product principle #4). Files are re-read on every summon, which
 * makes them hot-reloadable for free.
 */
export function listPresets(promptsDir: string): PresetInfo[] {
  return readdirSync(promptsDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const id = f.replace(/\.md$/, '')
      const firstLine = readFileSync(join(promptsDir, f), 'utf8').split('\n')[0] ?? ''
      const title = firstLine.replace(/^#\s*/, '').trim() || id
      return { id, title }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function loadPreset(promptsDir: string, id: string): string {
  // Preset ids come from listPresets/UI; guard against path tricks anyway.
  if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid preset id: ${id}`)
  return readFileSync(join(promptsDir, `${id}.md`), 'utf8')
}
