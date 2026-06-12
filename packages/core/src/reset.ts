import fs from "node:fs"
import path from "node:path"
import { cacheDir, configDir, dataDir } from "./paths"

export function resetDawnData(): void {
  for (const p of [
    path.join(dataDir(), "auth.json"),
    path.join(configDir(), "config.json"),
    path.join(cacheDir(), "models.json"),
  ]) {
    try {
      fs.unlinkSync(p)
    } catch {}
  }
}
