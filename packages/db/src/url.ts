import { loadRootEnv } from "@sce/shared"
import path from "node:path"
import { fileURLToPath } from "node:url"

// DATABASE_URL may live in the repo-root .env while a package script runs from
// inside packages/*; pick it up before anything reads it.
loadRootEnv()

/** Absolute path to the @sce/db package root (…/packages/db). */
export const DB_PACKAGE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

/** Where the SQLite file lives when DATABASE_URL is not set. */
export const DEFAULT_DB_FILE = path.join(DB_PACKAGE_DIR, "prisma", "dev.db")

/**
 * Resolve the database URL.
 *
 * Relative `file:` URLs are made absolute against the db package so that the
 * server, the CLI and the Prisma CLI all agree on which file they are talking
 * to, no matter what the process cwd happens to be. Remote URLs
 * (`libsql://`, `http://`, `https://` — i.e. Turso) are passed through as-is.
 */
export function resolveDatabaseUrl(raw: string | undefined = process.env.DATABASE_URL): string {
  const url = raw?.trim()
  if (!url) return `file:${DEFAULT_DB_FILE}`
  if (!url.startsWith("file:")) return url

  const filePath = url.slice("file:".length)
  if (path.isAbsolute(filePath)) return url
  return `file:${path.resolve(DB_PACKAGE_DIR, filePath)}`
}
