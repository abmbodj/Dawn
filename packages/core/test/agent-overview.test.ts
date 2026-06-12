import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isRepoOverviewQuestion } from "../src/agent/agent"
import { buildSystemPrompt } from "../src/agent/system"
import { buildRepoOverview } from "../src/tools/index"

describe("repo overview intent", () => {
  test("matches broad repository overview questions", () => {
    expect(isRepoOverviewQuestion("what is this project?")).toBe(true)
    expect(isRepoOverviewQuestion("summarize this repo")).toBe(true)
    expect(isRepoOverviewQuestion("what does this codebase do?")).toBe(true)
    expect(isRepoOverviewQuestion("give me an overview of this repository")).toBe(true)
  })

  test("does not match greetings or general programming questions", () => {
    expect(isRepoOverviewQuestion("hello")).toBe(false)
    expect(isRepoOverviewQuestion("what is TypeScript?")).toBe(false)
    expect(isRepoOverviewQuestion("write a function to reverse a string")).toBe(false)
    expect(isRepoOverviewQuestion("what is this?")).toBe(false)
  })
})

describe("system prompt repo questions", () => {
  test("instructs Dawn to inspect the repo before answering codebase questions", () => {
    const prompt = buildSystemPrompt(process.cwd())

    expect(prompt).toContain("Treat questions about this repository")
    expect(prompt).toContain("Inspect the repo before answering")
    expect(prompt).toContain("Answer the user's actual question first")
    expect(prompt).toContain("plain English")
    expect(prompt).toContain("Never invent commands, modes, files, behavior, or placeholder pseudo-code")
    expect(prompt).toContain("Separate verified facts from inference")
    expect(prompt).not.toContain("questions, and conversational messages without calling any tools")
  })
})

describe("buildRepoOverview", () => {
  let tmp: string
  let repo: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-overview-"))
    repo = path.join(tmp, "repo")
    fs.mkdirSync(path.join(repo, "packages", "core"), { recursive: true })
    fs.writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify(
        {
          name: "sample",
          version: "1.2.3",
          private: true,
          description: "sample repo",
          workspaces: ["packages/*"],
          scripts: { test: "bun test", typecheck: "tsc --noEmit" },
          dependencies: { "@ai-sdk/openai": "^1.0.0" },
          devDependencies: { typescript: "^5.0.0" },
        },
        null,
        2,
      ),
    )
    fs.writeFileSync(
      path.join(repo, "packages", "core", "package.json"),
      JSON.stringify({ name: "@sample/core", description: "core package", scripts: { test: "bun test" } }),
    )
    fs.writeFileSync(path.join(repo, "README.md"), "# Sample\n\nThis repository is a test fixture.\n")
    fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}\n")
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("returns a compact project snapshot from manifests and README", () => {
    const overview = buildRepoOverview(repo)

    expect(overview).toContain(`Project overview for ${repo}`)
    expect(overview).toContain("package.json:")
    expect(overview).toContain("name: sample")
    expect(overview).toContain("workspaces: packages/*")
    expect(overview).toContain("scripts: test, typecheck")
    expect(overview).toContain("dependencies: @ai-sdk/openai, typescript")
    expect(overview).toContain("Workspace packages:")
    expect(overview).toContain("packages/core: @sample/core - core package")
    expect(overview).toContain("Detected manifests:")
    expect(overview).toContain("tsconfig.json")
    expect(overview).toContain("README excerpt:")
    expect(overview).toContain("This repository is a test fixture.")
  })
})
