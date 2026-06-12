import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { ContextStore } from "./store"
import type { RepoIndexEntry } from "./types"

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"])

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".cs": "csharp",
}

export interface IndexResult {
  indexed: number
  skipped: number
}

export function isIgnoredPath(relPath: string): boolean {
  return relPath.split(path.sep).some((part) => IGNORED_DIRS.has(part))
}

export async function buildRepoIndex(cwd: string, store: ContextStore): Promise<IndexResult> {
  const entries: RepoIndexEntry[] = []
  let skipped = 0

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(cwd, abs)
      if (isIgnoredPath(rel)) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const stat = fs.statSync(abs)
      if (stat.size > 1_000_000) {
        skipped += 1
        continue
      }
      entries.push(indexFile(cwd, abs, stat))
    }
  }

  walk(cwd)
  store.replaceRepoIndex(cwd, entries)
  return { indexed: entries.length, skipped }
}

export function indexFile(cwd: string, absPath: string, stat = fs.statSync(absPath)): RepoIndexEntry {
  const pathRel = path.relative(cwd, absPath)
  const content = readText(absPath)
  const language = guessLanguage(pathRel)
  const parsed = parseLightweight(content, language)
  return {
    cwd,
    path: pathRel,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs),
    hash: createHash("sha256").update(content).digest("hex"),
    language,
    imports: parsed.imports,
    exports: parsed.exports,
    symbols: parsed.symbols,
  }
}

export function guessLanguage(filePath: string): string {
  return LANGUAGE_BY_EXT[path.extname(filePath).toLowerCase()] ?? "text"
}

function readText(absPath: string): string {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch {
    return ""
  }
}

function parseLightweight(
  content: string,
  language: string,
): {
  imports: string[]
  exports: string[]
  symbols: string[]
} {
  if (language !== "typescript" && language !== "javascript") return { imports: [], exports: [], symbols: [] }

  const imports = collect(content, [
    /^\s*import\s+(?:type\s+)?(?:.+?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+.+?\s+from\s+["']([^"']+)["']/gm,
    /^\s*const\s+\w+\s*=\s*require\(["']([^"']+)["']\)/gm,
  ])
  const exports = collect(content, [
    /^\s*export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
    /^\s*export\s*\{([^}]+)\}/gm,
  ]).flatMap((value) =>
    value.split(",").map(
      (part) =>
        part
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? "",
    ),
  )
  const symbols = collect(content, [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
    /^\s*(?:export\s+)?class\s+([A-Za-z0-9_$]+)/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/gm,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/gm,
  ])

  return {
    imports: unique(imports),
    exports: unique(exports.filter(Boolean)),
    symbols: unique(symbols),
  }
}

function collect(content: string, patterns: RegExp[]): string[] {
  const out: string[] = []
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) out.push(match[1])
    }
  }
  return out
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, 80)
}
