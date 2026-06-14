import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadProjectMemory } from "../src/agent/project-memory"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-pm-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

describe("loadProjectMemory", () => {
  test("returns empty when no memory files exist", () => {
    const result = loadProjectMemory(tmpDir)
    expect(result.text).toBe("")
    expect(result.sources).toHaveLength(0)
  })

  test("loads AGENTS.md from cwd", () => {
    write(path.join(tmpDir, "AGENTS.md"), "Use British spelling.")
    const result = loadProjectMemory(tmpDir)
    expect(result.text).toContain("Use British spelling.")
    expect(result.sources).toContain("AGENTS.md")
  })

  test("loads DAWN.md from cwd", () => {
    write(path.join(tmpDir, "DAWN.md"), "Prefer functional style.")
    const result = loadProjectMemory(tmpDir)
    expect(result.text).toContain("Prefer functional style.")
    expect(result.sources).toContain("DAWN.md")
  })

  test("loads both AGENTS.md and DAWN.md and separates them with headers", () => {
    write(path.join(tmpDir, "AGENTS.md"), "Rule A")
    write(path.join(tmpDir, "DAWN.md"), "Rule B")
    const result = loadProjectMemory(tmpDir)
    expect(result.text).toContain("Rule A")
    expect(result.text).toContain("Rule B")
    expect(result.sources).toHaveLength(2)
    // Includes per-source headers
    expect(result.text).toContain("<!-- AGENTS.md -->")
    expect(result.text).toContain("<!-- DAWN.md -->")
  })

  test("loads from subdirectory, picking up parent AGENTS.md", () => {
    // Init a git repo so the walk can find the repo root
    Bun.spawnSync(["git", "init"], { cwd: tmpDir })
    write(path.join(tmpDir, "AGENTS.md"), "Parent rule")
    const subdir = path.join(tmpDir, "packages", "core")
    fs.mkdirSync(subdir, { recursive: true })
    // sub-project has its own DAWN.md
    write(path.join(subdir, "DAWN.md"), "Sub rule")
    const result = loadProjectMemory(subdir)
    expect(result.text).toContain("Parent rule")
    expect(result.text).toContain("Sub rule")
    // Parent comes first (less-specific)
    expect(result.text.indexOf("Parent rule")).toBeLessThan(result.text.indexOf("Sub rule"))
  })

  test("skips empty files", () => {
    write(path.join(tmpDir, "AGENTS.md"), "   ")
    const result = loadProjectMemory(tmpDir)
    expect(result.text).toBe("")
    expect(result.sources).toHaveLength(0)
  })

  test("caps total content to avoid blowing token budget", () => {
    // Write a very large AGENTS.md (>8000 chars)
    write(path.join(tmpDir, "AGENTS.md"), "x".repeat(10_000))
    const result = loadProjectMemory(tmpDir)
    // The text (including header) should not exceed MAX_MEMORY_CHARS significantly
    expect(result.text.length).toBeLessThan(9000)
    expect(result.sources).toHaveLength(1)
  })
})
