import { loadRootEnv } from "@sce/shared"
import path from "node:path"
import { fileURLToPath } from "node:url"

// DATABASE_URL may live in the repo-root .env while a package script runs from
// inside packages/*; pick it up before anything reads it.
loadRootEnv()

/** Absolute path to the @sce/db package root (…/packages/db). */
export const DB_PACKAGE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..")

/**
 * Local development database, matching `infra/docker-compose.yml`.
 *
 * Only used outside production: a deployed process that forgets to set
 * DATABASE_URL must fail loudly rather than quietly open a database that does
 * not exist on that host.
 */
export const LOCAL_DATABASE_URL = "postgresql://sce:sce@localhost:5432/sce?schema=public"

const POSTGRES_PROTOCOLS = ["postgresql:", "postgres:"]

class DatabaseUrlError extends Error {
  override name = "DatabaseUrlError"
}

function reject(url: string, why: string): never {
  throw new DatabaseUrlError(
    `DATABASE_URL is not a Postgres URL: ${why}\n` +
      `  got:      ${url}\n` +
      `  expected: postgresql://user:password@host:5432/database\n` +
      `  local dev: run \`bun run db:up\` and unset DATABASE_URL, or set it to ${LOCAL_DATABASE_URL}`,
  )
}

/**
 * Resolve and validate the Postgres connection URL.
 *
 * This is the first parse-at-the-boundary check the process performs: a bad URL
 * fails here, at boot, with the offending value named — instead of surfacing as
 * an opaque driver error on the first query. SQLite/libSQL URLs left over from
 * the pre-Postgres schema are called out explicitly, because they otherwise
 * produce a particularly unhelpful adapter failure.
 */
export function resolveDatabaseUrl(raw: string | undefined = process.env.DATABASE_URL): string {
  const url = raw?.trim()

  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new DatabaseUrlError(
        "DATABASE_URL is required in production. Set it to a Postgres connection string.",
      )
    }
    return LOCAL_DATABASE_URL
  }

  if (url.startsWith("file:")) {
    reject(url, "this is a SQLite file URL, and the datasource is now Postgres")
  }
  if (url.startsWith("libsql:")) {
    reject(url, "libSQL/Turso is no longer supported; the datasource is now Postgres")
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    reject(url, "it is not a valid URL")
  }
  if (!POSTGRES_PROTOCOLS.includes(parsed.protocol)) {
    reject(url, `unsupported protocol "${parsed.protocol}"`)
  }
  if (!parsed.hostname) reject(url, "it has no host")

  return url
}

/** The URL with any password blanked out, for logs and error messages. */
export function redactDatabaseUrl(url: string = resolveDatabaseUrl()): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = "***"
    return parsed.toString()
  } catch {
    return "<unparseable DATABASE_URL>"
  }
}
