import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadImageAttachment, MAX_IMAGE_BYTES } from "../src/imageAttach"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dawn-image-"))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

describe("loadImageAttachment", () => {
  test("loads a png relative to cwd", () => {
    fs.writeFileSync(path.join(dir, "dot.png"), PNG_BYTES)
    const result = loadImageAttachment(dir, "dot.png")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image.mimeType).toBe("image/png")
    expect(result.image.name).toBe("dot.png")
    expect(Buffer.from(result.image.base64, "base64").equals(PNG_BYTES)).toBe(true)
  })

  test("rejects unsupported extensions", () => {
    const result = loadImageAttachment(dir, "notes.txt")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("unsupported image type")
  })

  test("rejects missing files", () => {
    const result = loadImageAttachment(dir, "ghost.png")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("cannot read")
  })

  test("rejects oversized images", () => {
    const big = path.join(dir, "big.png")
    fs.writeFileSync(big, Buffer.alloc(MAX_IMAGE_BYTES + 1))
    const result = loadImageAttachment(dir, "big.png")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("max 5 MB")
  })

  test("maps jpg and jpeg to image/jpeg", () => {
    fs.writeFileSync(path.join(dir, "photo.JPG"), PNG_BYTES)
    const result = loadImageAttachment(dir, "photo.JPG")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.image.mimeType).toBe("image/jpeg")
  })
})
