/**
 * Lifecycle hook executor. Runs shell commands defined in dawn.json `hooks`
 * at key points in the agent's turn cycle.
 *
 * Hook output is trimmed and capped. An error exit code produces a visible
 * error line so the user knows a hook failed without crashing the agent.
 */

const MAX_HOOK_OUTPUT = 4_000

export interface HookResult {
  command: string
  output: string
  exitCode: number
}

export async function runHooks(commands: string[], cwd: string): Promise<HookResult[]> {
  const results: HookResult[] = []
  for (const command of commands) {
    const result = await runHook(command, cwd)
    results.push(result)
  }
  return results
}

async function runHook(command: string, cwd: string): Promise<HookResult> {
  try {
    const proc = Bun.spawn(["bash", "-c", command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    let output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trimEnd()
    if (output.length > MAX_HOOK_OUTPUT) {
      output = `${output.slice(0, MAX_HOOK_OUTPUT)}\n[… truncated]`
    }
    return { command, output: output || "(no output)", exitCode }
  } catch (err) {
    return {
      command,
      output: `Hook failed to start: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: -1,
    }
  }
}

/** Format hook results into a brief transcript line. */
export function formatHookResults(results: HookResult[]): string {
  return results
    .map((r) => {
      const status = r.exitCode === 0 ? "✓" : `✗ (exit ${r.exitCode})`
      return `hook ${status} \`${r.command}\`\n${r.output}`
    })
    .join("\n\n")
}
