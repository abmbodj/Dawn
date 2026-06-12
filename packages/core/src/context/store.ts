import { Database } from "bun:sqlite"
import path from "node:path"
import { dataDir } from "../paths"
import type { ContextPlan, FileSummary, RepoIndexEntry, RepoIndexStatus } from "./types"

export class ContextStore {
  private db: Database

  constructor(dbPath: string = path.join(dataDir(), "dawn.db")) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_index (
        cwd TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        hash TEXT NOT NULL,
        language TEXT NOT NULL,
        imports_json TEXT NOT NULL,
        exports_json TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (cwd, path)
      );
      CREATE TABLE IF NOT EXISTS repo_index_meta (
        cwd TEXT PRIMARY KEY,
        indexed_files INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_summaries (
        cwd TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        last_summarized_at INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL,
        PRIMARY KEY (cwd, path)
      );
      CREATE TABLE IF NOT EXISTS context_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        ts INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `)
  }

  replaceRepoIndex(cwd: string, entries: RepoIndexEntry[]): void {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM repo_index WHERE cwd = ?").run(cwd)
      const insert = this.db.query(
        `INSERT INTO repo_index
         (cwd, path, size, mtime, hash, language, imports_json, exports_json, symbols_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const entry of entries) {
        insert.run(
          cwd,
          entry.path,
          entry.size,
          entry.mtime,
          entry.hash,
          entry.language,
          JSON.stringify(entry.imports),
          JSON.stringify(entry.exports),
          JSON.stringify(entry.symbols),
          now,
        )
      }
      this.db
        .query("INSERT OR REPLACE INTO repo_index_meta (cwd, indexed_files, updated_at) VALUES (?, ?, ?)")
        .run(cwd, entries.length, now)
    })
    tx()
  }

  upsertIndexEntry(entry: RepoIndexEntry): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO repo_index
         (cwd, path, size, mtime, hash, language, imports_json, exports_json, symbols_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.cwd,
        entry.path,
        entry.size,
        entry.mtime,
        entry.hash,
        entry.language,
        JSON.stringify(entry.imports),
        JSON.stringify(entry.exports),
        JSON.stringify(entry.symbols),
        Date.now(),
      )
  }

  getIndexEntry(cwd: string, filePath: string): RepoIndexEntry | undefined {
    const row = this.db.query("SELECT * FROM repo_index WHERE cwd = ? AND path = ?").get(cwd, filePath) as any
    return row ? rowToEntry(row) : undefined
  }

  relevantEntries(cwd: string, query: string, limit = 8): RepoIndexEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((term) => term.length >= 3)
      .slice(0, 20)
    if (terms.length === 0) return []

    const rows = this.db.query("SELECT * FROM repo_index WHERE cwd = ? LIMIT 2000").all(cwd) as any[]
    return rows
      .map(rowToEntry)
      .map((entry) => {
        const haystack = `${entry.path} ${entry.symbols.join(" ")} ${entry.imports.join(" ")}`.toLowerCase()
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
        return { entry, score }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
      .slice(0, limit)
      .map((item) => item.entry)
  }

  indexStatus(cwd: string): RepoIndexStatus {
    const row = this.db
      .query("SELECT indexed_files, updated_at FROM repo_index_meta WHERE cwd = ?")
      .get(cwd) as { indexed_files: number; updated_at: number } | undefined
    if (!row) return { cwd, indexedFiles: 0 }
    return { cwd, indexedFiles: row.indexed_files, updatedAt: row.updated_at }
  }

  upsertSummary(cwd: string, summary: FileSummary): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO file_summaries
         (cwd, path, hash, summary, symbols_json, dependencies_json, last_summarized_at, token_estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cwd,
        summary.path,
        summary.hash,
        summary.summary,
        JSON.stringify(summary.symbols),
        JSON.stringify(summary.dependencies),
        summary.lastSummarizedAt,
        summary.tokenEstimate,
      )
  }

  getSummary(cwd: string, filePath: string): FileSummary | undefined {
    const row = this.db
      .query("SELECT * FROM file_summaries WHERE cwd = ? AND path = ?")
      .get(cwd, filePath) as any
    return row ? rowToSummary(row) : undefined
  }

  summaryCount(cwd: string): number {
    const row = this.db.query("SELECT COUNT(*) n FROM file_summaries WHERE cwd = ?").get(cwd) as { n: number }
    return row.n
  }

  recordContextPlan(sessionId: string | undefined, plan: ContextPlan): void {
    this.db
      .query("INSERT INTO context_plans (session_id, ts, json) VALUES (?, ?, ?)")
      .run(sessionId ?? null, Date.now(), JSON.stringify(plan))
  }

  close(): void {
    this.db.close()
  }
}

function rowToEntry(row: any): RepoIndexEntry {
  return {
    cwd: row.cwd,
    path: row.path,
    size: row.size,
    mtime: row.mtime,
    hash: row.hash,
    language: row.language,
    imports: JSON.parse(row.imports_json),
    exports: JSON.parse(row.exports_json),
    symbols: JSON.parse(row.symbols_json),
  }
}

function rowToSummary(row: any): FileSummary {
  return {
    path: row.path,
    hash: row.hash,
    summary: row.summary,
    symbols: JSON.parse(row.symbols_json),
    dependencies: JSON.parse(row.dependencies_json),
    lastSummarizedAt: row.last_summarized_at,
    tokenEstimate: row.token_estimate,
  }
}
