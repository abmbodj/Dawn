import { describe, expect, test } from "bun:test"
import { markdownStyles } from "../src/markdown"
import { theme } from "../src/theme"

const REQUIRED_SCOPES = [
  "default",
  "conceal",
  "markup.heading",
  "markup.strong",
  "markup.italic",
  "markup.raw",
  "markup.raw.block",
  "markup.quote",
  "markup.list",
  "markup.link",
  "markup.link.url",
  "markup.link.label",
  "markup.strikethrough",
]

describe("markdownStyles", () => {
  test("contains all required OpenTUI scopes", () => {
    for (const scope of REQUIRED_SCOPES) {
      expect(Object.hasOwn(markdownStyles, scope), `missing scope: ${scope}`).toBe(true)
    }
  })

  test("fg colors reference known theme palette values", () => {
    const paletteColors = new Set<string>(Object.values(theme))
    for (const [scope, style] of Object.entries(markdownStyles)) {
      if (style.fg) {
        expect(paletteColors.has(style.fg as string), `${scope}.fg ${style.fg} not in theme`).toBe(true)
      }
      if (style.bg) {
        expect(paletteColors.has(style.bg as string), `${scope}.bg ${style.bg} not in theme`).toBe(true)
      }
    }
  })

  test("inline code uses sunCore fg and statusBg bg", () => {
    expect(markdownStyles["markup.raw"]?.fg).toBe(theme.sunCore)
    expect(markdownStyles["markup.raw"]?.bg).toBe(theme.statusBg)
  })

  test("heading uses accent and bold", () => {
    expect(markdownStyles["markup.heading"]?.fg).toBe(theme.accent)
    expect(markdownStyles["markup.heading"]?.bold).toBe(true)
  })

  test("default uses text color", () => {
    expect(markdownStyles["default"]?.fg).toBe(theme.text)
  })
})
