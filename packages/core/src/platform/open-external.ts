import { spawn } from "node:child_process"
import process from "node:process"

export interface ExternalOpenCommand {
  command: string
  args: string[]
}

export function externalOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): ExternalOpenCommand | undefined {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] }
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] }
    case "linux":
    case "freebsd":
    case "openbsd":
      return { command: "xdg-open", args: [url] }
    default:
      return undefined
  }
}

export async function openExternalUrl(url: string): Promise<boolean> {
  const openCommand = externalOpenCommand(url)
  if (!openCommand) return false

  return new Promise((resolve) => {
    const child = spawn(openCommand.command, openCommand.args, {
      detached: true,
      stdio: "ignore",
    })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.unref()
      resolve(true)
    })
  })
}
