export type AnswerStyle = "question" | "change-summary" | "other"

const QUESTION_PREFIX =
  /^(how|what|why|where|when|which|who|is|are|can|does|do|did|could|would|should|explain|tell me|show me|walk me through)\b/
const CHANGE_PREFIX =
  /^(fix|implement|update|change|refactor|add|remove|rename|make|use|improve|ship|write|build|create|please fix|please implement)\b/

export function classifyAnswerStyle(text: string): AnswerStyle {
  const query = text.toLowerCase().trim()
  if (!query) return "other"

  if (QUESTION_PREFIX.test(query) || query.endsWith("?")) return "question"
  if (CHANGE_PREFIX.test(query)) return "change-summary"
  return "other"
}

export function buildAnswerStyleGuidance(text: string): string | undefined {
  switch (classifyAnswerStyle(text)) {
    case "question":
      return (
        "Answer this as a codebase question.\n" +
        "- First sentence: give the direct answer in plain English.\n" +
        "- Then add one short paragraph explaining why or how.\n" +
        "- Mention at most 1-2 file or function references, and only after the direct answer.\n" +
        "- Do not lead with type names, interfaces, or placeholder pseudo-code.\n" +
        '- Do not invent commands, modes, files, or behavior. If you infer something, label it as "inference" or "likely".'
      )
    case "change-summary":
      return (
        "Answer this as a completion summary.\n" +
        "- Start with the outcome in one sentence.\n" +
        "- Then briefly mention the most important behavior or code changed.\n" +
        '- End with verification, or clearly say "not run" if you did not verify.\n' +
        "- Avoid file-by-file dumps and changelog-style recaps."
      )
    case "other":
      return undefined
  }
}
