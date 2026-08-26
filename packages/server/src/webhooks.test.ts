import { createHmac } from "node:crypto"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

/**
 * Clerk → Postgres synchronisation.
 *
 * The signature is computed here from the Standard Webhooks definition rather
 * than with the library that verifies it, so this suite proves the endpoint is
 * wired to the real scheme instead of proving a library agrees with itself.
 *
 * Everything runs offline: no Clerk instance, no network, no keys. The payloads
 * are the shapes Clerk documents, and the assertions are about what ends up in
 * our tables.
 */

/**
 * The signing secret comes from `test-setup.ts`, not from here.
 *
 * `env.ts` parses `process.env` once at first import and `bun test` shares a
 * process across files, so a secret set in this file would arrive too late
 * whenever another suite imported `app.ts` first — the suite would pass alone
 * and fail in a full run, which is the worst way to learn about it.
 */
const SIGNING_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? ""
if (SIGNING_SECRET === "") {
  throw new Error("test-setup.ts must set CLERK_WEBHOOK_SIGNING_SECRET before this suite runs")
}

const { app } = await import("./app.ts")
const { prisma } = await import("@sce/db")

const ORG_ID = "org_webhooktest001"
const USER_ID = "user_webhooktest001"

/**
 * Sign a payload the way Svix does.
 *
 * base64-decode the secret after its `whsec_` prefix, HMAC-SHA256 over
 * `id.timestamp.body`, and present it as `v1,<base64>`.
 */
function sign(id: string, timestamp: number, body: string): string {
  const key = Buffer.from(SIGNING_SECRET.replace(/^whsec_/, ""), "base64")
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")
  return `v1,${signature}`
}

interface DeliveryOptions {
  id?: string
  /** Corrupt the signature deliberately. */
  tamper?: boolean
}

async function deliver(event: unknown, options: DeliveryOptions = {}): Promise<Response> {
  const body = JSON.stringify(event)
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = sign(id, timestamp, body)

  return app.request("/api/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": options.tamper === true ? "v1,not-the-right-signature" : signature,
    },
    body,
  })
}

const organizationCreated = {
  type: "organization.created",
  object: "event",
  data: { id: ORG_ID, name: "Webhook Test Org", slug: "webhook-test-org" },
}

const membershipCreated = {
  type: "organizationMembership.created",
  object: "event",
  data: {
    organization: { id: ORG_ID, name: "Webhook Test Org", slug: "webhook-test-org" },
    public_user_data: {
      user_id: USER_ID,
      identifier: "member@webhook-test.example",
      first_name: "Wendy",
      last_name: "Hook",
    },
    role: "org:admin",
  },
}

async function cleanup(): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
  if (tenant !== null) {
    await prisma.apiKey.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
  }
  await prisma.user.deleteMany({ where: { externalId: USER_ID } })
  await prisma.webhookDelivery.deleteMany({ where: { type: { startsWith: "organization" } } })
}

beforeAll(cleanup)
afterAll(cleanup)

describe("signature verification", () => {
  test("a tampered signature is rejected and nothing is applied", async () => {
    const response = await deliver(organizationCreated, { tamper: true })
    expect(response.status).toBe(400)

    // 400, not 5xx: the same bytes will fail the same way, so Svix must stop
    // retrying rather than loop forever.
    expect(await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })).toBeNull()
  })

  test("missing Svix headers are rejected", async () => {
    const response = await app.request("/api/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(organizationCreated),
    })
    expect(response.status).toBe(400)
  })

  test("the webhook route is not behind authentication", async () => {
    // It cannot be: the caller is Clerk, which holds no credential of ours.
    // A 401 here would mean identity sync silently stopped working.
    const response = await deliver(organizationCreated, { tamper: true })
    expect(response.status).not.toBe(401)
  })
})

describe("organization sync", () => {
  test("organization.created creates the tenant", async () => {
    const response = await deliver(organizationCreated)
    expect(response.status).toBe(200)

    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    expect(tenant?.name).toBe("Webhook Test Org")
    expect(tenant?.slug).toBe("webhook-test-org")
  })

  test("organization.updated renames it in place", async () => {
    await deliver({
      type: "organization.updated",
      object: "event",
      data: { id: ORG_ID, name: "Renamed Org", slug: "webhook-test-org" },
    })

    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    expect(tenant?.name).toBe("Renamed Org")
  })

  test("a replayed delivery is acknowledged without being applied twice", async () => {
    const id = "msg_replayed_once"
    const event = {
      type: "organization.updated",
      object: "event",
      data: { id: ORG_ID, name: "First Application", slug: "webhook-test-org" },
    }

    expect((await deliver(event, { id })).status).toBe(200)

    // Svix retries on any non-2xx, and a retry that lands after a partial
    // success must be a no-op. A different payload under the same id proves
    // the second delivery was not applied rather than merely idempotent.
    const replay = await deliver(
      { ...event, data: { ...event.data, name: "Should Not Apply" } },
      { id },
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ deduplicated: true })

    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    expect(tenant?.name).toBe("First Application")
  })
})

describe("membership sync", () => {
  test("organizationMembership.created creates the user and the membership", async () => {
    const response = await deliver(membershipCreated)
    expect(response.status).toBe(200)

    const user = await prisma.user.findUnique({ where: { externalId: USER_ID } })
    expect(user?.email).toBe("member@webhook-test.example")
    expect(user?.displayName).toBe("Wendy Hook")

    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    const membership = await prisma.membership.findFirst({
      where: { tenantId: tenant?.id, userId: user?.id },
    })
    // `org:admin` maps onto our own closed enum rather than being stored raw.
    expect(membership?.role).toBe("admin")
  })

  test("a membership event that overtakes its organization still lands", async () => {
    // Webhook ordering is not guaranteed. A membership for an organization no
    // event has introduced yet must create what it needs, not fail and wait.
    const orphanOrg = "org_webhooktest_orphan"
    const orphanUser = "user_webhooktest_orphan"

    const response = await deliver({
      type: "organizationMembership.created",
      object: "event",
      data: {
        organization: { id: orphanOrg, name: "Orphan Org", slug: "orphan-org" },
        public_user_data: {
          user_id: orphanUser,
          identifier: "orphan@webhook-test.example",
          first_name: null,
          last_name: null,
        },
        role: "org:member",
      },
    })
    expect(response.status).toBe(200)

    const tenant = await prisma.tenant.findUnique({ where: { externalId: orphanOrg } })
    expect(tenant).not.toBeNull()

    await prisma.tenant.deleteMany({ where: { externalId: orphanOrg } })
    await prisma.user.deleteMany({ where: { externalId: orphanUser } })
  })

  test("a role change is applied to the existing membership", async () => {
    await deliver({ ...membershipCreated, type: "organizationMembership.updated", data: { ...membershipCreated.data, role: "org:member" } })

    const user = await prisma.user.findUnique({ where: { externalId: USER_ID } })
    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    const membership = await prisma.membership.findFirst({
      where: { tenantId: tenant?.id, userId: user?.id },
    })
    expect(membership?.role).toBe("member")
  })

  test("removing a member also revokes every key they minted", async () => {
    const user = await prisma.user.findUnique({ where: { externalId: USER_ID } })
    const tenant = await prisma.tenant.findUnique({ where: { externalId: ORG_ID } })
    expect(user).not.toBeNull()
    expect(tenant).not.toBeNull()

    const { createApiKey } = await import("@sce/db")
    const key = await createApiKey({
      tenantId: tenant?.id ?? "",
      createdByUserId: user?.id ?? null,
      name: "leaver's key",
      scopes: ["runs:read"],
      expiresAt: null,
    })

    await deliver({ ...membershipCreated, type: "organizationMembership.deleted" })

    // The classic offboarding hole: the person is gone, their credential is not.
    const stored = await prisma.apiKey.findUnique({ where: { id: key.key.id } })
    expect(stored?.revokedAt).not.toBeNull()

    const membership = await prisma.membership.findFirst({
      where: { tenantId: tenant?.id, userId: user?.id },
    })
    expect(membership).toBeNull()
  })
})

describe("events this build does not model", () => {
  test("an unmodelled event is acknowledged, not retried", async () => {
    // Clerk sends whatever the endpoint subscribes to. A 500 on a session or
    // billing event would make Clerk retry something we will never act on.
    const response = await deliver({
      type: "session.created",
      object: "event",
      data: { id: "sess_1", user_id: USER_ID },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ignored: "session.created" })
  })
})
