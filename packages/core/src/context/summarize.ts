import fs from "node:fs"
import path from "node:path"
import { estimateTokens } from "./budget"
import { indexFile } from "./indexer"
import type { ContextStore } from "./store"
import type { FileSummary, RepoIndexEntry } from "./types"

export function getFileSummary(args: { cwd: string; path: string; store: ContextStore }): FileSummary {
  const rel = normalizeRel(args.cwd, args.path)
  const abs = path.resolve(args.cwd, rel)
  const entry = indexFile(args.cwd, abs)
  args.store.upsertIndexEntry(entry)

  const cached = args.store.getSummary(args.cwd, rel)
  if (cached && cached.hash === entry.hash) return cached

  const summary = summarizeEntry(abs, entry)
  args.store.upsertSummary(args.cwd, summary)
  return summary
}

export function summarizeEntry(absPath: string, entry: RepoIndexEntry): FileSummary {
  const content = fs.readFileSync(absPath, "utf8")
  const firstLines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("*"))
    .slice(0, 8)
    .join(" ")
  const parts = [
    `${entry.language} file, ${entry.size} bytes.`,
    entry.symbols.length ? `Defines ${entry.symbols.slice(0, 20).join(", ")}.` : "",
    entry.imports.length ? `Imports ${entry.imports.slice(0, 20).join(", ")}.` : "",
    firstLines ? `Excerpt: ${firstLines.slice(0, 600)}` : "",
  ].filter(Boolean)
  const summary = parts.join(" ")

  return {
    path: entry.path,
    hash: entry.hash,
    summary,
    symbols: entry.symbols,
    dependencies: entry.imports,
    lastSummarizedAt: Date.now(),
    tokenEstimate: estimateTokens(summary),
  }
}

function normalizeRel(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath
}
