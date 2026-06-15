export interface ParsedFrontmatter {
  frontmatter: Record<string, string | string[]>
  body: string
}

/**
 * Parses a leading YAML-style frontmatter block (---\n…\n---\n).
 * Only handles the flat keys used by SKILL.md: name, description, allowed-tools.
 * Returns body="" and empty frontmatter if no block is found.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith("---")) return { frontmatter: {}, body: raw }

  const end = trimmed.indexOf("\n---", 3)
  if (end === -1) return { frontmatter: {}, body: raw }

  const block = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 4).trimStart()
  const frontmatter: Record<string, string | string[]> = {}

  for (const line of block.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!key) continue
    // Inline list: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      frontmatter[key] = value
    }
  }

  return { frontmatter, body }
}
