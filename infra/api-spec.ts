import { writeFile } from "node:fs/promises"
import path from "node:path"
import { openApiDocument } from "../packages/server/src/v1/app.ts"

/**
 * Write the OpenAPI document to `doc/api/openapi.json`.
 *
 *     bun run api:spec        # regenerate
 *     bun run api:check       # fail if it is out of date, or breaks the contract
 *
 * The file is *generated and committed*, which is a combination people are
 * rightly suspicious of. It earns it here: a committed spec is what makes a
 * breaking change visible in a pull request diff, and what gives the
 * compatibility gate something to compare against. A spec produced only in CI
 * can tell you the current shape; it cannot tell you what you just changed.
 *
 * Sorted and stably formatted so the diff is the semantic change and nothing
 * else. Key order out of the generator is insertion order, which shifts when a
 * route is moved between files — noise that would make every diff unreadable
 * and would eventually train everyone to skim past it.
 */

const OUTPUT = path.join(import.meta.dir, "..", "doc", "api", "openapi.json")

/**
 * Sort every object's keys, recursively.
 *
 * Arrays keep their order: in OpenAPI, `required` and `enum` are sets whose
 * order is not meaningful but *is* stable from the generator, while `servers`
 * and `parameters` are genuinely ordered. Sorting arrays would either lose that
 * or require knowing which is which, and the generator is deterministic enough
 * that it is not needed.
 */
export function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value === null || typeof value !== "object") return value

  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, inner]) => [key, canonicalise(inner)]))
}

/** The document, canonicalised and formatted exactly as it is committed. */
export function renderSpec(): string {
  return `${JSON.stringify(canonicalise(openApiDocument()), null, 2)}\n`
}

if (import.meta.main) {
  await writeFile(OUTPUT, renderSpec())
  console.log(`[api] wrote ${path.relative(process.cwd(), OUTPUT)}`)
}
