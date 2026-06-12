import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App, type AppProps } from "./app"

export type TuiOptions = Omit<AppProps, "animate"> & { animate?: boolean }

export async function launchTui(opts: TuiOptions): Promise<void> {
  const animate =
    opts.animate ??
    (process.stdout.isTTY === true && !process.env.DAWN_NO_ANIM && process.env.TERM !== "dumb")
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  createRoot(renderer).render(<App {...opts} animate={animate} />)
}

export type { Run } from "./logo"
export { LOGO_FPS, RISE_DURATION_MS, sunFrame, TAGLINE, WORDMARK } from "./logo"
