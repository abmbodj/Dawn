import { describe, expect, test } from "bun:test"
import { externalOpenCommand } from "../src/platform/open-external"

describe("externalOpenCommand", () => {
  test("uses open on macOS", () => {
    expect(externalOpenCommand("https://github.com/login/device", "darwin")).toEqual({
      command: "open",
      args: ["https://github.com/login/device"],
    })
  })

  test("uses cmd start on Windows", () => {
    expect(externalOpenCommand("https://github.com/login/device", "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "https://github.com/login/device"],
    })
  })

  test("uses xdg-open on Linux and BSD", () => {
    expect(externalOpenCommand("https://github.com/login/device", "linux")).toEqual({
      command: "xdg-open",
      args: ["https://github.com/login/device"],
    })
    expect(externalOpenCommand("https://github.com/login/device", "freebsd")).toEqual({
      command: "xdg-open",
      args: ["https://github.com/login/device"],
    })
    expect(externalOpenCommand("https://github.com/login/device", "openbsd")).toEqual({
      command: "xdg-open",
      args: ["https://github.com/login/device"],
    })
  })

  test("returns undefined for unsupported platforms", () => {
    expect(externalOpenCommand("https://github.com/login/device", "aix")).toBeUndefined()
  })
})
