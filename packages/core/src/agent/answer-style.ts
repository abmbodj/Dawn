export type AnswerStyle = "question" | "change-summary" | "review" | "other"

export interface TurnGuidanceOptions {
  currentDate?: string
}

const QUESTION_PREFIX =
  /^(how|what|why|where|when|which|who|is|are|can|does|do|did|could|would|should|explain|tell me|show me|walk me through)\b/
const CHANGE_PREFIX =
  /^(fix|implement|update|change|refactor|add|remove|rename|make|use|improve|ship|write|build|create|please fix|please implement)\b/
const REVIEW_PREFIX = /^(review|code review|audit|inspect|look for bugs|find bugs|check this)\b/
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/i
const FRESHNESS_PATTERN =
  /\b(latest|current|currently|recent|recently|today|tonight|newest|now|up[- ]to[- ]date|this week|this month|this year)\b/i

export function classifyAnswerStyle(text: string): AnswerStyle {
  const query = text.toLowerCase().trim()
  if (!query) return "other"

  if (REVIEW_PREFIX.test(query)) return "review"
  if (QUESTION_PREFIX.test(query) || query.endsWith("?")) return "question"
  if (CHANGE_PREFIX.test(query)) return "change-summary"
  return "other"
}

export function buildAnswerStyleGuidance(text: string): string | undefined {
  switch (classifyAnswerStyle(text)) {
    case "question":
      return (
        "This is a codebase question — answer it like a colleague who just looked.\n" +
        "- Lead with the direct answer in plain English, then one short paragraph on why or how.\n" +
        "- Cite specific code as `path:line` (e.g. `agent.ts:109`) when pointing at something concrete.\n" +
        "- Mention at most 1-2 references, and only after the direct answer.\n" +
        "- Don't lead with type names, interfaces, or placeholder pseudo-code.\n" +
        '- Don\'t invent commands, modes, files, or behavior. If you infer something, label it "inference" or "likely".'
      )
    case "change-summary":
      return (
        "You've been narrating as you worked, so close with a sign-off, not a report.\n" +
        "- One sentence on the outcome. For a trivial change, that's enough — or just stop.\n" +
        "- If it's useful, add one line on the key behavior or code that changed (with a `path:line` cite).\n" +
        '- End with what you ran to verify, or clearly say "not run" if you didn\'t.\n' +
        "- No file-by-file dumps, bullet lists of changes, or changelog-style recaps."
      )
    case "review":
      return (
        "This is a code review — lead with findings, not a summary.\n" +
        "- Order findings by severity and cite `path:line` for each concrete issue.\n" +
        "- Explain the risk and the smallest plausible fix direction.\n" +
        "- If you find no issues, say that clearly and mention any test gaps or residual risk.\n" +
        "- Keep change summaries secondary."
      )
    case "other":
      return undefined
  }
}

export function buildTurnGuidance(text: string, opts: TurnGuidanceOptions = {}): string | undefined {
  const parts: string[] = []

  if (hasUrl(text)) {
    parts.push(
      "The user referenced a URL. Use web_fetch on the exact URL before relying on its contents. " +
        "If it can't be fetched, say so and don't imply you read it. " +
        "Summarize what you find in your own words; quote at most a line or two.",
    )
  }

  if (needsFreshExternalInfo(text)) {
    const date = opts.currentDate ? ` Today is ${opts.currentDate}.` : ""
    parts.push(
      `The user may need current external facts.${date} Use web_search for current info, or web_fetch ` +
        "when an exact source URL is available. If search is not configured, say that and answer only " +
        "from verified local or fetched sources.",
    )
  }

  const style = buildAnswerStyleGuidance(text)
  if (style) parts.push(style)

  return parts.length ? parts.join("\n\n") : undefined
}

export function hasUrl(text: string): boolean {
  return URL_PATTERN.test(text)
}

export function needsFreshExternalInfo(text: string): boolean {
  return FRESHNESS_PATTERN.test(text)
}
