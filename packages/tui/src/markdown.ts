import { type StyleDefinitionInput, SyntaxStyle } from "@opentui/core"
import { theme } from "./theme"

export const markdownStyles: Record<string, StyleDefinitionInput> = {
  default: { fg: theme.text },
  conceal: { fg: theme.dim },
  "markup.heading": { fg: theme.accent, bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: theme.sunCore, bg: theme.statusBg },
  "markup.raw.block": { fg: theme.text, bg: theme.statusBg },
  "markup.quote": { fg: theme.dim, italic: true },
  "markup.list": { fg: theme.accent },
  "markup.link": { fg: theme.user, underline: true },
  "markup.link.url": { fg: theme.dim },
  "markup.link.label": { fg: theme.user },
  "markup.strikethrough": { dim: true },
}

let _style: SyntaxStyle | undefined

export function dawnSyntaxStyle(): SyntaxStyle {
  if (!_style) _style = SyntaxStyle.fromStyles(markdownStyles)
  return _style
}
