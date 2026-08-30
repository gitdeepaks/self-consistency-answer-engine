import type {
  BillingPaymentAttemptWebhookEvent,
  BillingSubscriptionWebhookEvent,
  WebhookEvent,
} from "@clerk/backend/webhooks"
import {
  findTenantIdForBillingCustomer,
  findUserByExternalId,
  getSubscription,
  getTenantByExternalId,
  listMemberships,
  parsePlanId,
  upsertSubscription,
} from "@sce/db"
import { graceDeadline, type PlanId, type SubscriptionStatus } from "@sce/shared"
import { config } from "./env.ts"

/**
 * Clerk Billing → the `Subscription` table.
 *
 * Clerk is the authority on *what was paid*; this database is the authority on
 * *what that entitles a tenant to do*. Keeping the second here rather than
 * asking Clerk on every request is what makes a quota check one indexed read
 * instead of a network call to a third party in the hot path of every run.
 *
 * Three properties, and each one is a decision rather than an accident:
 *
 *   **Partial updates.** A payment event knows about dunning and nothing about
 *   the period; a subscription event is the reverse. Every field is optional in
 *   `upsertSubscription`, so a handler writes only what its event actually
 *   established and two events arriving together cannot lose each other's work.
 *
 *   **Fail closed on ambiguity, not loudly.** An event we cannot attribute to
 *   exactly one tenant is acknowledged and logged, never guessed at and never
 *   retried for ever. Attaching somebody's subscription to the wrong workspace
 *   is worse than missing it.
 *
 *   **Unknown states are left alone.** Clerk's status vocabulary is wider than
 *   ours and will grow. A status this build cannot map changes nothing rather
 *   than defaulting a paying customer into a restrictive state.
 */

/** The bits of a Clerk payer that can identify a tenant. */
interface BillingPayer {
  organization_id?: string | undefined
  user_id?: string | undefined
}

/**
 * Which workspace an event is about.
 *
 * Organizations map to tenants one-for-one (ADR-0005), so an organization payer
 * is unambiguous. A *user* payer is not: a person can belong to several
 * workspaces, and "their oldest membership" is a guess with a bill attached. So
 * a user payer resolves only when they belong to exactly one tenant, and
 * otherwise the event is skipped with a line in the log naming why.
 */
async function resolveTenantId(
  payer: BillingPayer | undefined,
  identifiers: { customerId?: string | null; subscriptionId?: string | null },
): Promise<string | null> {
  if (payer?.organization_id !== undefined) {
    const tenant = await getTenantByExternalId(payer.organization_id)
    if (tenant !== null) return tenant.id
  }

  if (payer?.user_id !== undefined) {
    const user = await findUserByExternalId(payer.user_id)
    if (user !== null) {
      const memberships = await listMemberships(user.id)
      const only = memberships.length === 1 ? memberships[0] : undefined
      if (only !== undefined) return only.tenant.id
      console.warn("[billing] user payer belongs to several workspaces; skipping", {
        externalUserId: payer.user_id,
        memberships: memberships.length,
      })
    }
  }

  // A later event for a subscription we have already recorded can be attributed
  // from the ids on the row itself, even when the payer has since changed shape.
  return findTenantIdForBillingCustomer(identifiers)
}

/**
 * Clerk's subscription status, in our vocabulary.
 *
 * `null` means "this build does not model that state" and the caller leaves the
 * status untouched. `incomplete` and `upcoming` are deliberately in that
 * bucket: they describe a checkout that has not finished, and turning a person
 * halfway through paying us into a read-only workspace is precisely the wrong
 * response.
 */
function mapSubscriptionStatus(status: string): SubscriptionStatus | null {
  switch (status) {
    case "active":
      return "ACTIVE"
    case "past_due":
      return "PAST_DUE"
    case "canceled":
    case "ended":
    case "expired":
    case "abandoned":
      return "CANCELED"
    default:
      return null
  }
}

/** Unix seconds from Clerk, as a `Date`. Zero and undefined both mean "unset". */
function fromUnixSeconds(seconds: number | undefined | null): Date | null {
  if (seconds === undefined || seconds === null || seconds <= 0) return null
  return new Date(seconds * 1000)
}

/**
 * The plan a subscription's items describe.
 *
 * Clerk's plan slug is configured in its dashboard, so it is untrusted text
 * like any other: `parsePlanId` returns null for anything that is not one of
 * ours, and an unrecognised plan leaves the recorded plan alone rather than
 * silently downgrading a customer to free.
 */
function planFromItems(
  items: BillingSubscriptionWebhookEvent["data"]["items"],
): { plan: PlanId | null; periodStart: Date | null; periodEnd: Date | null } {
  for (const item of items) {
    const slug = item.plan?.slug
    const plan = slug === undefined ? null : parsePlanId(slug)
    if (plan === null) continue
    return {
      plan,
      periodStart: fromUnixSeconds(item.period_start),
      periodEnd: fromUnixSeconds(item.period_end),
    }
  }

  const first = items[0]
  return {
    plan: null,
    periodStart: first ? fromUnixSeconds(first.period_start) : null,
    periodEnd: first ? fromUnixSeconds(first.period_end) : null,
  }
}

async function applySubscriptionEvent(
  event: BillingSubscriptionWebhookEvent,
  now: Date,
): Promise<string | null> {
  const { data } = event

  const tenantId = await resolveTenantId(data.payer, {
    customerId: data.payer_id,
    subscriptionId: data.id,
  })
  if (tenantId === null) {
    console.warn("[billing] no tenant for subscription event", {
      type: event.type,
      subscriptionId: data.id,
    })
    return null
  }

  const status = mapSubscriptionStatus(data.status)
  const { plan, periodStart, periodEnd } = planFromItems(data.items)

  /*
   * The provider ids are unique columns, because they are how a later event
   * finds its tenant. If they already belong to a *different* workspace — a
   * subscription re-pointed at another organization, a test fixture, an
   * operator moving a customer — writing them here would violate that
   * constraint, and a webhook that throws is a webhook Svix retries for ever.
   *
   * So the event is still applied to the workspace the payer names, minus the
   * ids. Attribution keeps working (the payer's organization is what resolved
   * this tenant in the first place), and the conflict is logged for a human
   * rather than turned into an infinite retry loop.
   */
  const idsOwner = await findTenantIdForBillingCustomer({
    customerId: data.payer_id,
    subscriptionId: data.id,
  })
  const idsAreOurs = idsOwner === null || idsOwner === tenantId
  if (!idsAreOurs) {
    console.warn("[billing] subscription ids already belong to another workspace", {
      subscriptionId: data.id,
      claimedBy: idsOwner,
      resolved: tenantId,
    })
  }

  // Dunning starts the moment a subscription goes past due, and only then: an
  // existing grace window must not be extended by every repeat of the same
  // event, or a tenant would stay in grace for as long as Clerk keeps retrying.
  const existing = await getSubscription(tenantId)
  const graceEndsAt =
    status === "PAST_DUE"
      ? existing.graceEndsAt === null || existing.status !== "PAST_DUE"
        ? graceDeadline(fromUnixSeconds(data.past_due_at) ?? now, config.billing.gracePeriodDays)
        : new Date(existing.graceEndsAt)
      : null

  await upsertSubscription({
    tenantId,
    ...(plan === null ? {} : { plan }),
    ...(status === null ? {} : { status }),
    ...(idsAreOurs
      ? { externalCustomerId: data.payer_id, externalSubscriptionId: data.id }
      : {}),
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: fromUnixSeconds(data.canceled_at) !== null,
    ...(status === null ? {} : { graceEndsAt }),
  })

  return `subscription ${data.id} → ${plan ?? existing.plan}/${status ?? existing.status}`
}

async function applyPaymentAttemptEvent(
  event: BillingPaymentAttemptWebhookEvent,
  now: Date,
): Promise<string | null> {
  const { data } = event

  // Only settled attempts say anything: `pending` is the state a card is in
  // while it is being charged, and acting on it would put a paying tenant into
  // dunning for the few seconds a normal payment takes.
  if (data.status !== "failed" && data.status !== "paid") return null

  const tenantId = await resolveTenantId(data.payer, { customerId: data.payer.id })
  if (tenantId === null) {
    console.warn("[billing] no tenant for payment attempt", {
      type: event.type,
      paymentId: data.payment_id,
    })
    return null
  }

  if (data.status === "paid") {
    // Recovery: the card went through, so dunning is over. Nothing else about
    // the subscription is asserted here — the subscription event carries that.
    await upsertSubscription({ tenantId, status: "ACTIVE", graceEndsAt: null })
    return `payment ${data.payment_id} paid`
  }

  const existing = await getSubscription(tenantId)
  const failedAt = fromUnixSeconds(data.failed_at) ?? now
  const graceEndsAt =
    existing.status === "PAST_DUE" && existing.graceEndsAt !== null
      ? new Date(existing.graceEndsAt)
      : graceDeadline(failedAt, config.billing.gracePeriodDays)

  await upsertSubscription({ tenantId, status: "PAST_DUE", graceEndsAt })
  return `payment ${data.payment_id} failed — grace until ${graceEndsAt.toISOString()}`
}

/**
 * Apply one verified billing event.
 *
 * Returns the audit note for what it did, or null for an event that was
 * deliberately not acted on — which is a 2xx either way, because asking Clerk
 * to retry an event this build will never understand is an infinite loop.
 */
export async function applyBillingEvent(
  event: WebhookEvent,
  now: Date = new Date(),
): Promise<string | null> {
  switch (event.type) {
    case "subscription.created":
    case "subscription.updated":
    case "subscription.active":
    case "subscription.pastDue":
      return applySubscriptionEvent(event, now)

    case "paymentAttempt.created":
    case "paymentAttempt.updated":
      return applyPaymentAttemptEvent(event, now)

    default:
      // Not exhaustive on purpose: this is called from the identity handler's
      // fall-through, and every non-billing event belongs to that handler.
      return null
  }
}

/** Does this event type belong to billing? Used to pick the audit action. */
export function isBillingEvent(type: WebhookEvent["type"]): boolean {
  return type.startsWith("subscription") || type.startsWith("paymentAttempt")
}
