import type {
  BillingPaymentAttemptWebhookEvent,
  BillingSubscriptionWebhookEvent,
} from "@clerk/backend/webhooks"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  ensureMembership,
  ensureTenant,
  ensureUser,
  getSubscription,
  prisma,
  syncClerkOrganization,
  syncClerkUser,
  upsertSubscription,
} from "@sce/db"
import { applyBillingEvent } from "./subscriptions.ts"

/**
 * Clerk Billing events, applied.
 *
 * The events are built by typed factories rather than cast from JSON. That is
 * not ceremony: a cast would let this suite keep passing after Clerk changed a
 * payload shape, which is precisely the failure the suite exists to catch. If
 * the vendor's types move, this file stops compiling — which is the earliest
 * and cheapest place to find out.
 *
 * The behaviours pinned here are the ones that cost money when they are wrong:
 * that dunning starts once and is not extended by every retry, that an
 * unmappable plan does not silently downgrade anybody, and that an event we
 * cannot attribute to exactly one workspace is dropped rather than guessed at.
 */

const PREFIX = "test-subs"
const ORG_ID = "org_testsubs_acme"
const SUBSCRIPTION_ID = "sub_testsubs_1"
const CUSTOMER_ID = "payer_testsubs_1"
const GRACE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

const NOW = new Date("2026-08-15T12:00:00.000Z")
const PERIOD_START = Math.floor(Date.parse("2026-08-01T00:00:00.000Z") / 1000)
const PERIOD_END = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1000)
const FAILED_AT = Math.floor(Date.parse("2026-08-14T09:00:00.000Z") / 1000)

let tenantId = ""

/* ------------------------------------------------------------- factories */

function money(amount: number) {
  return {
    amount,
    amount_formatted: (amount / 100).toFixed(2),
    currency: "USD",
    currency_symbol: "$",
  }
}

function payer(overrides: { organization_id?: string; user_id?: string }) {
  return {
    object: "commerce_payer" as const,
    id: CUSTOMER_ID,
    instance_id: "ins_testsubs",
    email: `billing@${PREFIX}.test`,
    image_url: "",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

function plan(slug: string) {
  return {
    id: `plan_${slug}`,
    instance_id: "ins_testsubs",
    product_id: "prod_testsubs",
    name: slug,
    slug,
    is_default: false,
    is_recurring: true,
    amount: 2_900,
    period: "month" as const,
    interval: 1,
    has_base_fee: true,
    currency: "USD",
    annual_monthly_amount: 2_900,
    publicly_visible: true,
  }
}

function item(slug: string) {
  return {
    object: "commerce_subscription_item" as const,
    id: "si_testsubs_1",
    status: "active" as const,
    credit: {
      amount: money(0),
      cycle_days_remaining: 16,
      cycle_days_total: 31,
      cycle_remaining_percent: 51,
    },
    proration_date: "2026-08-15",
    plan_period: "month" as const,
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    lifetime_paid: 2_900,
    next_payment_amount: 2_900,
    next_payment_date: PERIOD_END,
    amount: money(2_900),
    plan: plan(slug),
    plan_id: `plan_${slug}`,
  }
}

function subscriptionEvent(options: {
  type: BillingSubscriptionWebhookEvent["type"]
  status: BillingSubscriptionWebhookEvent["data"]["status"]
  planSlug?: string
  pastDueAt?: number
  canceledAt?: number
  payerOverrides?: { organization_id?: string; user_id?: string }
  /** Distinct ids for the attribution cases, which must not reuse Acme's. */
  subscriptionId?: string
  customerId?: string
}): BillingSubscriptionWebhookEvent {
  const subscriptionId = options.subscriptionId ?? SUBSCRIPTION_ID
  const customerId = options.customerId ?? CUSTOMER_ID
  return {
    type: options.type,
    object: "event",
    event_attributes: {
      http_request: { client_ip: "203.0.113.1", user_agent: "clerk" },
    },
    data: {
      object: "commerce_subscription",
      id: subscriptionId,
      status: options.status,
      created_at: PERIOD_START,
      updated_at: PERIOD_START,
      latest_payment_id: "pay_testsubs_1",
      payer_id: customerId,
      payer: { ...payer(options.payerOverrides ?? { organization_id: ORG_ID }), id: customerId },
      payment_source_id: "src_testsubs_1",
      items: [item(options.planSlug ?? "pro")],
      ...(options.pastDueAt === undefined ? {} : { past_due_at: options.pastDueAt }),
      ...(options.canceledAt === undefined ? {} : { canceled_at: options.canceledAt }),
    },
  }
}

function paymentEvent(options: {
  status: BillingPaymentAttemptWebhookEvent["data"]["status"]
  failedAt?: number
}): BillingPaymentAttemptWebhookEvent {
  return {
    type: "paymentAttempt.updated",
    object: "event",
    event_attributes: {
      http_request: { client_ip: "203.0.113.1", user_agent: "clerk" },
    },
    data: {
      object: "commerce_payment_attempt",
      id: "pa_testsubs_1",
      instance_id: "ins_testsubs",
      payment_id: "pay_testsubs_1",
      statement_id: "st_testsubs_1",
      gateway_external_id: "pi_testsubs_1",
      status: options.status,
      created_at: FAILED_AT,
      updated_at: FAILED_AT,
      ...(options.failedAt === undefined ? {} : { failed_at: options.failedAt }),
      billing_date: FAILED_AT,
      charge_type: "recurring",
      payee: {
        id: "payee_testsubs",
        gateway_type: "stripe",
        gateway_external_id: "acct_testsubs",
        gateway_status: "active",
      },
      payer: payer({ organization_id: ORG_ID }),
      totals: {
        subtotal: money(2_900),
        tax_total: money(0),
        grand_total: money(2_900),
      },
      payment_source: {
        id: "src_testsubs_1",
        gateway: "stripe",
        gateway_external_id: "pm_testsubs_1",
        payment_method: "card",
        status: "active",
      },
      subscription_items: [item("pro")],
    },
  }
}

/* ----------------------------------------------------------------- suite */

beforeAll(async () => {
  await cleanup()
  const tenant = await syncClerkOrganization({
    externalId: ORG_ID,
    name: "Acme",
    slug: `${PREFIX}-acme`,
  })
  tenantId = tenant.id
})

afterAll(cleanup)

async function cleanup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { externalId: { startsWith: "org_testsubs" } } })
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { externalId: { startsWith: "user_testsubs" } } })
  await prisma.user.deleteMany({ where: { email: { contains: `@${PREFIX}.test` } } })
}

describe("subscription events", () => {
  test("a new subscription records the plan, the period and the provider ids", async () => {
    const applied = await applyBillingEvent(
      subscriptionEvent({ type: "subscription.created", status: "active", planSlug: "pro" }),
      NOW,
    )
    expect(applied).not.toBeNull()

    const subscription = await getSubscription(tenantId)
    expect(subscription.plan).toBe("pro")
    expect(subscription.status).toBe("ACTIVE")
    expect(subscription.externalSubscriptionId).toBe(SUBSCRIPTION_ID)
    expect(subscription.externalCustomerId).toBe(CUSTOMER_ID)
    expect(subscription.currentPeriodEnd).toBe("2026-09-01T00:00:00.000Z")
  })

  test("an unrecognised plan slug leaves the recorded plan alone", async () => {
    // Clerk's plan slugs are typed into its dashboard. One that does not match
    // ours must not silently downgrade a paying customer to free.
    await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.updated",
        status: "active",
        planSlug: "platinum-deluxe",
      }),
      NOW,
    )
    expect((await getSubscription(tenantId)).plan).toBe("pro")
  })

  test("going past due starts dunning, dated from the failure", async () => {
    await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.pastDue",
        status: "past_due",
        pastDueAt: FAILED_AT,
      }),
      NOW,
    )

    const subscription = await getSubscription(tenantId)
    expect(subscription.status).toBe("PAST_DUE")
    expect(subscription.graceEndsAt).toBe(
      new Date(FAILED_AT * 1000 + GRACE_DAYS * DAY_MS).toISOString(),
    )
  })

  test("a repeat of the same event does not extend the grace period", async () => {
    // Svix retries. A grace window that moved forward on every delivery would
    // keep an unpaid workspace working for as long as the retries continued.
    const before = (await getSubscription(tenantId)).graceEndsAt

    await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.pastDue",
        status: "past_due",
        pastDueAt: Math.floor(NOW.getTime() / 1000),
      }),
      new Date(NOW.getTime() + DAY_MS),
    )

    expect((await getSubscription(tenantId)).graceEndsAt).toBe(before)
  })

  test("cancelling clears the grace window and stops writes", async () => {
    await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.updated",
        status: "canceled",
        canceledAt: Math.floor(NOW.getTime() / 1000),
      }),
      NOW,
    )

    const subscription = await getSubscription(tenantId)
    expect(subscription.status).toBe("CANCELED")
    expect(subscription.graceEndsAt).toBeNull()
    expect(subscription.cancelAtPeriodEnd).toBe(true)
  })

  test("a status this build does not model changes nothing", async () => {
    // `incomplete` is a checkout in progress. Turning somebody halfway through
    // paying us into a restricted workspace is exactly the wrong response.
    await upsertSubscription({ tenantId, plan: "pro", status: "ACTIVE" })
    await applyBillingEvent(
      subscriptionEvent({ type: "subscription.updated", status: "incomplete" }),
      NOW,
    )
    expect((await getSubscription(tenantId)).status).toBe("ACTIVE")
  })
})

describe("payment attempts", () => {
  test("a failure starts dunning", async () => {
    await upsertSubscription({ tenantId, plan: "pro", status: "ACTIVE", graceEndsAt: null })
    await applyBillingEvent(paymentEvent({ status: "failed", failedAt: FAILED_AT }), NOW)

    const subscription = await getSubscription(tenantId)
    expect(subscription.status).toBe("PAST_DUE")
    expect(subscription.graceEndsAt).toBe(
      new Date(FAILED_AT * 1000 + GRACE_DAYS * DAY_MS).toISOString(),
    )
    // The plan is untouched: a payment event says nothing about what they buy.
    expect(subscription.plan).toBe("pro")
  })

  test("a later success ends dunning", async () => {
    await applyBillingEvent(paymentEvent({ status: "paid" }), NOW)

    const subscription = await getSubscription(tenantId)
    expect(subscription.status).toBe("ACTIVE")
    expect(subscription.graceEndsAt).toBeNull()
  })

  test("a pending attempt is not acted on", async () => {
    // `pending` is the state a card is in *while* it is being charged.
    const applied = await applyBillingEvent(paymentEvent({ status: "pending" }), NOW)
    expect(applied).toBeNull()
    expect((await getSubscription(tenantId)).status).toBe("ACTIVE")
  })
})

describe("attribution", () => {
  test("an event for an unknown organization is acknowledged, not applied", async () => {
    const applied = await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.created",
        status: "active",
        payerOverrides: { organization_id: "org_testsubs_nobody" },
        subscriptionId: "sub_testsubs_nobody",
        customerId: "payer_testsubs_nobody",
      }),
      NOW,
    )
    // Null means "handled, nothing to do" — the webhook answers 2xx and Clerk
    // stops retrying an event that will never resolve.
    expect(applied).toBeNull()
  })

  test("a user payer resolves when they belong to exactly one workspace", async () => {
    const user = await syncClerkUser({
      externalId: "user_testsubs_solo",
      email: `solo@${PREFIX}.test`,
      displayName: "Solo",
    })
    const solo = await ensureTenant(`${PREFIX}-solo`, "Solo workspace")
    await ensureMembership({ tenantId: solo.id, userId: user.id, role: "owner" })

    await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.created",
        status: "active",
        payerOverrides: { user_id: "user_testsubs_solo" },
        subscriptionId: "sub_testsubs_solo",
        customerId: "payer_testsubs_solo",
      }),
      NOW,
    )

    expect((await getSubscription(solo.id)).plan).toBe("pro")
  })

  test("a user in several workspaces is ambiguous, so nothing is written", async () => {
    const user = await ensureUser({
      email: `many@${PREFIX}.test`,
      displayName: "Many",
      externalId: "user_testsubs_many",
    })
    const first = await ensureTenant(`${PREFIX}-many-1`, "Many 1")
    const second = await ensureTenant(`${PREFIX}-many-2`, "Many 2")
    await ensureMembership({ tenantId: first.id, userId: user.id, role: "owner" })
    await ensureMembership({ tenantId: second.id, userId: user.id, role: "owner" })

    const applied = await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.created",
        status: "active",
        payerOverrides: { user_id: "user_testsubs_many" },
        subscriptionId: "sub_testsubs_many",
        customerId: "payer_testsubs_many",
      }),
      NOW,
    )

    // Attaching a subscription to the wrong workspace is worse than missing it.
    expect(applied).toBeNull()
    expect((await getSubscription(first.id)).plan).toBe("free")
    expect((await getSubscription(second.id)).plan).toBe("free")
  })

  test("ids already claimed by another workspace do not break the event", async () => {
    // A subscription id is unique, because it is how a later event finds its
    // tenant. An event that would move one between workspaces still applies to
    // the workspace its payer names — it just does not steal the ids, because a
    // constraint violation here becomes an infinite Svix retry.
    const other = await ensureTenant(`${PREFIX}-claimed`, "Claimed")
    const user = await syncClerkUser({
      externalId: "user_testsubs_claimed",
      email: `claimed@${PREFIX}.test`,
      displayName: "Claimed",
    })
    await ensureMembership({ tenantId: other.id, userId: user.id, role: "owner" })

    const applied = await applyBillingEvent(
      subscriptionEvent({
        type: "subscription.updated",
        status: "active",
        planSlug: "team",
        payerOverrides: { user_id: "user_testsubs_claimed" },
      }),
      NOW,
    )

    expect(applied).not.toBeNull()
    const subscription = await getSubscription(other.id)
    expect(subscription.plan).toBe("team")
    expect(subscription.externalSubscriptionId).toBeNull()
    // Acme keeps the ids it registered first.
    expect((await getSubscription(tenantId)).externalSubscriptionId).toBe(SUBSCRIPTION_ID)
  })
})
