import type { DawnConfig } from "../config/config"
import { BLESSED_MODELS, type Catalog, getModelInfo, normalizeModelRef, parseModelRef } from "./catalog"

/**
 * The roles a model can play in a session:
 * - "primary" — the main working model the user picked.
 * - "plan"    — used while in plan mode; defaults to the primary.
 * - "utility" — cheap background/housekeeping work (summarization, compaction,
 *               conversation titles, classification); defaults to the cheapest
 *               blessed model on the primary's provider so housekeeping doesn't
 *               burn flagship tokens/latency.
 *
 * All roles are auto-derived from the primary, so users configure nothing unless
 * they explicitly set `planModel` / `utilityModel`.
 */
export type ModelRole = "primary" | "plan" | "utility"

/** Cheapest blessed model on the given provider, by catalog input cost. */
function cheapestBlessedOnProvider(providerId: string, catalog: Catalog): string | undefined {
  const refs: string[] = []
  for (const ref of BLESSED_MODELS) {
    if (parseModelRef(ref).providerId === providerId) refs.push(ref)
  }
  if (refs.length === 0) return undefined
  // Cheapest by catalog input cost (unknown cost sorts last). When costs are
  // unknown/equal, the original BLESSED_MODELS order (flagship→cheap) is a stable
  // tiebreak, so the cheapest convention still holds.
  refs.sort((a, b) => {
    const ac = getModelInfo(catalog, a)?.cost?.input ?? Infinity
    const bc = getModelInfo(catalog, b)?.cost?.input ?? Infinity
    return ac - bc
  })
  return refs[0]
}

/**
 * Resolve the model ref for a given role, applying defaults. Pure and
 * config-driven; the single place role→model mapping lives.
 */
export function resolveRoleModel(
  role: ModelRole,
  primaryRef: string,
  catalog: Catalog,
  config: DawnConfig,
): string {
  const primary = normalizeModelRef(primaryRef)
  if (role === "primary") return primary
  if (role === "plan") return config.planModel ? normalizeModelRef(config.planModel) : primary

  // utility
  if (config.utilityModel) return normalizeModelRef(config.utilityModel)
  const { providerId } = parseModelRef(primary)
  return cheapestBlessedOnProvider(providerId, catalog) ?? primary
}
