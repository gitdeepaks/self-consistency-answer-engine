import type { MemberRole, Tenant, User } from "@sce/shared"
import { prisma } from "./client.ts"
import type { Prisma } from "../generated/client.ts"

/**
 * Tenancy bootstrap for the pre-identity era.
 *
 * The schema requires every run to belong to a tenant, but Phase 3 is what
 * actually authenticates callers. Until then the API resolves a single
 * well-known tenant, so isolation is exercised end to end from day one and
 * Phase 3 only has to change *where the tenant id comes from* — not what every
 * query looks like. Rows written now already carry the right owner.
 */

/** Slug of the tenant used when no principal has been authenticated. */
export const DEFAULT_TENANT_SLUG = process.env.SCE_DEFAULT_TENANT_SLUG?.trim() || "default"

export function toTenant(row: {
  id: string
  slug: string
  name: string
  createdAt: Date
}): Tenant {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: row.createdAt.toISOString() }
}

export function toUser(row: {
  id: string
  email: string
  displayName: string | null
  createdAt: Date
}): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createTenant(input: { slug: string; name?: string }): Promise<Tenant> {
  const row = await prisma.tenant.create({
    data: { slug: input.slug, name: input.name ?? input.slug },
  })
  return toTenant(row)
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  const row = await prisma.tenant.findUnique({ where: { slug } })
  return row ? toTenant(row) : null
}

export async function ensureTenant(slug: string, name?: string): Promise<Tenant> {
  const row = await prisma.tenant.upsert({
    where: { slug },
    create: { slug, name: name ?? slug },
    update: {},
  })
  return toTenant(row)
}

let cached: Promise<Tenant> | null = null

/**
 * The tenant every unauthenticated request is attributed to.
 *
 * Memoised because it is on the hot path of every request; the underlying
 * upsert is idempotent, so a cold start on several replicas at once is safe.
 */
export function defaultTenant(): Promise<Tenant> {
  cached ??= ensureTenant(DEFAULT_TENANT_SLUG, "Default workspace").catch((error: unknown) => {
    cached = null
    throw error
  })
  return cached
}

/** Drop the memoised tenant. Tests use this; production never needs it. */
export function resetDefaultTenant(): void {
  cached = null
}

export async function ensureUser(input: {
  email: string
  displayName?: string
  externalId?: string
}): Promise<User> {
  const row = await prisma.user.upsert({
    where: { email: input.email },
    create: {
      email: input.email,
      displayName: input.displayName ?? null,
      externalId: input.externalId ?? null,
    },
    update: {},
  })
  return toUser(row)
}

export async function ensureMembership(input: {
  tenantId: string
  userId: string
  role?: MemberRole
}): Promise<void> {
  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
    create: { tenantId: input.tenantId, userId: input.userId, role: input.role ?? "member" },
    update: input.role ? { role: input.role } : {},
  })
}

/** Every tenant the user belongs to, with their role. */
export async function listMemberships(
  userId: string,
): Promise<{ tenant: Tenant; role: MemberRole }[]> {
  const rows = await prisma.membership.findMany({
    where: { userId },
    include: { tenant: true },
    orderBy: { createdAt: "asc" },
  })
  return rows.map((row) => ({ tenant: toTenant(row.tenant), role: row.role }))
}

/* ------------------------------------------------------------ clerk sync */

/**
 * Mirroring Clerk into Postgres.
 *
 * Clerk owns identity; this database owns ownership. Runs, usage, keys and
 * audit rows all join against local `User` and `Tenant` ids, so those rows have
 * to exist locally — a foreign key cannot point at another company's API.
 *
 * Every function below is an upsert keyed on the Clerk id, because webhook
 * delivery is at-least-once and out-of-order. Applying the same
 * `organization.updated` twice must be indistinguishable from applying it once,
 * and an `organizationMembership.created` that overtakes its `user.created`
 * must not fail — it creates the placeholder it needs and lets the later event
 * fill in the details.
 */

/** Reduce anything to the characters a slug is allowed to contain. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Clerk org slugs are optional and not unique here; make one that is. */
function tenantSlugFor(externalId: string, slug: string | null): string {
  const base = slugify(slug ?? "")
  if (base.length >= 2) return base

  // Clerk ids look like `org_2abcDEF…`. The tail is unique, but it is not slug
  // shaped on its own — it carries the underscore separator and mixed case, so
  // it goes through the same reduction rather than being trusted as-is.
  return `org-${slugify(externalId.replace(/^org_/, "")).slice(0, 24)}`
}

/**
 * A slug nobody else holds.
 *
 * Two Clerk organizations may legitimately be called "Acme". The first takes
 * `acme`; the next gets a suffix. Collisions are resolved here rather than by
 * letting the unique constraint throw inside a webhook Clerk would then retry
 * forever.
 */
async function availableSlug(preferred: string, externalId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = attempt === 0 ? preferred : `${preferred}-${attempt + 1}`
    const holder = await prisma.tenant.findUnique({
      where: { slug: candidate },
      select: { externalId: true },
    })
    if (holder === null || holder.externalId === externalId) return candidate
  }
  return `${preferred}-${externalId.slice(-6).toLowerCase()}`
}

export interface ClerkOrganization {
  externalId: string
  name: string
  slug: string | null
}

/** Create or update the tenant mirroring a Clerk organization. */
export async function syncClerkOrganization(input: ClerkOrganization): Promise<Tenant> {
  const slug = await availableSlug(tenantSlugFor(input.externalId, input.slug), input.externalId)

  const row = await prisma.tenant.upsert({
    where: { externalId: input.externalId },
    create: { externalId: input.externalId, slug, name: input.name },
    update: { slug, name: input.name },
  })
  return toTenant(row)
}

/**
 * Soft-delete the tenant behind a deleted Clerk organization.
 *
 * The rows are kept: usage records feed billing that outlives the org, and an
 * audit trail that disappears with its subject is not an audit trail. What
 * `deletedAt` costs is access — `resolveTenant` will not hand it to anyone.
 */
export async function deleteClerkOrganization(externalId: string): Promise<void> {
  await prisma.tenant.updateMany({
    where: { externalId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
}

export interface ClerkUser {
  externalId: string
  email: string
  displayName: string | null
}

/**
 * Create or update the user mirroring a Clerk user.
 *
 * Matched on `externalId` first and email second: a person who changes their
 * email address in Clerk is the same person, and a row that already exists
 * under that address — seeded, or created by an out-of-order membership event —
 * should be adopted rather than duplicated.
 */
export async function syncClerkUser(input: ClerkUser): Promise<User> {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ externalId: input.externalId }, { email: input.email }] },
    orderBy: { externalId: { sort: "asc", nulls: "last" } },
  })

  if (existing === null) {
    return toUser(
      await prisma.user.create({
        data: {
          externalId: input.externalId,
          email: input.email,
          displayName: input.displayName,
        },
      }),
    )
  }

  return toUser(
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        externalId: input.externalId,
        email: input.email,
        displayName: input.displayName,
      },
    }),
  )
}

/**
 * Forget a deleted Clerk user.
 *
 * The row is removed, not tombstoned: this is the delete half of GDPR Art. 17,
 * and the schema is built for it — `Run.createdByUserId` is `onDelete: SetNull`
 * and `ApiKey.createdByUserId` likewise, so the person's runs survive as tenant
 * property while the person does not. Their memberships cascade, which revokes
 * every key they minted at the same moment.
 */
export async function deleteClerkUser(externalId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { externalId } })
}

/**
 * Apply a Clerk membership.
 *
 * Placeholders exist because webhook ordering is not guaranteed: a membership
 * event can arrive before the `user.created` or `organization.created` it
 * depends on. Creating the minimum row now and letting the later event fill it
 * in is what keeps the sync eventually correct instead of permanently missing a
 * member whose events raced.
 */
export async function syncClerkMembership(input: {
  organizationExternalId: string
  organizationName: string
  organizationSlug: string | null
  userExternalId: string
  userEmail: string | null
  userDisplayName: string | null
  role: MemberRole
}): Promise<void> {
  const tenant = await syncClerkOrganization({
    externalId: input.organizationExternalId,
    name: input.organizationName,
    slug: input.organizationSlug,
  })

  const user = await syncClerkUser({
    externalId: input.userExternalId,
    // Clerk's membership payload carries the user's public data, which does not
    // always include an email. A synthetic address keeps the unique constraint
    // satisfiable until `user.created`/`user.updated` supplies the real one.
    email: input.userEmail ?? `${input.userExternalId}@users.noreply.clerk`,
    displayName: input.userDisplayName,
  })

  await prisma.membership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
    create: { tenantId: tenant.id, userId: user.id, role: input.role },
    update: { role: input.role },
  })
}

/** Remove a membership. Every key that member minted stops working with it. */
export async function removeClerkMembership(input: {
  organizationExternalId: string
  userExternalId: string
}): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { externalId: input.organizationExternalId },
    select: { id: true },
  })
  const user = await prisma.user.findUnique({
    where: { externalId: input.userExternalId },
    select: { id: true },
  })
  if (tenant === null || user === null) return

  await prisma.membership.deleteMany({ where: { tenantId: tenant.id, userId: user.id } })
  // A key outliving the membership that authorised it is the classic
  // offboarding hole. `verifyApiKey` already refuses a key whose creator has no
  // membership, so this is belt-and-braces — but it makes the revocation
  // visible in the key list rather than only in the auth decision.
  await prisma.apiKey.updateMany({
    where: { tenantId: tenant.id, createdByUserId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/* ------------------------------------------------------ principal lookup */

/** The local user behind a Clerk subject, or null if no webhook has arrived. */
export async function findUserByExternalId(externalId: string): Promise<User | null> {
  const row = await prisma.user.findUnique({ where: { externalId } })
  return row === null ? null : toUser(row)
}

export interface ResolvedMembership {
  tenant: Tenant
  role: MemberRole
}

/**
 * Which tenant a request acts inside, and with what role.
 *
 * A person can belong to several organizations, so the answer is a choice:
 * an explicit one when the caller names a tenant (the CLI's `--org`, the web
 * app's org switcher, a Clerk session that carries an `orgId`), and otherwise
 * their oldest membership — stable across requests, which an arbitrary pick
 * would not be.
 *
 * Naming a tenant the user does not belong to returns null rather than falling
 * back. Falling back would mean a request that asked to act as tenant A quietly
 * acting as tenant B, which is precisely the confusion this phase exists to
 * make impossible.
 */
export async function resolveMembership(
  userId: string,
  preferred?: {
    /** What the caller asked for: a tenant id or a slug. */
    identifier?: string | null
    /** The Clerk organization the session is already acting inside. */
    externalId?: string | null
  },
): Promise<ResolvedMembership | null> {
  const identifier = preferred?.identifier?.trim() ?? ""
  const externalId = preferred?.externalId?.trim() ?? ""

  /**
   * Strict precedence, built as an explicit list.
   *
   * Two things to be careful about, both of which have bitten this function:
   *
   *   - Precedence is not a union. If the caller named a tenant, only that
   *     tenant may match — OR-ing it with the session's organization would let
   *     a request that asked for A be served as B, which is the exact confusion
   *     this phase exists to remove.
   *   - `{ id: undefined }` is not "match nothing" in Prisma, it is *no
   *     condition at all* — and inside an `OR` that matches every row. So the
   *     branches are only added when they have a value, never left undefined.
   */
  const match: Prisma.TenantWhereInput[] =
    identifier !== ""
      ? [{ id: identifier }, { slug: identifier }]
      : externalId !== ""
        ? [{ externalId }]
        : []

  const rows = await prisma.membership.findMany({
    where: {
      userId,
      tenant: { deletedAt: null, ...(match.length > 0 ? { OR: match } : {}) },
    },
    include: { tenant: true },
    // Oldest membership when nothing was named: stable across requests, which
    // an arbitrary pick would not be.
    orderBy: { createdAt: "asc" },
    take: 1,
  })

  const row = rows[0]
  return row === undefined ? null : { tenant: toTenant(row.tenant), role: row.role }
}

/** The membership a user holds in one named tenant, or null. */
export async function getMembership(
  tenantId: string,
  userId: string,
): Promise<MemberRole | null> {
  const row = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { role: true },
  })
  return row?.role ?? null
}

/**
 * Does this identifier name that tenant?
 *
 * The tenant header accepts a slug (what a human types) or an id (what a
 * machine stores), so "did the caller ask for the tenant this credential is
 * bound to?" cannot be a string comparison. Answering it here keeps the two
 * accepted spellings in one place instead of at every call site.
 */
export async function tenantMatches(tenantId: string, identifier: string): Promise<boolean> {
  if (identifier === tenantId) return true

  const row = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { slug: true, externalId: true },
  })
  return row !== null && (row.slug === identifier || row.externalId === identifier)
}
