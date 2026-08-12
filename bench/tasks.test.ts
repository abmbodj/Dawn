import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { TASKS } from "./tasks"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, "..")

/**
 * Read the pinned fixture out of run.ts rather than importing it: run.ts executes the
 * whole benchmark on import.
 */
function fixtureRef(): string {
  const src = fs.readFileSync(path.join(HERE, "run.ts"), "utf8")
  const m = src.match(/const FIXTURE_REF = "([^"]+)"/)
  if (!m?.[1]) throw new Error("FIXTURE_REF not found in bench/run.ts")
  return m[1]
}

function existsAtRef(ref: string, rel: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${ref}:${rel}`], { cwd: REPO }).status === 0
}

function promptsOf(t: (typeof TASKS)[number]): string[] {
  return t.prompts && t.prompts.length > 0 ? t.prompts : [t.prompt]
}

describe("bench tasks", () => {
  test("task ids are unique", () => {
    const ids = TASKS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * The fixture is pinned to an old commit, so a task can reference a file that exists
   * today and not at the fixture — the task then fails for a reason that has nothing to
   * do with context management. This caught `MAX_TOOL_RESULT_ITEMS` (added after the
   * pinned ref) being used as a horizon-task target.
   */
  test("every repo path a prompt names exists at the pinned fixture", () => {
    const ref = fixtureRef()
    const missing: string[] = []
    for (const task of TASKS) {
      for (const prompt of promptsOf(task)) {
        for (const m of prompt.matchAll(/\b(packages\/[\w./-]+\.\w+)/g)) {
          const rel = m[1] as string
          if (!existsAtRef(ref, rel)) missing.push(`${task.id}: ${rel}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("horizon tasks are actually long-horizon and structurally checked", () => {
    const horizon = TASKS.filter((t) => t.slice === "horizon")
    expect(horizon.length).toBeGreaterThan(0)
    for (const t of horizon) {
      // The point of the slice is session length; a short one measures nothing.
      expect(promptsOf(t).length).toBeGreaterThanOrEqual(8)
      // The load-bearing question must come last, after the session has grown.
      expect(typeof t.check).toBe("function")
    }
  })
})
