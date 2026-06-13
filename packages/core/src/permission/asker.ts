export interface AskOption {
  label: string
  description?: string
}

export interface UserQuestion {
  kind: "ask" | "plan-approval"
  question: string
  /** For plan-approval: the plan text to show the user */
  detail?: string
  options: AskOption[]
}

/** Returns the chosen option index, or -1 if cancelled/no handler. */
export type AskHandler = (q: UserQuestion) => Promise<number>

export class Asker {
  private handler?: AskHandler

  setHandler(handler: AskHandler | undefined): void {
    this.handler = handler
  }

  async ask(q: UserQuestion): Promise<number> {
    return this.handler ? this.handler(q) : -1
  }
}
