import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DawnAgent } from "../agent/agent"
import { type ClassifiedFailure, classifyFailure } from "../agent/errors"
import { Bus } from "../bus/bus"
import type { DawnConfig } from "../config/config"
import { ContextStore } from "../context/store"
import { PermissionGate } from "../permission/permission"
import { BLESSED_MODELS, type Catalog, getModelInfo, meetsFloor, parseModelRef } from "../provider/catalog"
import { connectedProviders } from "../provider/provider"
import { SessionStore } from "../session/store"

/** Which models to evaluate. */
export type DoctorMode = "blessed" | "all" | { provider: string }

export interface DoctorResult {
  ref: string
  ok: boolean
  /** "ok" on success; otherwise a short failure class (error kind / "no-tool-call" / "timeout" / …). */
  failureKind: string
  detail: string
  durationMs: number
}

/** Signals gathered while evaluating one model; separated so the verdict is pure-testable. */
export interface DoctorSignals {
  sawToolCall: boolean
  sawText: boolean
  turnEnded: boolean
  fileCreated: boolean
  timedOut: boolean
  error?: ClassifiedFailure
}

/**
 * Canonical task: prove the model can call a tool that actually takes effect, while
 * streaming output — the minimum bar for the agent loop. Kept to one cheap task so
 * the harness is affordable to run across many models.
 */
export const DOCTOR_PROMPT =
  "Use your file tools to create a file named dawn-doctor.txt in the current directory " +
  "containing exactly the text OK. Then stop. Do not ask any questions."

const DOCTOR_FILENAME = "dawn-doctor.txt"
const DEFAULT_TIMEOUT_MS = 60_000

/** Select the model refs to evaluate, given mode and which providers are connected. Pure. */
export function selectDoctorTargets(catalog: Catalog, config: DawnConfig, mode: DoctorMode): string[] {
  const connected = connectedProviders(catalog, config)
  const connectedIds = new Set(connected.map((p) => p.id))

  if (typeof mode === "object") {
    const models = catalog[mode.provider]?.models ?? {}
    return Object.values(models)
      .filter((m) => m.tool_call !== false)
      .map((m) => `${mode.provider}/${m.id}`)
  }

  if (mode === "blessed") {
    const refs: string[] = []
    for (const ref of BLESSED_MODELS) {
      const { providerId } = parseModelRef(ref)
      // Only evaluate blessed models the connected provider actually serves.
      if (connectedIds.has(providerId) && getModelInfo(catalog, ref)) refs.push(ref)
    }
    return refs
  }

  // mode === "all": every floor-passing tool-capable model on a connected provider.
  const refs: string[] = []
  for (const provider of connected) {
    for (const model of Object.values(catalog[provider.id]?.models ?? {})) {
      if (meetsFloor(model)) refs.push(`${provider.id}/${model.id}`)
    }
  }
  return refs
}

/** Turn gathered signals into a pass/fail verdict. Pure and unit-tested. */
export function classifyDoctorOutcome(s: DoctorSignals): {
  ok: boolean
  failureKind: string
  detail: string
} {
  if (s.error) return { ok: false, failureKind: s.error.kind, detail: s.error.message }
  if (s.timedOut) return { ok: false, failureKind: "timeout", detail: "exceeded the time budget" }
  if (!s.sawToolCall) return { ok: false, failureKind: "no-tool-call", detail: "model never invoked a tool" }
  if (!s.fileCreated)
    return {
      ok: false,
      failureKind: "incomplete",
      detail: "a tool ran but the expected file was not created",
    }
  return { ok: true, failureKind: "ok", detail: "tool-call → file written → streamed output" }
}

/**
 * Evaluate a single model end-to-end by running the real agent loop against a
 * throwaway sandbox. Makes a live provider call. Never throws — provider/auth
 * failures become a failed DoctorResult.
 */
export async function evaluateModel(
  ref: string,
  catalog: Catalog,
  config: DawnConfig,
  opts: { timeoutMs?: number } = {},
): Promise<DoctorResult> {
  const start = Date.now()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-doctor-"))
  const bus = new Bus()
  const gate = new PermissionGate()
  gate.allowAll = true
  const store = new SessionStore(path.join(dir, "session.db"))
  const contextStore = new ContextStore(path.join(dir, "context.db"))
  const session = store.createSession(dir)

  const signals: DoctorSignals = {
    sawToolCall: false,
    sawText: false,
    turnEnded: false,
    fileCreated: false,
    timedOut: false,
  }
  bus.subscribe((ev) => {
    if (ev.type === "tool-start") signals.sawToolCall = true
    else if (ev.type === "text-delta" || ev.type === "reasoning-delta") signals.sawText = true
    else if (ev.type === "turn-end") signals.turnEnded = true
    else if (ev.type === "error") signals.error = classifyFailure(new Error(ev.message))
  })

  const agent = new DawnAgent({
    cwd: dir,
    modelRef: ref,
    bus,
    gate,
    catalog,
    config: { ...config, autoFallback: false }, // never silently switch — we test THIS model
    store,
    sessionId: session.id,
    contextStore,
  })

  const ac = new AbortController()
  const timer = setTimeout(() => {
    signals.timedOut = true
    ac.abort()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    await agent.send(DOCTOR_PROMPT, ac.signal)
  } catch (err) {
    if (!signals.error) signals.error = classifyFailure(err)
  } finally {
    clearTimeout(timer)
  }

  signals.fileCreated = fs.existsSync(path.join(dir, DOCTOR_FILENAME))

  try {
    await agent.close()
  } catch {
    /* best-effort cleanup */
  }
  store.close()
  contextStore.close()
  fs.rmSync(dir, { recursive: true, force: true })

  return { ref, ...classifyDoctorOutcome(signals), durationMs: Date.now() - start }
}

/** Evaluate every target model sequentially (avoids hammering provider rate limits). */
export async function runModelDoctor(
  catalog: Catalog,
  config: DawnConfig,
  mode: DoctorMode,
  onResult?: (result: DoctorResult) => void,
): Promise<DoctorResult[]> {
  const targets = selectDoctorTargets(catalog, config, mode)
  const results: DoctorResult[] = []
  for (const ref of targets) {
    const result = await evaluateModel(ref, catalog, config)
    results.push(result)
    onResult?.(result)
  }
  return results
}
