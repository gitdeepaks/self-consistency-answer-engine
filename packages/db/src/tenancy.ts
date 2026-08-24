import type { MemberRole, Tenant, User } from "@sce/shared"
import { prisma } from "./client.ts"

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
