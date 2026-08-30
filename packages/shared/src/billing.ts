import { z } from "zod"
import { assertNever } from "./assert.ts"
import { DEFAULT_PLAN_ID, planIdSchema, type PlanId } from "./plans.ts"

/**
 * Subscriptions, grace periods and what a tenant may still do when payment
 * fails.
 *
 * The rule this file exists to enforce: **a billing problem never destroys
 * data, and never silently deletes access.** A tenant whose card fails keeps
 * every run they have ever made and can keep reading them; what they lose,
 * after a stated grace period, is the ability to spend more of our money. That
 * asymmetry — reads survive, writes stop — is what "read-only mode" means
 * everywhere below.
 *
 * Like plans, this is pure: the provider (Clerk Billing, or Stripe) writes rows
 * through the webhook handler, and every decision about what those rows *mean*
 * is made here, where it can be tested without a payment provider.
 */

/**
 * Lifecycle of a paid subscription.
 *
 * SCREAMING_SNAKE because these labels are also the Postgres enum — the same
 * argument as `AuditAction` in `auth.ts`: a mapping layer between the database
 * and this union is exactly where the two would drift apart.
 */
export const subscriptionStatusSchema = z.enum([
  /** Paid and current. */
  "ACTIVE",
  /** Inside a trial. Treated exactly like ACTIVE until it ends. */
  "TRIALING",
  /** A payment failed. Dunning has started; see `graceEndsAt`. */
  "PAST_DUE",
  /** Ended, by the customer or by us. Data is kept; writes stop. */
  "CANCELED",
  /** Suspended by an operator — abuse, chargeback, manual hold. */
  "PAUSED",
])
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>

export const subscriptionSchema = z.object({
  plan: planIdSchema,
  status: subscriptionStatusSchema,
  /** Current billing period, when the provider has told us one. */
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  /** The customer has asked to stop at the end of the current period. */
  cancelAtPeriodEnd: z.boolean(),
  /**
   * When dunning runs out, ISO-8601. Set the moment a payment fails; until it
   * passes, a `PAST_DUE` tenant keeps working exactly as before.
   */
  graceEndsAt: z.string().nullable(),
  /** Provider ids, kept so a webhook can find the tenant it is about. */
  externalCustomerId: z.string().nullable(),
  externalSubscriptionId: z.string().nullable(),
  updatedAt: z.string(),
})
export type Subscription = z.infer<typeof subscriptionSchema>

/**
 * The subscription a tenant has when nobody has ever billed them.
 *
 * A missing row is not an error and must not be one: every install starts here,
 * and the bootstrap workspace never leaves. Free and active is the honest
 * reading of "no subscription", and it keeps `getSubscription` total.
 */
export function freeSubscription(now: Date = new Date()): Subscription {
  return {
    plan: DEFAULT_PLAN_ID,
    status: "ACTIVE",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    externalCustomerId: null,
    externalSubscriptionId: null,
    updatedAt: now.toISOString(),
  }
}

/* ------------------------------------------------------------------ access */

/**
 * What a tenant may do right now.
 *
 * `full` is everything. `read-only` still serves every GET — history, answers,
 * usage, keys — and refuses anything that would start new spend. There is no
 * third mode, and in particular there is no mode that hides data: locking a
 * customer out of work they have already paid for, over a card that expired
 * yesterday, is a support incident, not a control.
 */
export const accessModeSchema = z.enum(["full", "read-only"])
export type AccessMode = z.infer<typeof accessModeSchema>

/** Why access is restricted. Null when it is not. */
export const accessReasonSchema = z.enum([
  "payment_past_due",
  "subscription_canceled",
  "subscription_paused",
])
export type AccessReason = z.infer<typeof accessReasonSchema>

export const accessSchema = z.object({
  mode: accessModeSchema,
  reason: accessReasonSchema.nullable(),
  /** Set while dunning is still running, so a client can show the countdown. */
  graceEndsAt: z.string().nullable(),
  /** A sentence safe to show a user. Empty when access is full. */
  message: z.string(),
})
export type Access = z.infer<typeof accessSchema>

const FULL_ACCESS: Access = {
  mode: "full",
  reason: null,
  graceEndsAt: null,
  message: "",
}

/** Is the grace period still running? A missing date means it is not. */
function withinGrace(graceEndsAt: string | null, now: Date): boolean {
  if (graceEndsAt === null) return false
  const ends = Date.parse(graceEndsAt)
  return !Number.isNaN(ends) && ends > now.getTime()
}

/**
 * Resolve a subscription into what the tenant may do.
 *
 * An exhaustive switch, because the interesting cases here are the ones nobody
 * thought about: adding a status without deciding whether it stops writes is a
 * compile error rather than a silently permissive default.
 */
export function resolveAccess(
  subscription: Subscription,
  now: Date = new Date(),
): Access {
  switch (subscription.status) {
    case "ACTIVE":
    case "TRIALING":
      return FULL_ACCESS

    case "PAST_DUE": {
      // Dunning: the failure is known, the customer has been told, and they
      // keep working until the grace period runs out. A `PAST_DUE` row with no
      // grace date is a state somebody set deliberately (or a provider event we
      // could not read a date from) and is treated as expired — failing open
      // there would make the whole dunning path unenforceable.
      if (withinGrace(subscription.graceEndsAt, now)) {
        return {
          mode: "full",
          reason: "payment_past_due",
          graceEndsAt: subscription.graceEndsAt,
          message:
            "A payment failed. Update the card on file before " +
            `${subscription.graceEndsAt} to avoid interruption.`,
        }
      }
      return {
        mode: "read-only",
        reason: "payment_past_due",
        graceEndsAt: subscription.graceEndsAt,
        message:
          "This workspace is read-only because a payment failed. Existing runs " +
          "remain available; update the card on file to start new ones.",
      }
    }

    case "CANCELED":
      return {
        mode: "read-only",
        reason: "subscription_canceled",
        graceEndsAt: null,
        message:
          "This subscription has ended. Existing runs remain available; " +
          "resubscribe to start new ones.",
      }

    case "PAUSED":
      return {
        mode: "read-only",
        reason: "subscription_paused",
        graceEndsAt: null,
        message: "This workspace is paused. Contact support to restore access.",
      }

    default:
      return assertNever(subscription.status, "resolveAccess")
  }
}

/**
 * The plan whose limits actually apply.
 *
 * A canceled or paused subscription keeps its plan on the row — that is the
 * history of what they were on — but the limits that apply are the free plan's,
 * because nothing else would make sense once the money stops. Writes are
 * blocked anyway; this is what keeps the *reported* numbers honest.
 */
export function effectivePlan(subscription: Subscription, now: Date = new Date()): PlanId {
  return resolveAccess(subscription, now).mode === "full"
    ? subscription.plan
    : DEFAULT_PLAN_ID
}

/** Grace period granted when a payment first fails. */
export const DEFAULT_GRACE_PERIOD_DAYS = 7

/** The moment dunning ends, given when the failure was observed. */
export function graceDeadline(failedAt: Date, days: number = DEFAULT_GRACE_PERIOD_DAYS): Date {
  return new Date(failedAt.getTime() + days * 24 * 60 * 60 * 1000)
}
