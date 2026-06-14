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
    case "other":
      return undefined
  }
}
