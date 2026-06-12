import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

function home(): string {
  return process.env.DAWN_HOME ?? homedir()
}

export function dataDir(): string {
  const dir = process.env.DAWN_DATA_DIR ?? path.join(home(), ".local", "share", "dawn")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function configDir(): string {
  const dir = process.env.DAWN_CONFIG_DIR ?? path.join(home(), ".config", "dawn")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function cacheDir(): string {
  const dir = process.env.DAWN_CACHE_DIR ?? path.join(home(), ".cache", "dawn")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
