import { spawn } from "node:child_process"
import process from "node:process"

export async function copyToClipboard(text: string): Promise<boolean> {
  let command: string
  let args: string[]

  switch (process.platform) {
    case "darwin":
      command = "pbcopy"
      args = []
      break
    case "win32":
      command = "clip"
      args = []
      break
    case "linux":
    case "freebsd":
    case "openbsd":
      command = "xclip"
      args = ["-selection", "clipboard"]
      break
    default:
      return false
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
    child.once("error", () => resolve(false))
    child.once("spawn", () => {
      child.stdin.write(text)
      child.stdin.end()
      child.once("close", (code) => resolve(code === 0))
    })
  })
}
