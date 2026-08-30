import {
  freeSubscription,
  idleKillSwitch,
  killSwitchScopeSchema,
  planIdSchema,
  subscriptionStatusSchema,
  type KillSwitch,
  type KillSwitchScope,
  type PlanId,
  type Subscription,
  type SubscriptionStatus,
} from "@sce/shared"
import { prisma } from "./client.ts"

/*
 * Subscriptions and the global kill switch.
 *
 * Two kinds of row live here and they are scoped differently on purpose:
 *
 *   - a `Subscription` belongs to exactly one tenant, and every read and write
 *     below names it;
 *   - a `KillSwitch` belongs to the *install*. It is the one control that must
 *     work when tenancy itself is the thing going wrong, so it has no tenant
 *     column and never will. `repository.scoping.test.ts` lists it as a global
 *     model with that reason attached.
 *
 * `getSubscription` is total: a tenant with no row is free and active. That is
 * not a default papering over a missing row — it is the correct reading of "no
 * money has ever changed hands", and it is why nothing in the system has to
 * handle a null subscription.
 */

type SubscriptionRow = Awaited<ReturnType<typeof prisma.subscription.findFirstOrThrow>>
type KillSwitchRow = Awaited<ReturnType<typeof prisma.killSwitch.findFirstOrThrow>>

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    plan: row.plan,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
    externalCustomerId: row.externalCustomerId,
    externalSubscriptionId: row.externalSubscriptionId,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toKillSwitch(row: KillSwitchRow): KillSwitch {
  return {
    // The column is `String` because the scope vocabulary lives in @sce/shared,
    // not in Postgres. Parsed on the way out: a row written by a newer build,
    // or by hand, must not become an unrecognised scope flowing into a
    // decision — an unreadable switch is treated as no switch, which fails
    // *closed* only because the caller then evaluates the budget itself.
    scope: killSwitchScopeSchema.parse(row.scope),
    engaged: row.engaged,
    reason: row.reason,
    engagedAt: row.engagedAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/* ---------------------------------------------------------- subscriptions */

/** What this tenant pays for. Free and active when nobody has ever billed them. */
export async function getSubscription(tenantId: string): Promise<Subscription> {
  const row = await prisma.subscription.findUnique({ where: { tenantId } })
  return row === null ? freeSubscription() : toSubscription(row)
}

/**
 * Fields a billing event may set.
 *
 * Every one is optional and an omitted field is left alone, because provider
 * events are partial by nature: a `paymentAttempt.failed` knows about dunning
 * and nothing about the period, and a handler that had to supply the whole row
 * would have to read-modify-write it — which is how two webhooks arriving
 * together lose one of their updates.
 */
export interface SubscriptionUpdate {
  tenantId: string
  plan?: PlanId
  status?: SubscriptionStatus
  externalCustomerId?: string | null
  externalSubscriptionId?: string | null
  currentPeriodStart?: Date | null
  currentPeriodEnd?: Date | null
  cancelAtPeriodEnd?: boolean
  graceEndsAt?: Date | null
}

/** Create or update a tenant's subscription. Idempotent, keyed on the tenant. */
export async function upsertSubscription(input: SubscriptionUpdate): Promise<Subscription> {
  const { tenantId, ...fields } = input

  const row = await prisma.subscription.upsert({
    where: { tenantId },
    create: { tenantId, ...fields },
    update: fields,
  })
  return toSubscription(row)
}

/**
 * Give a workspace the unmetered plan an install's *own* tenant should have.
 *
 * The bootstrap workspace is not a customer: nobody is going to upgrade it, and
 * a fresh install whose first run is refused because the free plan allows fifty
 * a month is a bad first five minutes. Total spend is still bounded — by the
 * global daily cap, which no plan turns off.
 *
 * Leaves an existing subscription alone, so running the seed again cannot
 * promote a workspace somebody has since put on a real plan.
 */
export async function ensureUnmeteredPlan(tenantId: string): Promise<Subscription> {
  const row = await prisma.subscription.upsert({
    where: { tenantId },
    create: { tenantId, plan: "enterprise", status: "ACTIVE" },
    update: {},
  })
  return toSubscription(row)
}

/**
 * Which tenant a billing-provider customer belongs to.
 *
 * Deliberately unscoped: this *resolves* the tenant, so it cannot be given one
 * — the same argument as `verifyApiKey` in `auth.ts`. Both identifiers are
 * unique columns, so the lookup is one indexed read and can never be ambiguous.
 */
export async function findTenantIdForBillingCustomer(identifiers: {
  customerId?: string | null
  subscriptionId?: string | null
}): Promise<string | null> {
  const clauses = [
    identifiers.customerId ? { externalCustomerId: identifiers.customerId } : null,
    identifiers.subscriptionId ? { externalSubscriptionId: identifiers.subscriptionId } : null,
  ].filter((clause) => clause !== null)

  if (clauses.length === 0) return null

  const row = await prisma.subscription.findFirst({
    where: { OR: clauses },
    select: { tenantId: true },
  })
  return row?.tenantId ?? null
}

/**
 * Plans and statuses arriving from a payment provider.
 *
 * A provider sends whatever its dashboard was configured with, so neither value
 * can be trusted to be one of ours. Unknown input yields null and the caller
 * ignores that field rather than throwing — an exception here would make the
 * provider retry an event forever over a plan name somebody typed in a web UI.
 */
export function parsePlanId(value: string): PlanId | null {
  return planIdSchema.safeParse(value.trim().toLowerCase()).data ?? null
}

export function parseSubscriptionStatus(value: string): SubscriptionStatus | null {
  return subscriptionStatusSchema.safeParse(value.trim().toUpperCase().replace(/-/g, "_")).data ?? null
}

/* ------------------------------------------------------------ kill switch */

/** The switch's current state. A switch nobody has touched is simply idle. */
export async function getKillSwitch(scope: KillSwitchScope): Promise<KillSwitch> {
  const row = await prisma.killSwitch.findUnique({ where: { scope } })
  return row === null ? idleKillSwitch(scope) : toKillSwitch(row)
}

/**
 * Stop the install.
 *
 * Idempotent, and deliberately so: several replicas can observe the same budget
 * breach in the same second, and the second one to arrive must not overwrite
 * the first one's reason or its timestamp. Only a transition from released to
 * engaged records a new `engagedAt`.
 */
export async function engageKillSwitch(
  scope: KillSwitchScope,
  reason: string,
  now: Date = new Date(),
): Promise<KillSwitch> {
  const existing = await prisma.killSwitch.findUnique({ where: { scope } })
  if (existing?.engaged === true) return toKillSwitch(existing)

  const row = await prisma.killSwitch.upsert({
    where: { scope },
    create: { scope, engaged: true, reason, engagedAt: now, releasedAt: null },
    update: { engaged: true, reason, engagedAt: now, releasedAt: null },
  })
  return toKillSwitch(row)
}

/**
 * Start it again.
 *
 * Only ever called by an operator. There is no timer that releases this by
 * itself: whatever spent the money is still there until somebody has looked,
 * and an automatic release would simply reproduce the incident an hour later.
 */
export async function releaseKillSwitch(
  scope: KillSwitchScope,
  now: Date = new Date(),
): Promise<KillSwitch> {
  const row = await prisma.killSwitch.upsert({
    where: { scope },
    create: { scope, engaged: false, reason: null, releasedAt: now },
    update: { engaged: false, reason: null, releasedAt: now },
  })
  return toKillSwitch(row)
}
