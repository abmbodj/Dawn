import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

// Anthropic rejects images over ~5 MB; other providers are in the same ballpark.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type ImageAttachment = { base64: string; mimeType: string; name: string; sizeKb: number }

export type ImageAttachResult = { ok: true; image: ImageAttachment } | { ok: false; error: string }

/** Load `/image <path>` into a base64 attachment, validating type and size. */
export function loadImageAttachment(cwd: string, arg: string): ImageAttachResult {
  const expanded = arg.startsWith("~/") ? path.join(os.homedir(), arg.slice(2)) : arg
  const resolved = path.resolve(cwd, expanded)
  const ext = path.extname(resolved).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) {
    return { ok: false, error: `unsupported image type "${ext || arg}" — use png, jpg, jpeg, gif, or webp` }
  }
  try {
    const stat = fs.statSync(resolved)
    if (stat.size > MAX_IMAGE_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1)
      return { ok: false, error: `image is ${mb} MB — max ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }
    }
    const base64 = fs.readFileSync(resolved).toString("base64")
    return {
      ok: true,
      image: {
        base64,
        mimeType: mime,
        name: path.basename(resolved),
        sizeKb: Math.max(1, Math.round(stat.size / 1024)),
      },
    }
  } catch {
    return { ok: false, error: `cannot read ${resolved}` }
  }
}
