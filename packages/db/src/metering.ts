import {
  dayStart,
  isTerminalRunStatus,
  monthWindow,
  runStatusSchema,
  type QuotaSnapshot,
  type RunStatus,
  type TenantSpend,
  type UsageDaily,
  type UsageDayEntry,
} from "@sce/shared"
import { prisma } from "./client.ts"
import { usageTotals } from "./repository.ts"

/*
 * Metering reads: the counters quotas are decided against, and the rollups the
 * cost dashboard is drawn from.
 *
 * Two different jobs, deliberately kept apart:
 *
 *   - **Enforcement** reads `UsageRecord` directly. It has to be exact — a
 *     quota decided from a stale rollup is a quota that can be walked straight
 *     through by starting runs faster than the rollup interval.
 *   - **Reporting** reads `UsageDaily`, which the worker recomputes on a timer.
 *     A dashboard that scans every metering row is the query that takes the
 *     database down on the day the dashboard matters most.
 *
 * The rollup is a *recompute*, not an increment: it sums the source rows for a
 * day and writes the answer. A retried job, a late-arriving record and a manual
 * backfill therefore all converge on the same numbers instead of each adding
 * their own copy.
 */

/**
 * Who a metering read covers.
 *
 * Same shape and same reasoning as `RunScope` in `repository.ts`: the
 * install-wide variant exists — the daily budget guard and the rollup job both
 * genuinely span tenants — but it cannot be reached without typing the reason
 * at the call site, so it is a visible decision in a diff rather than a filter
 * somebody forgot.
 */
export type MeteringScope =
  | { kind: "tenant"; tenantId: string }
  | {
      kind: "every-tenant"
      reason:
        | "the global spend guard measures the whole install"
        | "the usage rollup recomputes every tenant's day"
        | "the operator cost report is cross-tenant by definition"
    }

function scopeFilter(scope: MeteringScope): { tenantId?: string } {
  return scope.kind === "tenant" ? { tenantId: scope.tenantId } : {}
}

/** Statuses a run can still be doing work in. Derived, so it cannot go stale. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = runStatusSchema.options.filter(
  (status) => !isTerminalRunStatus(status),
)

/* ------------------------------------------------------------ enforcement */

/** Runs this tenant has in flight right now. */
export async function countActiveRuns(tenantId: string): Promise<number> {
  return prisma.run.count({
    where: { tenantId, status: { in: [...ACTIVE_RUN_STATUSES] } },
  })
}

/**
 * The four numbers a quota decision is made from.
 *
 * Gathered here, in one call, so the decision is made against one reading
 * rather than four staggered ones — and so `evaluateQuota` in @sce/shared can
 * stay pure and be tested without a database.
 */
export async function tenantQuotaSnapshot(options: {
  tenantId: string
  now?: Date
}): Promise<QuotaSnapshot> {
  const window = monthWindow(options.now ?? new Date())

  const [totals, activeRuns] = await Promise.all([
    usageTotals({ tenantId: options.tenantId, from: window.from, to: window.to }),
    countActiveRuns(options.tenantId),
  ])

  return {
    runs: totals.runs,
    tokens: totals.inputTokens + totals.outputTokens,
    costMicroCents: totals.costMicroCents,
    activeRuns,
  }
}

/**
 * Metered spend across every tenant since a moment, in micro-cents.
 *
 * The global daily budget guard's only query. It is a range scan over
 * `UsageRecord.createdAt` — which is what the index added in this phase's
 * migration exists for — and the API caches its result for a few seconds
 * rather than issuing it per request.
 */
export async function globalSpendSince(options: {
  since: Date
  scope: MeteringScope
}): Promise<number> {
  const aggregate = await prisma.usageRecord.aggregate({
    where: { ...scopeFilter(options.scope), createdAt: { gte: options.since } },
    _sum: { costMicroCents: true },
  })
  return Number(aggregate._sum.costMicroCents ?? 0n)
}

/* --------------------------------------------------------------- rollups */

/**
 * Recompute one UTC day's rollup.
 *
 * Returns the number of `(tenant, provider, model)` rows written. Rows that
 * exist for the day but no longer have any source records — a run deleted after
 * the fact — are zeroed rather than left stale, because a dashboard showing
 * spend for usage that no longer exists is worse than one showing none.
 */
export async function rollupUsage(options: {
  day: Date
  scope: MeteringScope
  now?: Date
}): Promise<number> {
  const from = dayStart(options.day)
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
  const rolledUpAt = options.now ?? new Date()

  const groups = await prisma.usageRecord.groupBy({
    by: ["tenantId", "provider", "model"],
    where: { ...scopeFilter(options.scope), createdAt: { gte: from, lt: to } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, costMicroCents: true },
  })

  for (const group of groups) {
    const data = {
      calls: group._count._all,
      inputTokens: group._sum.inputTokens ?? 0,
      outputTokens: group._sum.outputTokens ?? 0,
      costMicroCents: group._sum.costMicroCents ?? 0n,
      rolledUpAt,
    }
    await prisma.usageDaily.upsert({
      where: {
        tenantId_day_provider_model: {
          tenantId: group.tenantId,
          day: from,
          provider: group.provider,
          model: group.model,
        },
      },
      create: {
        tenantId: group.tenantId,
        day: from,
        provider: group.provider,
        model: group.model,
        ...data,
      },
      update: data,
    })
  }

  // Anything summarised for this day that the recompute no longer accounts for.
  const survivors = groups.map((group) => `${group.tenantId}|${group.provider}|${group.model}`)
  const stale = await prisma.usageDaily.findMany({
    where: { ...scopeFilter(options.scope), day: from },
    select: { id: true, tenantId: true, provider: true, model: true },
  })
  const orphans = stale.filter(
    (row) => !survivors.includes(`${row.tenantId}|${row.provider}|${row.model}`),
  )
  for (const orphan of orphans) {
    await prisma.usageDaily.updateMany({
      where: { id: orphan.id, tenantId: orphan.tenantId },
      data: { calls: 0, inputTokens: 0, outputTokens: 0, costMicroCents: 0n, rolledUpAt },
    })
  }

  return groups.length
}

function toDayEntry(row: {
  day: Date
  provider: UsageDayEntry["provider"]
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  costMicroCents: bigint
}): UsageDayEntry {
  return {
    day: row.day.toISOString().slice(0, 10),
    provider: row.provider,
    model: row.model,
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicroCents: Number(row.costMicroCents),
  }
}

/** One tenant's per-day, per-model spend over a window. */
export async function listUsageDaily(options: {
  tenantId: string
  from: Date
  to: Date
}): Promise<UsageDaily> {
  const from = dayStart(options.from)
  const to = dayStart(options.to)

  const rows = await prisma.usageDaily.findMany({
    where: { tenantId: options.tenantId, day: { gte: from, lte: to } },
    orderBy: [{ day: "asc" }, { provider: "asc" }, { model: "asc" }],
  })

  // The freshest rollup in the window is the "as of" the whole window can
  // honestly claim — an older row was simply not touched by the last sweep.
  const rolledUpAt = rows.reduce<Date | null>(
    (latest, row) => (latest === null || row.rolledUpAt > latest ? row.rolledUpAt : latest),
    null,
  )

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    entries: rows.map(toDayEntry),
    rolledUpAt: rolledUpAt?.toISOString() ?? null,
  }
}

/**
 * Spend by tenant over a window — the operator-facing cost report.
 *
 * Cross-tenant by definition, which is why it takes a `MeteringScope`: this is
 * the query behind "who spent the money today", and it is only ever run by an
 * operator command, never on behalf of a tenant.
 */
export async function spendByTenant(options: {
  scope: MeteringScope
  from: Date
  to?: Date
  limit?: number
}): Promise<TenantSpend[]> {
  const window = {
    createdAt: { gte: options.from, ...(options.to ? { lt: options.to } : {}) },
  }

  const groups = await prisma.usageRecord.groupBy({
    by: ["tenantId"],
    where: { ...scopeFilter(options.scope), ...window },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, costMicroCents: true },
    orderBy: { _sum: { costMicroCents: "desc" } },
    take: options.limit ?? 50,
  })

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: groups.map((group) => group.tenantId) } },
    select: { id: true, slug: true },
  })
  const slugs = new Map(tenants.map((tenant) => [tenant.id, tenant.slug]))

  return groups.map((group) => ({
    tenantId: group.tenantId,
    slug: slugs.get(group.tenantId) ?? "(deleted)",
    calls: group._count._all,
    inputTokens: group._sum.inputTokens ?? 0,
    outputTokens: group._sum.outputTokens ?? 0,
    costMicroCents: Number(group._sum.costMicroCents ?? 0n),
  }))
}
