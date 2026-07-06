import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  ActionItem,
  ContextDoc,
  ContextDocInput,
  SessionDetail,
  SessionMeta,
  Suggestion,
  TranscriptChunk
} from '../../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scenario TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT,
  context_summary TEXT
);
CREATE TABLE IF NOT EXISTS transcript_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  ts_start INTEGER NOT NULL,
  ts_end INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON transcript_chunks(session_id, ts_end);
CREATE TABLE IF NOT EXISTS context_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  rating INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS action_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT
);
CREATE TABLE IF NOT EXISTS hotkey_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  pressed_at INTEGER NOT NULL,
  handled INTEGER NOT NULL DEFAULT 1
);
`

function rowToSession(r: any): SessionMeta {
  return {
    id: r.id,
    title: r.title,
    scenario: r.scenario,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    status: r.status,
    summary: r.summary ?? null,
    contextSummary: r.context_summary ?? null
  }
}

function rowToChunk(r: any): TranscriptChunk {
  return {
    id: r.id,
    sessionId: r.session_id,
    speaker: r.speaker,
    text: r.text,
    tsStart: r.ts_start,
    tsEnd: r.ts_end,
    createdAt: r.created_at
  }
}

function rowToSuggestion(r: any): Suggestion {
  return {
    id: r.id,
    sessionId: r.session_id,
    text: r.text,
    latencyMs: r.latency_ms,
    rating: r.rating,
    createdAt: r.created_at
  }
}

/**
 * Local-first SQLite storage. WAL mode + a write per finalized transcript
 * event gives crash-safe write-through (R7/edge cases: transcript must
 * survive `kill -9`).
 */
export class Store {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }

  // --- sessions ---

  createSession(input: { id: string; title: string; scenario: string; startedAt: number }): SessionMeta {
    this.db
      .prepare('INSERT INTO sessions (id, title, scenario, started_at, status) VALUES (?, ?, ?, ?, ?)')
      .run(input.id, input.title, input.scenario, input.startedAt, 'active')
    return this.getSession(input.id)!
  }

  getSession(id: string): SessionMeta | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    return r ? rowToSession(r) : null
  }

  listSessions(): SessionMeta[] {
    return this.db
      .prepare('SELECT * FROM sessions ORDER BY started_at DESC')
      .all()
      .map(rowToSession)
  }

  getActiveSessions(): SessionMeta[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC")
      .all()
      .map(rowToSession)
  }

  setContextSummary(sessionId: string, summary: string): void {
    this.db.prepare('UPDATE sessions SET context_summary = ? WHERE id = ?').run(summary, sessionId)
  }

  endSession(sessionId: string, endedAt: number, summary: string | null): void {
    this.db
      .prepare("UPDATE sessions SET status = 'ended', ended_at = ?, summary = ? WHERE id = ?")
      .run(endedAt, summary, sessionId)
  }

  /** One-click delete: removes every trace of a session (R8). */
  deleteSession(sessionId: string): void {
    const del = this.db.transaction((id: string) => {
      this.db.prepare('DELETE FROM transcript_chunks WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM context_docs WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM suggestions WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM action_items WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM hotkey_events WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    })
    del(sessionId)
  }

  // --- transcript ---

  appendChunk(
    sessionId: string,
    chunk: { speaker: string; text: string; tsStart: number; tsEnd: number }
  ): TranscriptChunk {
    const createdAt = Date.now()
    const info = this.db
      .prepare(
        'INSERT INTO transcript_chunks (session_id, speaker, text, ts_start, ts_end, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(sessionId, chunk.speaker, chunk.text, chunk.tsStart, chunk.tsEnd, createdAt)
    return { id: Number(info.lastInsertRowid), sessionId, createdAt, ...chunk }
  }

  getChunks(sessionId: string): TranscriptChunk[] {
    return this.db
      .prepare('SELECT * FROM transcript_chunks WHERE session_id = ? ORDER BY ts_end ASC, id ASC')
      .all(sessionId)
      .map(rowToChunk)
  }

  /**
   * Chunks in the trailing window (default ~2 min), measured against the
   * latest transcribed audio time — not wall clock — so a paused/lagging
   * stream still yields the most recent speech.
   */
  getRecentChunks(sessionId: string, windowMs: number): TranscriptChunk[] {
    const latest = this.db
      .prepare('SELECT MAX(ts_end) AS m FROM transcript_chunks WHERE session_id = ?')
      .get(sessionId) as { m: number | null }
    if (latest.m == null) return []
    const cutoff = latest.m - windowMs
    return this.db
      .prepare(
        'SELECT * FROM transcript_chunks WHERE session_id = ? AND ts_end >= ? ORDER BY ts_end ASC, id ASC'
      )
      .all(sessionId, cutoff)
      .map(rowToChunk)
  }

  // --- context docs ---

  addContextDoc(sessionId: string, doc: ContextDocInput): ContextDoc {
    const info = this.db
      .prepare('INSERT INTO context_docs (session_id, name, kind, content) VALUES (?, ?, ?, ?)')
      .run(sessionId, doc.name, doc.kind, doc.content)
    return { id: Number(info.lastInsertRowid), sessionId, ...doc }
  }

  getContextDocs(sessionId: string): ContextDoc[] {
    return this.db
      .prepare('SELECT * FROM context_docs WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId)
      .map((r: any) => ({ id: r.id, sessionId: r.session_id, name: r.name, kind: r.kind, content: r.content }))
  }

  // --- suggestions ---

  addSuggestion(sessionId: string, text: string, latencyMs: number): Suggestion {
    const createdAt = Date.now()
    const info = this.db
      .prepare('INSERT INTO suggestions (session_id, text, latency_ms, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, text, latencyMs, createdAt)
    return { id: Number(info.lastInsertRowid), sessionId, text, latencyMs, rating: 0, createdAt }
  }

  rateSuggestion(id: number, rating: number): void {
    this.db.prepare('UPDATE suggestions SET rating = ? WHERE id = ?').run(rating, id)
  }

  getSuggestions(sessionId: string): Suggestion[] {
    return this.db
      .prepare('SELECT * FROM suggestions WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId)
      .map(rowToSuggestion)
  }

  // --- action items ---

  addActionItems(sessionId: string, items: { text: string; owner?: string | null }[]): void {
    const stmt = this.db.prepare('INSERT INTO action_items (session_id, text, owner) VALUES (?, ?, ?)')
    const insertAll = this.db.transaction((rows: typeof items) => {
      for (const it of rows) stmt.run(sessionId, it.text, it.owner ?? null)
    })
    insertAll(items)
  }

  getActionItems(sessionId: string): ActionItem[] {
    return this.db
      .prepare('SELECT * FROM action_items WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId)
      .map((r: any) => ({ id: r.id, sessionId: r.session_id, text: r.text, owner: r.owner ?? null }))
  }

  // --- hotkey log (P2 dataset: every press, even ignored ones) ---

  logHotkey(sessionId: string | null, pressedAt: number, handled: boolean): void {
    this.db
      .prepare('INSERT INTO hotkey_events (session_id, pressed_at, handled) VALUES (?, ?, ?)')
      .run(sessionId, pressedAt, handled ? 1 : 0)
  }

  // --- aggregate ---

  getSessionDetail(sessionId: string): SessionDetail | null {
    const session = this.getSession(sessionId)
    if (!session) return null
    return {
      session,
      transcript: this.getChunks(sessionId),
      suggestions: this.getSuggestions(sessionId),
      contextDocs: this.getContextDocs(sessionId),
      actionItems: this.getActionItems(sessionId)
    }
  }

  close(): void {
    this.db.close()
  }
}
