import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Static guard: no unscoped query may enter the repository.
 *
 * The live isolation suite proves today's queries are scoped. This proves the
 * *next* one will be too — it fails on a new `prisma.<model>.<op>()` whose
 * filter never mentions the tenant, which is the shape every cross-tenant leak
 * takes. Deliberate exceptions are listed here with a reason, so adding one is
 * a visible decision in the diff rather than an omission.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(HERE, "repository.ts"), "utf8")

/** Models that belong to no tenant, plus why. */
const GLOBAL_MODELS: Record<string, string> = {
  modelPrice: "the price list is install-global reference data, owned by nobody",
}

/**
 * Calls whose scoping is proven by their surroundings rather than their own
 * filter. Each entry has to justify itself.
 */
const EXEMPT_CALLS: Record<string, string> = {
  "runEvent.create":
    "runs inside appendRunEvent's transaction, immediately after a tenant-scoped " +
    "update of the owning run — the insert cannot be reached for a foreign tenant",
  "synthesis.upsert":
    "keyed on the unique runId, which saveSynthesis obtains from a tenant-scoped " +
    "lookup performed immediately above — a foreign tenant never reaches the write",
}

interface Call {
  model: string
  method: string
  args: string
  line: number
}

/** Every `prisma.x.y(...)` / `tx.x.y(...)` call, with its balanced argument text. */
function findCalls(source: string): Call[] {
  const calls: Call[] = []
  const pattern = /\b(?:prisma|tx)\.([a-z][A-Za-z0-9]*)\.([a-zA-Z]+)\(/g

  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let end = open
    for (let i = open; i < source.length; i++) {
      const char = source[i]
      if (char === "(") depth++
      else if (char === ")") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    calls.push({
      model: match[1] ?? "",
      method: match[2] ?? "",
      args: source.slice(open + 1, end),
      line: source.slice(0, match.index).split("\n").length,
    })
  }
  return calls
}

/**
 * Does this call's arguments constrain the query to one tenant?
 *
 * `scopeFilter(...)` counts because it takes a `RunScope`, a discriminated
 * union whose cross-tenant variant cannot be reached without typing
 * `{ kind: "every-tenant", reason: … }` at the call site. That is a visible
 * decision in a diff, which is the property this test exists to protect — an
 * optional `tenantId?` left undefined is not.
 */
function isScoped(args: string): boolean {
  return /\btenantId\b/.test(args) || /\bscopeFilter\(/.test(args)
}

/**
 * Does this parameter list carry an owner — directly, or through a named
 * interface it refers to?
 *
 * Following the reference matters: `createRun(input: CreateRunInput)` is every
 * bit as scoped as an inline object literal with a `tenantId` field, and a test
 * that could not tell the difference would push the codebase towards inline
 * types purely to satisfy the test.
 */
function mentionsTenant(params: string, depth = 0): boolean {
  if (/\btenantId\b/.test(params)) return true
  if (depth > 2) return false

  for (const reference of params.matchAll(/:\s*([A-Z]\w*)/g)) {
    const typeName = reference[1]
    if (typeName === undefined) continue
    const declaration = new RegExp(
      `(?:interface|type)\\s+${typeName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    ).exec(SOURCE)
    if (declaration?.[1] && mentionsTenant(declaration[1], depth + 1)) return true
  }
  return false
}

describe("repository query scoping", () => {
  const calls = findCalls(SOURCE)

  test("the scanner actually found the queries", () => {
    expect(calls.length).toBeGreaterThan(15)
    expect(calls.some((c) => c.model === "run" && c.method === "findUnique")).toBe(true)
  })

  test("every tenant-owned query filters on tenantId", () => {
    const unscoped = calls
      .filter((call) => !(call.model in GLOBAL_MODELS))
      .filter((call) => !(`${call.model}.${call.method}` in EXEMPT_CALLS))
      .filter((call) => !isScoped(call.args))
      .map((call) => `repository.ts:${call.line} — prisma.${call.model}.${call.method}()`)

    expect(unscoped).toEqual([])
  })

  test("every exported function takes a tenantId", () => {
    const missing: string[] = []
    for (const match of SOURCE.matchAll(/export (?:async )?function (\w+)\(([\s\S]*?)\)\s*:/g)) {
      const [, name = "", params = ""] = match
      // Pure row mappers take a row, not an owner; they cannot query anything.
      if (name.startsWith("to") || name === "findPrice" || name === "upsertModelPrice") continue
      // Takes a RunScope instead — see the run.findMany exemption above.
      if (name === "listOverdueRuns") continue
      if (!mentionsTenant(params)) missing.push(name)
    }
    expect(missing).toEqual([])
  })
})
