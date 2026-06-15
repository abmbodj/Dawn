import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SkillBuffer } from "../src/skills/buffer"
import { parseFrontmatter } from "../src/skills/frontmatter"
import { buildSkillCatalog, discoverSkills, matchAutoTriggers } from "../src/skills/registry"
import type { Skill } from "../src/skills/types"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-skills-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeSkill(base: string, name: string, content: string) {
  const dir = path.join(base, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content)
}

// ─── parseFrontmatter ───────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses basic frontmatter", () => {
    const raw = `---
name: my-skill
description: Does something useful
---
Body text here.`
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter.name).toBe("my-skill")
    expect(frontmatter.description).toBe("Does something useful")
    expect(body).toBe("Body text here.")
  })

  test("parses inline list for allowed-tools", () => {
    const raw = `---
name: foo
description: test
allowed-tools: [bash, read]
---
body`
    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter["allowed-tools"]).toEqual(["bash", "read"])
  })

  test("returns empty frontmatter and original text when no block", () => {
    const raw = "just a body"
    const { frontmatter, body } = parseFrontmatter(raw)
    expect(frontmatter).toEqual({})
    expect(body).toBe("just a body")
  })

  test("handles missing closing delimiter gracefully", () => {
    const raw = "---\nname: broken\n"
    const { frontmatter } = parseFrontmatter(raw)
    expect(frontmatter).toEqual({})
  })
})

// ─── discoverSkills ─────────────────────────────────────────────────────────

describe("discoverSkills", () => {
  test("discovers project skills from .dawn/skills", () => {
    writeSkill(
      path.join(tmpDir, ".dawn", "skills"),
      "commit-helper",
      `---
name: commit-helper
description: Write conventional commit messages
---
Follow conventional commits spec.`,
    )
    const skills = discoverSkills(tmpDir)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe("commit-helper")
    expect(skills[0]?.source).toBe("project")
    expect(skills[0]?.body).toContain("conventional commits")
  })

  test("skips skills without a description", () => {
    writeSkill(
      path.join(tmpDir, ".dawn", "skills"),
      "no-desc",
      `---
name: no-desc
---
Body without description.`,
    )
    const skills = discoverSkills(tmpDir)
    expect(skills).toHaveLength(0)
  })

  test("project skills override personal skills on name collision", () => {
    const personalSkillsDir = path.join(tmpDir, "personal-skills")
    const cwd = path.join(tmpDir, "project")
    fs.mkdirSync(cwd, { recursive: true })
    writeSkill(
      personalSkillsDir,
      "shared",
      "---\nname: shared\ndescription: personal version\n---\npersonal body",
    )
    writeSkill(
      path.join(cwd, ".dawn", "skills"),
      "shared",
      "---\nname: shared\ndescription: project version\n---\nproject body",
    )
    // Override configDir to point at our tmp personal skills dir
    const origEnv = process.env.DAWN_CONFIG_DIR
    process.env.DAWN_CONFIG_DIR = personalSkillsDir
    try {
      const skills = discoverSkills(cwd)
      const shared = skills.find((s) => s.name === "shared")
      expect(shared?.source).toBe("project")
      expect(shared?.body).toContain("project body")
    } finally {
      if (origEnv === undefined) {
        delete process.env.DAWN_CONFIG_DIR
      } else {
        process.env.DAWN_CONFIG_DIR = origEnv
      }
    }
  })

  test("plugin skills are included", () => {
    const pluginSkill: Skill = {
      name: "plugin-tool",
      description: "Does plugin things",
      body: "Plugin instructions.",
      dir: "/fake/plugin/skills/plugin-tool",
      source: "plugin",
      pluginName: "my-plugin",
      estimatedBodyTokens: 10,
    }
    const skills = discoverSkills(tmpDir, { pluginSkills: [pluginSkill] })
    expect(skills.some((s) => s.name === "plugin-tool")).toBe(true)
  })
})

// ─── buildSkillCatalog ──────────────────────────────────────────────────────

describe("buildSkillCatalog", () => {
  test("returns empty string when no skills", () => {
    expect(buildSkillCatalog([])).toBe("")
  })

  test("renders catalog with all skill names and descriptions", () => {
    const skills: Skill[] = [
      { name: "a", description: "Does A", body: "", dir: "", source: "project", estimatedBodyTokens: 0 },
      { name: "b", description: "Does B", body: "", dir: "", source: "personal", estimatedBodyTokens: 0 },
    ]
    const catalog = buildSkillCatalog(skills)
    expect(catalog).toContain("# Skills")
    expect(catalog).toContain("- a: Does A")
    expect(catalog).toContain("- b: Does B")
  })
})

// ─── matchAutoTriggers ──────────────────────────────────────────────────────

describe("matchAutoTriggers", () => {
  const skills: Skill[] = [
    { name: "pdf", description: "PDF tool", body: "", dir: "", source: "project", estimatedBodyTokens: 0 },
    { name: "sql", description: "SQL tool", body: "", dir: "", source: "project", estimatedBodyTokens: 0 },
    {
      name: "commit",
      description: "Commit helper",
      body: "",
      dir: "",
      source: "project",
      estimatedBodyTokens: 0,
    },
  ]
  const autoTrigger = {
    pdf: ["*.pdf"],
    sql: ["migrations/**"],
    commit: ["commit message"],
  }

  test("triggers on file extension glob", () => {
    const matched = matchAutoTriggers("can you summarize report.pdf for me?", skills, autoTrigger)
    expect(matched.map((s) => s.name)).toContain("pdf")
  })

  test("triggers on path prefix glob", () => {
    const matched = matchAutoTriggers("update migrations/0042_users.sql", skills, autoTrigger)
    expect(matched.map((s) => s.name)).toContain("sql")
  })

  test("triggers on keyword match", () => {
    const matched = matchAutoTriggers("write a commit message for these changes", skills, autoTrigger)
    expect(matched.map((s) => s.name)).toContain("commit")
  })

  test("returns nothing when no pattern matches", () => {
    const matched = matchAutoTriggers("fix the login bug", skills, autoTrigger)
    expect(matched).toHaveLength(0)
  })
})

// ─── SkillBuffer ────────────────────────────────────────────────────────────

describe("SkillBuffer", () => {
  function makeSkill(name: string, body = "body"): Skill {
    return { name, description: "d", body, dir: "", source: "project", estimatedBodyTokens: body.length / 4 }
  }

  test("loads a skill and marks it as present", () => {
    const buf = new SkillBuffer()
    buf.load(makeSkill("foo", "foo instructions"))
    expect(buf.has("foo")).toBe(true)
    expect(buf.loaded()).toHaveLength(1)
    expect(buf.loaded()[0]?.name).toBe("foo")
  })

  test("is idempotent — loading same skill twice keeps one copy", () => {
    const buf = new SkillBuffer()
    buf.load(makeSkill("foo"))
    buf.load(makeSkill("foo"))
    expect(buf.loaded()).toHaveLength(1)
  })

  test("clear empties the buffer", () => {
    const buf = new SkillBuffer()
    buf.load(makeSkill("foo"))
    buf.clear()
    expect(buf.loaded()).toHaveLength(0)
    expect(buf.has("foo")).toBe(false)
  })
})
