export type PermissionDecision = "allow" | "always" | "deny"

export type PermissionMode = "normal" | "acceptEdits" | "plan"

const EDIT_TOOLS = new Set(["write", "edit"])

export interface PermissionRequest {
  /** Tool name, e.g. "bash" */
  tool: string
  /** One-line description shown to the user, e.g. the command to run */
  title: string
  /** Optional multi-line detail (diff preview, file content, …) */
  detail?: string
}

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>

/**
 * Gates side-effecting tools behind user approval. The UI registers a handler;
 * without one (non-interactive runs) everything not pre-allowed is denied
 * unless `allowAll` was set explicitly (--yolo).
 */
export class PermissionGate {
  private handler: PermissionHandler | undefined
  private alwaysAllowed = new Set<string>()
  allowAll = false
  mode: PermissionMode = "normal"

  setHandler(handler: PermissionHandler | undefined): void {
    this.handler = handler
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  preAllow(tool: string): void {
    this.alwaysAllowed.add(tool)
  }

  async ask(req: PermissionRequest): Promise<boolean> {
    if (this.mode === "plan") return false
    if (this.allowAll || this.alwaysAllowed.has(req.tool)) return true
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(req.tool)) return true
    if (!this.handler) return false
    const decision = await this.handler(req)
    if (decision === "always") {
      this.alwaysAllowed.add(req.tool)
      return true
    }
    return decision === "allow"
  }
}
