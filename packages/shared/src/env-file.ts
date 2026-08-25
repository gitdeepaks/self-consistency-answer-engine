import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const match = LINE.exec(line)
    if (!match) continue

    // `noUncheckedIndexedAccess` makes these honest: a capture group is
    // `string | undefined` no matter how sure the regex looks.
    const key = match[1]
    const captured = match[2]
    if (key === undefined || captured === undefined) continue
    let value = captured.trim()

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    } else {
      // Unquoted values may carry a trailing comment.
      const comment = value.indexOf(" #")
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    out[key] = value
  }
  return out
}

/**
 * Load the nearest `.env` at or above the current directory into `process.env`.
 *
 * Bun only auto-loads `.env` from the process cwd, so a workspace script that
 * runs inside `packages/*` would silently miss the repo-root file and every
 * provider would look unconfigured. Values already present always win, so real
 * environment variables — and anything Bun already loaded — are never
 * overwritten.
 *
 * Returns the file it loaded, or null if there was none to load.
 */
export function loadRootEnv(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir)

  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, ".env")
    if (existsSync(candidate)) {
      for (const [key, value] of Object.entries(parse(readFileSync(candidate, "utf8")))) {
        if (process.env[key] === undefined) process.env[key] = value
      }
      return candidate
    }

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}
