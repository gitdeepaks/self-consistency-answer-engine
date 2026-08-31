import { freeSubscription, type RunStatus, type Subscription } from "@sce/shared"
import { prisma } from "./client.ts"
import { toSubscription } from "./billing.ts"

/**
 * Cross-tenant reads for the internal operations console.
 *
 * This module breaks the rule the rest of this layer is built on — every query
 * is scoped to one tenant — and it does so deliberately, because "which
 * customer is spending the money" and "why did run `abc` fail" are questions
 * that cannot be asked from inside a single tenant. The safeguard is not that
 * these queries are narrow; it is that reaching them is *loud*:
 *
 *   - Every function takes an `OperatorScope` whose `reason` is a closed union
 *     of literals, so a call site has to type out which sanctioned purpose it
 *     is serving. The same idiom as `RunScope` and `MeteringScope`, for the
 *     same reason: it makes a cross-tenant read a visible decision in a diff
 *     rather than a filter somebody forgot.
 *   - The only routes that call any of it sit behind `requireInstallAdmin`,
 *     which is resolved from deploy-time configuration and cannot be granted by
 *     anything a customer does.
 *   - `repository.scoping.test.ts` scans this file and requires each exemption
 *     to be listed with its justification.
 *
 * Everything here is a **read**. The console's two writes — releasing the spend
 * kill switch and replaying the dead-letter queue — go through the existing
 * `billing.ts` and `@sce/queue` entry points, which already have their own
 * guards and their own audit trail.
 */

/**
 * Which tenants an operator read covers.
 *
 * There is no `{ kind: "tenant" }` variant: a request that concerns one tenant
 * belongs on the tenant-scoped routes, where it is subject to the isolation
 * rules. Giving this union a scoped variant would invite exactly the drift
 * where a normal read quietly starts flowing through the operator path.
 */
export type OperatorScope = {
  kind: "every-tenant"
  reason:
    | "the operations console lists every workspace"
    | "the run inspector resolves a run without knowing its tenant"
    | "the operations console counts the whole install"
}

/** One workspace, as the console lists it. */
export interface AdminTenantRow {
  id: string
  slug: string
  name: string
  createdAt: string
  subscription: Subscription
  memberCount: number
  runCount: number
  costMicroCents: number
}

/**
 * Look a workspace up by slug, id, or part of its name.
 *
 * One grouped spend query for the whole page rather than one per tenant: the
 * console is the surface an operator opens during an incident, and a page that
 * issues fifty queries is a page that makes the incident worse.
 */
export async function adminTenantRows(options: {
  scope: OperatorScope
  q?: string
  limit: number
  /** Start of the window that spend is attributed over. */
  from: Date
}): Promise<AdminTenantRow[]> {
  const term = options.q?.trim()
  const tenants = await prisma.tenant.findMany({
    where:
      term === undefined || term.length === 0
        ? {}
        : {
            OR: [
              { id: term },
              { slug: { contains: term, mode: "insensitive" } },
              { name: { contains: term, mode: "insensitive" } },
            ],
          },
    orderBy: { createdAt: "desc" },
    take: options.limit,
    include: {
      subscription: true,
      _count: { select: { memberships: true, runs: true } },
    },
  })

  if (tenants.length === 0) return []
  const ids = tenants.map((tenant) => tenant.id)

  const spend = await prisma.usageRecord.groupBy({
    by: ["tenantId"],
    where: { tenantId: { in: ids }, createdAt: { gte: options.from } },
    _sum: { costMicroCents: true },
  })
  const byTenant = new Map(
    spend.map((group) => [group.tenantId, Number(group._sum.costMicroCents ?? 0n)]),
  )

  return tenants.map((tenant) => ({
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    createdAt: tenant.createdAt.toISOString(),
    // A tenant with no row is on the free plan and active — the honest reading
    // of "nobody has ever billed them", and the same total the billing module
    // takes so the console and the API cannot disagree about a plan.
    subscription:
      tenant.subscription === null
        ? freeSubscription(tenant.createdAt)
        : toSubscription(tenant.subscription),
    memberCount: tenant._count.memberships,
    runCount: tenant._count.runs,
    costMicroCents: byTenant.get(tenant.id) ?? 0,
  }))
}

/** What the run inspector needs: the run, whose it is, and what it cost. */
export interface AdminRunRow {
  runId: string
  tenantId: string
  tenantSlug: string
  costMicroCents: number
  calls: number
}

/**
 * Resolve a run id an operator pasted in, without knowing whose it is.
 *
 * This is the query the console exists for. It returns identity and cost only —
 * the *contents* of the run are then read through the tenant-scoped
 * `getRun(tenantId, runId)`, so even here the body of a customer's prompt comes
 * out of the same function every other caller uses.
 */
export async function adminFindRun(options: {
  scope: OperatorScope
  runId: string
}): Promise<AdminRunRow | null> {
  const run = await prisma.run.findUnique({
    where: { id: options.runId },
    select: { id: true, tenantId: true, tenant: { select: { slug: true } } },
  })
  if (run === null) return null

  const usage = await prisma.usageRecord.aggregate({
    where: { runId: run.id },
    _sum: { costMicroCents: true },
    _count: { _all: true },
  })

  return {
    runId: run.id,
    tenantId: run.tenantId,
    tenantSlug: run.tenant.slug,
    costMicroCents: Number(usage._sum.costMicroCents ?? 0n),
    calls: usage._count._all,
  }
}

/** Install-wide counters for the console's header. */
export async function adminInstallCounts(options: {
  scope: OperatorScope
  /** Which statuses count as "in flight". Supplied so the console and the
   *  quota layer cannot drift about what an active run is. */
  activeStatuses: readonly RunStatus[]
}): Promise<{ tenants: number; activeRuns: number }> {
  const [tenants, activeRuns] = await Promise.all([
    prisma.tenant.count(),
    prisma.run.count({ where: { status: { in: [...options.activeStatuses] } } }),
  ])
  return { tenants, activeRuns }
}
