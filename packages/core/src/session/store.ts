import { Database } from "bun:sqlite"
import path from "node:path"
import type { ModelMessage } from "ai"
import type { StepUsage } from "../bus/bus"
import { dataDir } from "../paths"
import type { UsageTotals } from "../usage/ledger"

export interface SessionMeta {
  id: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
}

export class SessionStore {
  private db: Database

  constructor(dbPath: string = path.join(dataDir(), "dawn.db")) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        idx INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, idx)
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        ts INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost REAL NOT NULL
      );
    `)
  }

  createSession(cwd: string, title = ""): SessionMeta {
    const now = Date.now()
    const id = crypto.randomUUID()
    this.db
      .query("INSERT INTO sessions (id, cwd, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, cwd, title, now, now)
    return { id, cwd, title, createdAt: now, updatedAt: now }
  }

  lastSession(cwd?: string): SessionMeta | undefined {
    const row = cwd
      ? this.db.query("SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1").get(cwd)
      : this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 1").get()
    return row ? rowToMeta(row as any) : undefined
  }

  sessionsForCwd(cwd: string): SessionMeta[] {
    const rows = this.db
      .query("SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC")
      .all(cwd) as any[]
    return rows.map(rowToMeta)
  }

  allSessions(): SessionMeta[] {
    const rows = this.db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[]
    return rows.map(rowToMeta)
  }

  setTitle(sessionId: string, title: string): void {
    this.db.query("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId)
  }

  /** Replace-all persistence: simple and always consistent with in-memory state. */
  saveMessages(sessionId: string, messages: ModelMessage[]): void {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId)
      const insert = this.db.query("INSERT INTO messages (session_id, idx, json) VALUES (?, ?, ?)")
      messages.forEach((m, i) => {
        insert.run(sessionId, i, JSON.stringify(m))
      })
      this.db.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionId)
    })
    tx()
  }

  loadMessages(sessionId: string): ModelMessage[] {
    const rows = this.db
      .query("SELECT json FROM messages WHERE session_id = ? ORDER BY idx")
      .all(sessionId) as { json: string }[]
    return rows.map((r) => JSON.parse(r.json))
  }

  recordUsage(sessionId: string, step: StepUsage): void {
    this.db
      .query(
        `INSERT INTO usage (session_id, ts, provider_id, model_id, input_tokens, output_tokens,
         cached_input_tokens, cache_write_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        Date.now(),
        step.providerId,
        step.modelId,
        step.inputTokens,
        step.outputTokens,
        step.cachedInputTokens,
        step.cacheWriteTokens,
        step.cost,
      )
  }

  usageTotals(sessionId: string): UsageTotals {
    return this.usageTotalsWhere("usage.session_id = ?", [sessionId])
  }

  usageTotalsForCwd(cwd: string): UsageTotals {
    return this.usageTotalsWhere("sessions.cwd = ?", [cwd])
  }

  usageTotalsAll(): UsageTotals {
    return this.usageTotalsWhere()
  }

  close(): void {
    this.db.close()
  }

  private usageTotalsWhere(where?: string, params: Array<string | number> = []): UsageTotals {
    const whereClause = where ? ` WHERE ${where}` : ""
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o,
         COALESCE(SUM(cached_input_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw,
         COALESCE(SUM(cost),0) c, COUNT(usage.id) n
         FROM usage JOIN sessions ON sessions.id = usage.session_id${whereClause}`,
      )
      .get(...params) as { i: number; o: number; cr: number; cw: number; c: number; n: number }
    return {
      inputTokens: row.i,
      outputTokens: row.o,
      cachedInputTokens: row.cr,
      cacheWriteTokens: row.cw,
      cost: row.c,
      steps: row.n,
    }
  }
}

function rowToMeta(row: {
  id: string
  cwd: string
  title: string
  created_at: number
  updated_at: number
}): SessionMeta {
  return { id: row.id, cwd: row.cwd, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}
