import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { prisma } from "./client.ts"
import {
  deleteClerkOrganization,
  deleteClerkUser,
  ensureMembership,
  ensureTenant,
  ensureUser,
  getMembership,
  removeClerkMembership,
  resolveMembership,
  syncClerkMembership,
  syncClerkOrganization,
  syncClerkUser,
  tenantMatches,
} from "./tenancy.ts"

/**
 * Tenant resolution and Clerk mirroring.
 *
 * `resolveMembership` decides which tenant a request acts inside, which makes
 * it the single most security-relevant function in the tenancy layer — and the
 * one the HTTP suite cannot cover, because exercising the session path needs a
 * live Clerk instance. So it is pinned here instead.
 */

const PREFIX = "test-tenancy"
let alice = ""
let tenantA = ""
let tenantB = ""

beforeAll(async () => {
  await cleanup()

  const a = await ensureTenant(`${PREFIX}-a`, "Tenant A")
  const b = await ensureTenant(`${PREFIX}-b`, "Tenant B")
  tenantA = a.id
  tenantB = b.id

  const user = await ensureUser({ email: `alice@${PREFIX}.test`, displayName: "Alice" })
  alice = user.id

  // A first, then B — so "oldest membership" has an unambiguous answer.
  await ensureMembership({ tenantId: tenantA, userId: alice, role: "admin" })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await ensureMembership({ tenantId: tenantB, userId: alice, role: "viewer" })
})

afterAll(cleanup)

async function cleanup(): Promise<void> {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { contains: `@${PREFIX}.test` } } })
  await prisma.tenant.deleteMany({ where: { externalId: { startsWith: "org_tenancytest" } } })
  await prisma.user.deleteMany({ where: { externalId: { startsWith: "user_tenancytest" } } })
}

describe("resolveMembership", () => {
  test("with nothing named, picks the oldest membership", async () => {
    // Stable across requests. An arbitrary pick would mean the same credential
    // acting as a different tenant on consecutive calls.
    const resolved = await resolveMembership(alice)
    expect(resolved?.tenant.id).toBe(tenantA)
    expect(resolved?.role).toBe("admin")
  })

  test("an explicit slug selects that tenant", async () => {
    const resolved = await resolveMembership(alice, { identifier: `${PREFIX}-b` })
    expect(resolved?.tenant.id).toBe(tenantB)
    expect(resolved?.role).toBe("viewer")
  })

  test("an explicit id selects that tenant", async () => {
    const resolved = await resolveMembership(alice, { identifier: tenantB })
    expect(resolved?.tenant.id).toBe(tenantB)
  })

  /**
   * The regression this file was written for.
   *
   * An earlier implementation built its filter as
   * `OR: [{ id: wanted }, { externalId: undefined }, { slug: wanted }]`. In
   * Prisma, `{ externalId: undefined }` is not "match nothing" — it is *no
   * condition*, which inside an `OR` matches every row. So naming a tenant you
   * did not belong to quietly fell back to your default one, and a request that
   * asked to act as A was served as B.
   */
  test("naming a tenant you do not belong to returns null, never a fallback", async () => {
    const stranger = await ensureTenant(`${PREFIX}-stranger`, "Somebody else")

    expect(await resolveMembership(alice, { identifier: stranger.slug })).toBeNull()
    expect(await resolveMembership(alice, { identifier: stranger.id })).toBeNull()
    expect(await resolveMembership(alice, { identifier: "no-such-tenant" })).toBeNull()
  })

  test("an explicit choice wins over the session's organization", async () => {
    await prisma.tenant.update({
      where: { id: tenantA },
      data: { externalId: "org_tenancytest_a" },
    })

    // Precedence, not a union: asking for B while the session sits in A must
    // yield B or nothing — never A.
    const resolved = await resolveMembership(alice, {
      identifier: `${PREFIX}-b`,
      externalId: "org_tenancytest_a",
    })
    expect(resolved?.tenant.id).toBe(tenantB)
  })

  test("the session's organization is used when nothing is named", async () => {
    const resolved = await resolveMembership(alice, { externalId: "org_tenancytest_a" })
    expect(resolved?.tenant.id).toBe(tenantA)
  })

  test("a blank identifier is treated as absent, not as a filter", async () => {
    expect((await resolveMembership(alice, { identifier: "   " }))?.tenant.id).toBe(tenantA)
    expect((await resolveMembership(alice, { identifier: null }))?.tenant.id).toBe(tenantA)
  })

  test("a soft-deleted tenant is not resolvable", async () => {
    await prisma.tenant.update({ where: { id: tenantB }, data: { deletedAt: new Date() } })
    try {
      expect(await resolveMembership(alice, { identifier: `${PREFIX}-b` })).toBeNull()
      // …and it does not silently become the other one.
      expect((await resolveMembership(alice))?.tenant.id).toBe(tenantA)
    } finally {
      await prisma.tenant.update({ where: { id: tenantB }, data: { deletedAt: null } })
    }
  })

  test("a user with no memberships resolves to nothing", async () => {
    const loner = await ensureUser({ email: `loner@${PREFIX}.test` })
    expect(await resolveMembership(loner.id)).toBeNull()
  })
})

describe("tenantMatches", () => {
  test("accepts the id, the slug and the Clerk org id", async () => {
    expect(await tenantMatches(tenantA, tenantA)).toBe(true)
    expect(await tenantMatches(tenantA, `${PREFIX}-a`)).toBe(true)
    expect(await tenantMatches(tenantA, "org_tenancytest_a")).toBe(true)
  })

  test("rejects another tenant's identifiers", async () => {
    expect(await tenantMatches(tenantA, tenantB)).toBe(false)
    expect(await tenantMatches(tenantA, `${PREFIX}-b`)).toBe(false)
    expect(await tenantMatches(tenantA, "")).toBe(false)
  })
})

describe("clerk mirroring", () => {
  test("syncing the same organization twice changes nothing the second time", async () => {
    const first = await syncClerkOrganization({
      externalId: "org_tenancytest_idem",
      name: "Idempotent",
      slug: "tenancytest-idem",
    })
    const second = await syncClerkOrganization({
      externalId: "org_tenancytest_idem",
      name: "Idempotent",
      slug: "tenancytest-idem",
    })

    // At-least-once delivery means this happens routinely.
    expect(second.id).toBe(first.id)
    expect(await prisma.tenant.count({ where: { externalId: "org_tenancytest_idem" } })).toBe(1)
  })

  test("two organizations wanting the same slug both get one", async () => {
    const first = await syncClerkOrganization({
      externalId: "org_tenancytest_acme1",
      name: "Acme",
      slug: "tenancytest-acme",
    })
    const second = await syncClerkOrganization({
      externalId: "org_tenancytest_acme2",
      name: "Acme",
      slug: "tenancytest-acme",
    })

    // Resolved here rather than letting the unique constraint throw inside a
    // webhook Clerk would then retry for ever.
    expect(second.id).not.toBe(first.id)
    expect(second.slug).not.toBe(first.slug)
  })

  test("an organization with no slug still gets a usable one", async () => {
    const tenant = await syncClerkOrganization({
      externalId: "org_tenancytest_noslug",
      name: "No Slug",
      slug: null,
    })
    expect(tenant.slug).toMatch(/^[a-z0-9-]+$/)
    expect(tenant.slug.length).toBeGreaterThan(1)
  })

  test("a user is matched on email as well as Clerk id, never duplicated", async () => {
    const email = `adopted@${PREFIX}.test`
    // Seeded locally first — no Clerk id yet.
    const seeded = await ensureUser({ email, displayName: "Seeded" })

    const synced = await syncClerkUser({
      externalId: "user_tenancytest_adopt",
      email,
      displayName: "Adopted",
    })

    // Adopted, not duplicated: a second row would split ownership of their runs.
    expect(synced.id).toBe(seeded.id)
    expect(await prisma.user.count({ where: { email } })).toBe(1)
  })

  test("a membership event creates the organization and user it needs", async () => {
    // Webhook ordering is not guaranteed; this must not fail and wait.
    await syncClerkMembership({
      organizationExternalId: "org_tenancytest_race",
      organizationName: "Race Org",
      organizationSlug: "tenancytest-race",
      userExternalId: "user_tenancytest_race",
      userEmail: `race@${PREFIX}.test`,
      userDisplayName: "Racer",
      role: "admin",
    })

    const tenant = await prisma.tenant.findUnique({
      where: { externalId: "org_tenancytest_race" },
    })
    const user = await prisma.user.findUnique({ where: { externalId: "user_tenancytest_race" } })
    expect(tenant).not.toBeNull()
    expect(await getMembership(tenant?.id ?? "", user?.id ?? "")).toBe("admin")
  })

  test("a membership with no email gets a placeholder rather than failing", async () => {
    await syncClerkMembership({
      organizationExternalId: "org_tenancytest_race",
      organizationName: "Race Org",
      organizationSlug: "tenancytest-race",
      userExternalId: "user_tenancytest_noemail",
      userEmail: null,
      userDisplayName: null,
      role: "member",
    })

    const user = await prisma.user.findUnique({ where: { externalId: "user_tenancytest_noemail" } })
    // Phone-only sign-ups have no address; the unique constraint still has to
    // be satisfiable until `user.updated` supplies a real one.
    expect(user?.email).toContain("user_tenancytest_noemail")
  })

  test("removing a membership revokes the keys that member minted", async () => {
    const tenant = await prisma.tenant.findUnique({
      where: { externalId: "org_tenancytest_race" },
    })
    const user = await prisma.user.findUnique({ where: { externalId: "user_tenancytest_race" } })

    const { createApiKey } = await import("./auth.ts")
    const key = await createApiKey({
      tenantId: tenant?.id ?? "",
      createdByUserId: user?.id ?? null,
      name: "leaver",
      scopes: ["runs:read"],
      expiresAt: null,
    })

    await removeClerkMembership({
      organizationExternalId: "org_tenancytest_race",
      userExternalId: "user_tenancytest_race",
    })

    expect(await getMembership(tenant?.id ?? "", user?.id ?? "")).toBeNull()
    expect((await prisma.apiKey.findUnique({ where: { id: key.key.id } }))?.revokedAt).not.toBeNull()
  })

  test("deleting an organization soft-deletes the tenant, keeping its history", async () => {
    await deleteClerkOrganization("org_tenancytest_idem")

    const tenant = await prisma.tenant.findUnique({ where: { externalId: "org_tenancytest_idem" } })
    // Usage records feed billing that outlives the organization, and an audit
    // trail that vanishes with its subject is not an audit trail.
    expect(tenant).not.toBeNull()
    expect(tenant?.deletedAt).not.toBeNull()
  })

  test("deleting a user removes the row — that is the GDPR delete", async () => {
    await deleteClerkUser("user_tenancytest_noemail")
    expect(
      await prisma.user.findUnique({ where: { externalId: "user_tenancytest_noemail" } }),
    ).toBeNull()
  })
})
