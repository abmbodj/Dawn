import { describe, expect, test } from "bun:test"
import { buildAnswerStyleGuidance, classifyAnswerStyle } from "../src/agent/answer-style"

describe("classifyAnswerStyle", () => {
  test("classifies repo and code questions as question", () => {
    expect(classifyAnswerStyle("How does the savings box change as we work?")).toBe("question")
    expect(classifyAnswerStyle("Explain why this bug happened")).toBe("question")
    expect(classifyAnswerStyle("what does this repo do")).toBe("question")
  })

  test("classifies implementation requests as change-summary", () => {
    expect(classifyAnswerStyle("fix the savings color bug")).toBe("change-summary")
    expect(classifyAnswerStyle("implement the retry recovery flow")).toBe("change-summary")
    expect(classifyAnswerStyle("make the number orange")).toBe("change-summary")
  })

  test("classifies casual chatter as other", () => {
    expect(classifyAnswerStyle("hello there")).toBe("other")
    expect(classifyAnswerStyle("nice, thanks")).toBe("other")
    expect(classifyAnswerStyle("sounds good")).toBe("other")
  })
})

describe("buildAnswerStyleGuidance", () => {
  test("builds compact guidance for question answers", () => {
    const guidance = buildAnswerStyleGuidance("How does the savings box change as we work?")

    expect(guidance).toContain("Lead with the direct answer in plain English")
    expect(guidance).toContain("Don't lead with type names, interfaces, or placeholder pseudo-code.")
    expect(guidance).toContain("Don't invent commands, modes, files, or behavior.")
    expect(guidance).toContain("path:line")
    expect(guidance?.length ?? 0).toBeLessThan(600)
  })

  test("builds compact guidance for change summaries", () => {
    const guidance = buildAnswerStyleGuidance("fix the savings color bug")

    expect(guidance).toContain("One sentence on the outcome.")
    expect(guidance).toContain('End with what you ran to verify, or clearly say "not run"')
    expect(guidance).toContain("No file-by-file dumps")
    expect(guidance?.length ?? 0).toBeLessThan(500)
  })

  test("returns no extra guidance for other replies", () => {
    expect(buildAnswerStyleGuidance("hello there")).toBeUndefined()
  })
})
