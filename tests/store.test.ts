import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store/store'

let dir: string
let dbPath: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-store-'))
  dbPath = join(dir, 'test.db')
  store = new Store(dbPath)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function makeSession(id = 's1') {
  return store.createSession({ id, title: 'Test', scenario: 'interview', startedAt: Date.now() })
}

describe('Store', () => {
  it('write-through: chunks survive reopening the database (crash analogue)', () => {
    makeSession()
    store.appendChunk('s1', { speaker: 'Me', text: 'hello', tsStart: 0, tsEnd: 1000 })
    store.appendChunk('s1', { speaker: 'Speaker 1', text: 'hi there', tsStart: 1000, tsEnd: 2000 })
    // Simulate abrupt death: reopen without any explicit save/flush call.
    store.close()
    store = new Store(dbPath)
    const chunks = store.getChunks('s1')
    expect(chunks).toHaveLength(2)
    expect(chunks[1].speaker).toBe('Speaker 1')
    expect(store.getActiveSessions()).toHaveLength(1)
  })

  it('getRecentChunks windows against latest audio time, not wall clock', () => {
    makeSession()
    store.appendChunk('s1', { speaker: 'Me', text: 'old', tsStart: 0, tsEnd: 10_000 })
    store.appendChunk('s1', { speaker: 'Me', text: 'mid', tsStart: 100_000, tsEnd: 110_000 })
    store.appendChunk('s1', { speaker: 'Me', text: 'new', tsStart: 200_000, tsEnd: 210_000 })
    const recent = store.getRecentChunks('s1', 120_000)
    expect(recent.map((c) => c.text)).toEqual(['mid', 'new'])
  })

  it('getRecentChunks returns empty for a session with no speech', () => {
    makeSession()
    expect(store.getRecentChunks('s1', 120_000)).toEqual([])
  })

  it('deleteSession removes every trace (R8)', () => {
    makeSession()
    store.appendChunk('s1', { speaker: 'Me', text: 'x', tsStart: 0, tsEnd: 1 })
    store.addContextDoc('s1', { name: 'cv', kind: 'paste', content: 'stuff' })
    store.addSuggestion('s1', 'try this', 1200)
    store.addActionItems('s1', [{ text: 'do it', owner: 'Me' }])
    store.logHotkey('s1', Date.now(), true)
    store.deleteSession('s1')
    expect(store.getSession('s1')).toBeNull()
    expect(store.getChunks('s1')).toEqual([])
    expect(store.getContextDocs('s1')).toEqual([])
    expect(store.getSuggestions('s1')).toEqual([])
    expect(store.getActionItems('s1')).toEqual([])
  })

  it('suggestion rating round-trips', () => {
    makeSession()
    const s = store.addSuggestion('s1', 'idea', 900)
    store.rateSuggestion(s.id, 1)
    expect(store.getSuggestions('s1')[0].rating).toBe(1)
  })

  it('session lifecycle: end stores summary and flips status', () => {
    makeSession()
    store.endSession('s1', Date.now(), 'we talked')
    const s = store.getSession('s1')!
    expect(s.status).toBe('ended')
    expect(s.summary).toBe('we talked')
    expect(store.getActiveSessions()).toHaveLength(0)
  })
})
