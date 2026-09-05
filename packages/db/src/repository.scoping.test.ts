import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Static guard: no unscoped query may enter the data layer.
 *
 * The live isolation suite proves today's queries are scoped. This proves the
 * *next* one will be too — it fails on a new `prisma.<model>.<op>()` whose
 * filter never mentions the tenant, which is the shape every cross-tenant leak
 * takes. Deliberate exceptions are listed here with a reason, so adding one is
 * a visible decision in the diff rather than an omission.
 *
 * Nine files are scanned. `repository.ts` holds the runs and everything hanging
 * off them; `auth.ts` holds credentials and the audit trail; `metering.ts` holds
 * the counters quotas are decided from; `billing.ts` holds subscriptions and the
 * kill switch; `shares.ts` holds public links; `feedback.ts` holds human
 * verdicts; `webhooks.ts` holds outbound webhook endpoints and their delivery log;
 * `idempotency.ts` holds the records that make a retried POST safe; `admin.ts`
 * is the operations console's cross-tenant reads, every one of which is listed
 * below with the reason it is allowed to span tenants.
 * `tenancy.ts` is deliberately *not* scanned: it is the file that
 * creates tenants and memberships in the first place, so "filters by tenant" is
 * not a property it can have — it is the thing every other query's filter
 * refers to.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

interface Scanned {
  file: string
  source: string
  /** Models that belong to no tenant, plus why. */
  globalModels: Record<string, string>
  /** Calls whose scoping is proven by their surroundings rather than their own filter. */
  exemptCalls: Record<string, string>
  /** Exported functions that legitimately take no owner, plus why. */
  exemptFunctions: Record<string, string>
}

const FILES: Scanned[] = [
  {
    file: "repository.ts",
    source: readFileSync(path.join(HERE, "repository.ts"), "utf8"),
    globalModels: {
      modelPrice: "the price list is install-global reference data, owned by nobody",
    },
    exemptCalls: {
      "runEvent.create":
        "runs inside appendRunEvent's transaction, immediately after a tenant-scoped " +
        "update of the owning run — the insert cannot be reached for a foreign tenant",
      "synthesis.upsert":
        "keyed on the unique runId, which saveSynthesis obtains from a tenant-scoped " +
        "lookup performed immediately above — a foreign tenant never reaches the write",
    },
    exemptFunctions: {
      findPrice: "reads the install-global price list",
      upsertModelPrice: "writes the install-global price list",
      listOverdueRuns: "takes a RunScope, whose cross-tenant variant is explicit at the call site",
    },
  },
  {
    file: "metering.ts",
    source: readFileSync(path.join(HERE, "metering.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {
      "tenant.findMany":
        "resolves slugs for tenant ids that a scoped aggregate has already produced — it " +
        "reads no tenant-owned data and cannot widen what the aggregate returned",
    },
    exemptFunctions: {
      globalSpendSince:
        "the install-wide spend guard; takes a MeteringScope whose cross-tenant variant has " +
        "to be typed out with its reason at the call site",
      rollupUsage: "the rollup job recomputes every tenant's day; same explicit MeteringScope",
      spendByTenant: "the operator cost report is cross-tenant by definition; same MeteringScope",
    },
  },
  {
    file: "billing.ts",
    source: readFileSync(path.join(HERE, "billing.ts"), "utf8"),
    globalModels: {
      killSwitch:
        "the install-wide stop. It is the one control that must work when tenancy itself is " +
        "the thing going wrong, so it has no tenant column and never will",
    },
    exemptCalls: {
      "subscription.findFirst":
        "this IS the attribution lookup — it decides which tenant a billing-provider customer " +
        "belongs to, so it cannot be filtered by one. Both identifiers are unique columns",
    },
    exemptFunctions: {
      findTenantIdForBillingCustomer: "resolves the tenant from a provider id — it cannot be given one",
      getKillSwitch: "reads the install-wide switch",
      engageKillSwitch: "engages the install-wide switch",
      releaseKillSwitch: "releases the install-wide switch",
      parsePlanId: "pure parser for untrusted provider input; touches no database",
      parseSubscriptionStatus: "pure parser for untrusted provider input; touches no database",
    },
  },
  {
    file: "shares.ts",
    source: readFileSync(path.join(HERE, "shares.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {
      "runShare.findUnique":
        "this IS the capability lookup — the share token is what decides which tenant's run " +
        "is served, so it cannot be filtered by one. Keyed on the unique token column",
      "runShare.update":
        "the view counter, keyed on the id that the token lookup immediately above returned — " +
        "a foreign tenant never reaches it, and the write touches no tenant-owned data",
    },
    exemptFunctions: {
      resolveShare:
        "resolves the tenant from a capability URL — it cannot be given one, exactly as " +
        "verifyApiKey resolves a tenant from a credential",
    },
  },
  {
    file: "feedback.ts",
    source: readFileSync(path.join(HERE, "feedback.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {},
    exemptFunctions: {},
  },
  {
    file: "admin.ts",
    source: readFileSync(path.join(HERE, "admin.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {
      "tenant.findMany": "the console's workspace list — the whole point is that it spans tenants",
      "tenant.count": "an install-wide counter; reads no tenant-owned data",
      "run.findUnique":
        "the run inspector resolves an operator-supplied id to the tenant that owns it; it " +
        "returns identity and cost only, and the run's contents are then read through the " +
        "tenant-scoped getRun()",
      "run.count": "an install-wide counter of runs in flight; reads no tenant-owned data",
      "usageRecord.aggregate":
        "costs one run, keyed on the run id the lookup immediately above resolved",
    },
    exemptFunctions: {
      adminTenantRows: "the console's workspace list; takes an OperatorScope whose reason is typed at the call site",
      adminFindRun: "resolves a run without knowing its tenant; same OperatorScope",
      adminInstallCounts: "install-wide counters; same OperatorScope",
    },
  },
  {
    file: "webhooks.ts",
    source: readFileSync(path.join(HERE, "webhooks.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {
      "webhookDispatch.findMany":
        "the outbox sweep, which spans the install by definition — it takes a scope whose " +
        "reason has to be typed out at the call site, and returns ids only",
      "webhookDispatch.deleteMany":
        "the retention sweep, which spans the install by definition — it takes a scope whose " +
        "reason has to be typed out at the call site",
    },
    exemptFunctions: {
      listDueWebhookDeliveries:
        "the outbox sweep reads due deliveries across every tenant; the cross-tenant intent " +
        "is typed at the call site and each row carries its own tenant back",
      pruneWebhookDeliveries:
        "deletes settled deliveries past their retention window across every tenant; the " +
        "cross-tenant intent is typed at the call site",
    },
  },
  {
    file: "idempotency.ts",
    source: readFileSync(path.join(HERE, "idempotency.ts"), "utf8"),
    globalModels: {},
    exemptCalls: {
      "idempotencyRecord.deleteMany":
        "one caller is tenant-scoped (releaseIdempotencyKey, whose filter names the tenant) " +
        "and the other is the expiry sweep, which spans the install and says so",
    },
    exemptFunctions: {
      sweepIdempotencyRecords:
        "deletes expired records across every tenant; the cross-tenant intent is typed at " +
        "the call site",
    },
  },
  {
    file: "auth.ts",
    source: readFileSync(path.join(HERE, "auth.ts"), "utf8"),
    globalModels: {
      webhookDelivery:
        "a Svix delivery id is globally unique and is claimed before any tenant is known — " +
        "the row exists to deduplicate retries, and belongs to the install",
    },
    exemptCalls: {
      "apiKey.findUnique":
        "this IS the authentication lookup — it is what decides which tenant the request " +
        "belongs to, so it cannot be filtered by one. Keyed on the unique prefix and " +
        "followed by a constant-time secret comparison",
      "membership.findUnique":
        "resolves the key creator's current role inside the key's own tenant; the compound " +
        "key names that tenant explicitly",
    },
    exemptFunctions: {
      verifyApiKey: "resolves the tenant from a credential — it cannot be given one",
      claimWebhookDelivery: "deduplicates an inbound webhook before any tenant is known",
    },
  },
]

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
function mentionsTenant(source: string, params: string, depth = 0): boolean {
  if (/\btenantId\b/.test(params)) return true
  if (depth > 2) return false

  for (const reference of params.matchAll(/:\s*([A-Z]\w*)/g)) {
    const typeName = reference[1]
    if (typeName === undefined) continue
    const declaration = new RegExp(
      `(?:interface|type)\\s+${typeName}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    ).exec(source)
    if (declaration?.[1] && mentionsTenant(source, declaration[1], depth + 1)) return true
  }
  return false
}

describe("data layer query scoping", () => {
  test("the scanner actually found the queries", () => {
    const all = FILES.flatMap((scanned) => findCalls(scanned.source))
    expect(all.length).toBeGreaterThan(20)
    expect(all.some((c) => c.model === "run" && c.method === "findUnique")).toBe(true)
    expect(all.some((c) => c.model === "apiKey")).toBe(true)
  })

  for (const scanned of FILES) {
    describe(scanned.file, () => {
      const calls = findCalls(scanned.source)

      test("every tenant-owned query filters on tenantId", () => {
        const unscoped = calls
          .filter((call) => !(call.model in scanned.globalModels))
          .filter((call) => !(`${call.model}.${call.method}` in scanned.exemptCalls))
          .filter((call) => !isScoped(call.args))
          .map((call) => `${scanned.file}:${call.line} — prisma.${call.model}.${call.method}()`)

        expect(unscoped).toEqual([])
      })

      test("every exported function takes a tenantId", () => {
        const missing: string[] = []
        const pattern = /export (?:async )?function (\w+)\(([\s\S]*?)\)\s*:/g

        for (const match of scanned.source.matchAll(pattern)) {
          const [, name = "", params = ""] = match
          // Pure row mappers take a row, not an owner; they cannot query anything.
          if (name.startsWith("to")) continue
          if (name in scanned.exemptFunctions) continue
          if (!mentionsTenant(scanned.source, params)) missing.push(name)
        }
        expect(missing).toEqual([])
      })
    })
  }
})
