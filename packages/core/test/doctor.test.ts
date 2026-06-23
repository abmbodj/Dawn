import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { setApiKey } from "../src/auth/auth"
import { classifyDoctorOutcome, type DoctorSignals, selectDoctorTargets } from "../src/doctor/models"
import type { Catalog } from "../src/provider/catalog"

let tmp: string
const NEUTRALIZED = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
]
let saved: Record<string, string | undefined>

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-doctor-test-"))
  process.env.DAWN_DATA_DIR = path.join(tmp, "data")
  process.env.DAWN_CONFIG_DIR = path.join(tmp, "config")
  process.env.DAWN_CACHE_DIR = path.join(tmp, "cache")
  saved = {}
  for (const k of NEUTRALIZED) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  delete process.env.DAWN_DATA_DIR
  delete process.env.DAWN_CONFIG_DIR
  delete process.env.DAWN_CACHE_DIR
  for (const k of NEUTRALIZED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

function catalog(): Catalog {
  return {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
      modelsSource: "live",
      models: {
        "claude-opus-4-8": {
          id: "claude-opus-4-8",
          name: "Opus",
          tool_call: true,
          limit: { context: 1_000_000 },
        },
        tiny: { id: "tiny", name: "Tiny", tool_call: true, limit: { context: 4_000 } },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      modelsSource: "live",
      models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", tool_call: true, limit: { context: 400_000 } } },
    },
  }
}

describe("selectDoctorTargets", () => {
  test("blessed: only blessed models on connected providers", () => {
    setApiKey("anthropic", "sk-a")
    const targets = selectDoctorTargets(catalog(), { providers: {} }, "blessed")
    expect(targets).toContain("anthropic/claude-opus-4-8")
    expect(targets).not.toContain("openai/gpt-5.5") // openai not connected
  })

  test("all: floor-passing models on connected providers, below-floor excluded", () => {
    setApiKey("anthropic", "sk-a")
    const targets = selectDoctorTargets(catalog(), { providers: {} }, "all")
    expect(targets).toContain("anthropic/claude-opus-4-8")
    expect(targets).not.toContain("anthropic/tiny") // below floor
  })

  test("provider mode: that provider's tool-capable models regardless of blessed", () => {
    const targets = selectDoctorTargets(catalog(), { providers: {} }, { provider: "openai" })
    expect(targets).toEqual(["openai/gpt-5.5"])
  })
})

describe("classifyDoctorOutcome", () => {
  const base: DoctorSignals = {
    sawToolCall: false,
    sawText: false,
    turnEnded: false,
    fileCreated: false,
    timedOut: false,
  }

  test("error wins over everything", () => {
    const out = classifyDoctorOutcome({ ...base, error: { kind: "auth", message: "bad key" } })
    expect(out).toEqual({ ok: false, failureKind: "auth", detail: "bad key" })
  })

  test("timeout", () => {
    expect(classifyDoctorOutcome({ ...base, timedOut: true }).failureKind).toBe("timeout")
  })

  test("no tool call", () => {
    expect(classifyDoctorOutcome({ ...base, sawText: true }).failureKind).toBe("no-tool-call")
  })

  test("incomplete when a tool ran but the file is missing", () => {
    expect(classifyDoctorOutcome({ ...base, sawToolCall: true }).failureKind).toBe("incomplete")
  })

  test("pass when a tool ran and the file was created", () => {
    const out = classifyDoctorOutcome({ ...base, sawToolCall: true, fileCreated: true })
    expect(out.ok).toBe(true)
    expect(out.failureKind).toBe("ok")
  })
})
