import {
  engageKillSwitch,
  getKillSwitch,
  getSubscription,
  globalSpendSince,
  recordAuditSafely,
  tenantQuotaSnapshot,
  usageTotals,
} from "@sce/db"
import {
  actorTypeFor,
  budgetExhausted,
  budgetTrippedMessage,
  dayStart,
  effectivePlan,
  entitlementsFor,
  evaluateQuota,
  hasEntitlement,
  monthWindow,
  planFor,
  quotaStatuses,
  resolveAccess,
  GLOBAL_SPEND_SWITCH,
  type Access,
  type Actor,
  type Feature,
  type GlobalBudget,
  type PlanId,
  type QuotaSnapshot,
  type Subscription,
  type UsageSummary,
} from "@sce/shared"
import { config } from "./env.ts"
import {
  BudgetExhaustedError,
  FeatureUnavailableError,
  PaymentRequiredError,
  QuotaExceededError,
  describeError,
} from "./errors.ts"

/**
 * The spend gate.
 *
 * Everything in this file runs **before** a run is persisted or enqueued, which
 * is the entire point: a quota discovered after three provider calls have been
 * paid for is a report, not a limit. Three independent things have to agree
 * before a request is allowed to cost money, and they are checked cheapest and
 * most catastrophic first:
 *
 *   1. **The install** is not stopped — the global daily budget cap and its
 *      kill switch. This is the blast-radius control, and no plan or contract
 *      turns it off.
 *   2. **The subscription** can fund new work — an unpaid tenant past its grace
 *      period keeps every read and loses every write.
 *   3. **The plan's ceilings** have not been reached — runs, tokens, spend and
 *      concurrency for the calendar month.
 *
 * The decisions themselves live in `@sce/shared` and are pure. This file is
 * only the part that has to read Postgres.
 */

/* ------------------------------------------------------------ tenant state */

/** A tenant's commercial state, resolved once per request that needs it. */
export interface BillingSnapshot {
  subscription: Subscription
  /** The plan whose limits actually apply — free once access is restricted. */
  plan: PlanId
  access: Access
}

export async function loadBilling(
  tenantId: string,
  now: Date = new Date(),
): Promise<BillingSnapshot> {
  const subscription = await getSubscription(tenantId)
  return {
    subscription,
    plan: effectivePlan(subscription, now),
    access: resolveAccess(subscription, now),
  }
}

/** Refuse anything that would start new spend while access is read-only. */
export function assertWritable(billing: BillingSnapshot): void {
  if (billing.access.mode === "read-only") throw new PaymentRequiredError(billing.access)
}

/**
 * Refuse a capability the plan does not include.
 *
 * The same function the client uses to decide whether to *offer* the feature,
 * so the two can never disagree — a feature that is only hidden in the
 * interface is not gated at all.
 */
export function assertEntitlement(plan: PlanId, feature: Feature): void {
  if (!hasEntitlement(plan, feature)) throw new FeatureUnavailableError(feature, plan)
}

/* ----------------------------------------------------------- global budget */

interface BudgetCache {
  /** Start of the UTC day these figures cover. */
  since: number
  readAt: number
  budget: GlobalBudget
}

let budgetCache: BudgetCache | null = null

/** Drop the cached global spend reading. Tests use this; production does not. */
export function resetBudgetCache(): void {
  budgetCache = null
}

/**
 * Today's spend across the whole install, and the switch it can trip.
 *
 * Cached for `GLOBAL_BUDGET_REFRESH_MS`, because this is an aggregate over
 * every metering row written today and it would otherwise run on every single
 * `POST /runs`. The cost of the cache is bounded overshoot — at most one
 * refresh window's worth of spend past the cap — and that is the right trade
 * against issuing the query per request. The window is a knob for exactly that
 * reason.
 */
export async function globalBudgetStatus(now: Date = new Date()): Promise<GlobalBudget> {
  const since = dayStart(now)
  const fresh =
    budgetCache !== null &&
    budgetCache.since === since.getTime() &&
    now.getTime() - budgetCache.readAt < config.budget.refreshMs

  if (fresh && budgetCache !== null) return budgetCache.budget

  const [spentMicroCents, killSwitch] = await Promise.all([
    globalSpendSince({
      since,
      scope: {
        kind: "every-tenant",
        reason: "the global spend guard measures the whole install",
      },
    }),
    getKillSwitch(GLOBAL_SPEND_SWITCH),
  ])

  const cap = config.budget.globalDailyMicroCents
  const budget: GlobalBudget = {
    capMicroCents: cap,
    spentMicroCents,
    remainingMicroCents: cap === 0 ? null : Math.max(0, cap - spentMicroCents),
    since: since.toISOString(),
    killSwitch,
  }

  budgetCache = { since: since.getTime(), readAt: now.getTime(), budget }
  return budget
}

/**
 * Stop the install if today's spend has reached the cap.
 *
 * Tripping is a persisted, install-wide switch rather than a per-replica flag:
 * an incident that only half the fleet knows about is not contained. It stays
 * tripped until an operator releases it — see `doc/runbooks/cost.md` — because
 * automatically resuming spend after a runaway simply reproduces the incident
 * an hour later.
 */
export async function guardGlobalBudget(now: Date = new Date()): Promise<GlobalBudget> {
  const budget = await globalBudgetStatus(now)

  if (budget.killSwitch.engaged) throw new BudgetExhaustedError(budget.killSwitch)

  if (!budgetExhausted(budget.capMicroCents, budget.spentMicroCents)) return budget

  const reason = budgetTrippedMessage(
    budget.capMicroCents,
    budget.spentMicroCents,
    new Date(budget.since),
  )

  // This log line is the page. Phase 8 alerts on it; until then it is what an
  // operator greps for, so it carries every number needed to decide what to do
  // without opening a database.
  console.error("[budget] global daily cap reached — engaging kill switch", {
    capMicroCents: budget.capMicroCents,
    spentMicroCents: budget.spentMicroCents,
    since: budget.since,
  })

  const killSwitch = await engageGlobalSwitch(reason, now)
  budgetCache = {
    since: dayStart(now).getTime(),
    readAt: now.getTime(),
    budget: { ...budget, killSwitch },
  }
  throw new BudgetExhaustedError(killSwitch)
}

/**
 * Engage the switch and record who did it.
 *
 * Tolerant of its own failure on purpose: if the switch cannot be persisted the
 * request must still be refused, because the alternative — letting spend
 * continue because the *stop* mechanism is broken — is the worse of the two
 * failures.
 */
async function engageGlobalSwitch(reason: string, now: Date): Promise<GlobalBudget["killSwitch"]> {
  try {
    const killSwitch = await engageKillSwitch(GLOBAL_SPEND_SWITCH, reason, now)
    await recordAuditSafely({
      tenantId: null,
      action: "BUDGET_TRIPPED",
      actorType: "SYSTEM",
      resourceType: "kill_switch",
      resourceId: GLOBAL_SPEND_SWITCH,
      metadata: { reason },
    })
    return killSwitch
  } catch (error: unknown) {
    console.error("[budget] could not persist the kill switch", {
      error: describeError(error),
    })
    return {
      scope: GLOBAL_SPEND_SWITCH,
      engaged: true,
      reason,
      engagedAt: now.toISOString(),
      releasedAt: null,
      updatedAt: now.toISOString(),
    }
  }
}

/* --------------------------------------------------------------- run gate */

/** Everything the run route learned while deciding it was allowed to proceed. */
export interface RunAllowance {
  billing: BillingSnapshot
  snapshot: QuotaSnapshot
  /**
   * Per-run ceilings, stamped onto the row so the worker enforces them.
   *
   * Narrowed to what is left of the *monthly* budget, which is what stops a
   * single enormous run from spending a whole month's allowance in one go —
   * the monthly check happens before a run starts, and this is what carries it
   * into the middle of one.
   */
  limits: { maxTotalTokens: number; maxCostMicroCents: number }
}

/**
 * Narrow a configured per-run ceiling to what the plan has left this month.
 *
 * A configured ceiling of zero means "no per-run ceiling" (that is what the
 * worker reads), so the plan's remainder governs on its own in that case.
 */
function narrowCeiling(configured: number, remaining: number | null): number {
  if (remaining === null) return configured
  // `remaining` is at least 1 here: a remainder of zero would have been refused
  // by the quota check above. Flooring at 1 anyway, because a ceiling of zero
  // means "unlimited" to the worker, and inverting a limit is the worst way for
  // this to be wrong.
  const left = Math.max(1, remaining)
  return configured === 0 ? left : Math.min(configured, left)
}

/**
 * May this actor start a run, and under what ceilings?
 *
 * Throws an `AppError` — mapped to its status and typed body by `onError` — so
 * the route reads as one line and cannot forget to act on a refusal.
 */
export async function assertRunAllowed(
  actor: Actor,
  options: { now?: Date; ip?: string | null; userAgent?: string | null } = {},
): Promise<RunAllowance> {
  const now = options.now ?? new Date()

  await guardGlobalBudget(now)

  const billing = await loadBilling(actor.tenantId, now)
  assertWritable(billing)

  const snapshot = await tenantQuotaSnapshot({ tenantId: actor.tenantId, now })
  const decision = evaluateQuota(billing.plan, snapshot, now)

  if (!decision.allowed) {
    // Recorded because "we blocked a paying customer" is a fact somebody will
    // want to reconstruct later — during a support conversation, or when
    // deciding whether a limit is set in the right place.
    await recordAuditSafely({
      tenantId: actor.tenantId,
      action: "QUOTA_EXCEEDED",
      actorType: actorTypeFor(actor.credential),
      actorId: actor.userId ?? actor.credentialId,
      resourceType: "quota",
      resourceId: decision.violation.limit,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      metadata: {
        plan: billing.plan,
        limit: decision.violation.limit,
        used: decision.violation.used,
        ceiling: decision.violation.ceiling,
      },
    })
    throw new QuotaExceededError(decision.violation)
  }

  const limits = planFor(billing.plan).limits
  return {
    billing,
    snapshot,
    limits: {
      maxTotalTokens: narrowCeiling(
        config.runMaxTotalTokens,
        limits.monthlyTokens === null ? null : limits.monthlyTokens - snapshot.tokens,
      ),
      maxCostMicroCents: narrowCeiling(
        config.runMaxCostMicroCents,
        limits.monthlyCostMicroCents === null
          ? null
          : limits.monthlyCostMicroCents - snapshot.costMicroCents,
      ),
    },
  }
}

/* ---------------------------------------------------------------- reporting */

/**
 * What a tenant has spent and what it is allowed — in one response.
 *
 * The quota figures come from the same `quotaStatuses()` that refuses the next
 * request, so the number a user reads and the number that blocks them are one
 * calculation rather than two implementations of the same rule.
 */
export async function usageSummaryFor(
  tenantId: string,
  now: Date = new Date(),
): Promise<UsageSummary> {
  const window = monthWindow(now)

  const [billing, usage, snapshot] = await Promise.all([
    loadBilling(tenantId, now),
    usageTotals({ tenantId, from: window.from, to: window.to }),
    tenantQuotaSnapshot({ tenantId, now }),
  ])

  return {
    usage,
    period: { from: window.from.toISOString(), to: window.to.toISOString() },
    plan: billing.plan,
    quotas: quotaStatuses(billing.plan, snapshot, now),
    entitlements: [...entitlementsFor(billing.plan)],
    subscription: billing.subscription,
    access: billing.access,
  }
}
