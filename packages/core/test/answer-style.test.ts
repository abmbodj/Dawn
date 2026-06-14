import { describe, expect, test } from "bun:test"
import {
  buildAnswerStyleGuidance,
  buildTurnGuidance,
  classifyAnswerStyle,
  hasUrl,
  needsFreshExternalInfo,
} from "../src/agent/answer-style"

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

  test("classifies review requests as review", () => {
    expect(classifyAnswerStyle("review this diff")).toBe("review")
    expect(classifyAnswerStyle("audit the auth flow")).toBe("review")
    expect(classifyAnswerStyle("look for bugs in the retry logic")).toBe("review")
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

  test("builds compact guidance for review answers", () => {
    const guidance = buildAnswerStyleGuidance("review this PR")

    expect(guidance).toContain("lead with findings")
    expect(guidance).toContain("Order findings by severity")
    expect(guidance).toContain("path:line")
    expect(guidance?.length ?? 0).toBeLessThan(400)
  })

  test("returns no extra guidance for other replies", () => {
    expect(buildAnswerStyleGuidance("hello there")).toBeUndefined()
  })
})

describe("buildTurnGuidance", () => {
  test("detects URL references and asks for exact fetch", () => {
    const guidance = buildTurnGuidance("How can we use https://example.com/spec.md here?")

    expect(hasUrl("see https://example.com/spec.md")).toBe(true)
    expect(guidance).toContain("Use web_fetch on the exact URL")
    expect(guidance).toContain("don't imply you read it")
  })

  test("detects latest/current external facts and asks for search", () => {
    const guidance = buildTurnGuidance("What is the latest TypeScript release?", {
      currentDate: "2026-06-14",
    })

    expect(needsFreshExternalInfo("current pricing")).toBe(true)
    expect(guidance).toContain("Today is 2026-06-14")
    expect(guidance).toContain("Use web_search for current info")
  })

  test("keeps repo questions grounded in source", () => {
    const guidance = buildTurnGuidance("How does the savings box change as we work?")

    expect(guidance).toContain("This is a codebase question")
    expect(guidance).toContain("path:line")
  })

  test("keeps implementation requests terse at close", () => {
    const guidance = buildTurnGuidance("implement the retry recovery flow")

    expect(guidance).toContain("close with a sign-off")
    expect(guidance).toContain("what you ran to verify")
  })

  test("keeps review requests finding-first", () => {
    const guidance = buildTurnGuidance("review this change")

    expect(guidance).toContain("lead with findings")
    expect(guidance).toContain("If you find no issues")
  })

  test("does not add guidance for casual prompts", () => {
    expect(buildTurnGuidance("hello there")).toBeUndefined()
  })
})
