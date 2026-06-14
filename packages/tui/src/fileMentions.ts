const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"])
const MAX_FILES = 2000

let cachedCwd = ""
let cachedFiles: string[] = []

export async function scanProjectFiles(cwd: string): Promise<string[]> {
  if (cachedCwd === cwd && cachedFiles.length > 0) return cachedFiles

  const files: string[] = []
  try {
    for await (const file of new Bun.Glob("**/*").scan({ cwd, dot: false })) {
      // Skip files inside ignored directories
      const parts = file.split("/")
      if (parts.some((p) => IGNORED_DIRS.has(p))) continue
      files.push(file)
      if (files.length >= MAX_FILES) break
    }
    files.sort()
  } catch {
    // Return empty on scan failure; mention UI degrades gracefully
  }

  cachedCwd = cwd
  cachedFiles = files
  return files
}

export function filterFileMentions(files: string[], query: string): string[] {
  if (!query) return files.slice(0, 20)
  const q = query.toLowerCase()

  const scored = files
    .map((f) => ({ file: f, score: scoreMatch(f.toLowerCase(), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, 20).map((x) => x.file)
}

function scoreMatch(candidate: string, query: string): number {
  // Exact substring match in the filename gets the highest score
  const filename = candidate.split("/").pop() ?? candidate
  if (filename.includes(query)) return 100 + (20 - Math.min(filename.length, 20))
  // Substring match anywhere in the path
  if (candidate.includes(query)) return 50
  // Subsequence match in the filename
  if (subsequenceMatch(filename, query)) return 20
  // Subsequence match in the full path
  if (subsequenceMatch(candidate, query)) return 10
  return 0
}

function subsequenceMatch(str: string, query: string): boolean {
  let qi = 0
  for (let i = 0; i < str.length && qi < query.length; i++) {
    if (str[i] === query[qi]) qi++
  }
  return qi === query.length
}

/** Extract the @-mention query from a prompt string at a given caret offset.
 * Returns the query text (without the @) if an active @-mention is found, else null. */
export function extractMentionQuery(text: string, caretOffset: number): string | null {
  const before = text.slice(0, caretOffset)
  const atIdx = before.lastIndexOf("@")
  if (atIdx === -1) return null
  // No spaces allowed between @ and the caret (would close the mention)
  const fragment = before.slice(atIdx + 1)
  if (/\s/.test(fragment)) return null
  return fragment
}

/** Replace the @-mention at caretOffset with the chosen file path. */
export function applyMention(text: string, caretOffset: number, filePath: string): string {
  const before = text.slice(0, caretOffset)
  const after = text.slice(caretOffset)
  const atIdx = before.lastIndexOf("@")
  if (atIdx === -1) return text
  return `${before.slice(0, atIdx)}${filePath}${after}`
}

/** Compute the new caret offset after applying a mention. */
export function mentionCaretOffset(text: string, caretOffset: number, filePath: string): number {
  const before = text.slice(0, caretOffset)
  const atIdx = before.lastIndexOf("@")
  if (atIdx === -1) return caretOffset
  return atIdx + filePath.length
}
