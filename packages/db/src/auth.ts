import {
  apiKeySecretMatches,
  mintApiKey,
  parseApiKey,
  storedScopesSchema,
  toJson,
  type ActorType,
  type ApiKeyCreated,
  type ApiKeySummary,
  type AuditAction,
  type AuditEvent,
  type JsonValue,
  type MemberRole,
  type Scope,
} from "@sce/shared"
import { prisma } from "./client.ts"

/**
 * Credentials and the audit trail.
 *
 * Two things live here rather than in `repository.ts`, and both for the same
 * reason: they are the layer *underneath* tenant scoping rather than a
 * consumer of it. Resolving an API key is what decides which tenant a request
 * belongs to, so it cannot itself be filtered by one, and an authentication
 * failure has to be auditable before any tenant has been established.
 *
 * Everything else in this file is scoped exactly as strictly as the repository
 * is, and `repository.scoping.test.ts` checks this file too.
 */

/* ---------------------------------------------------------------- mappers */

type ApiKeyRow = Awaited<ReturnType<typeof prisma.apiKey.findFirstOrThrow>>
type AuditRow = Awaited<ReturnType<typeof prisma.auditEvent.findFirstOrThrow>>

function toApiKeySummary(row: ApiKeyRow): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    // The column is `String[]`, which is unvalidated input like any other.
    // Anything unreadable is dropped, so a corrupted row yields fewer
    // permissions rather than more.
    scopes: storedScopesSchema.parse(row.scopes),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actorType,
    actorId: row.actorId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  }
}

/* --------------------------------------------------------------- api keys */

export interface MintApiKeyInput {
  tenantId: string
  createdByUserId: string | null
  name: string
  scopes: readonly Scope[]
  /** Null means the key never expires. */
  expiresAt: Date | null
}

/**
 * Mint a key and store only what cannot be replayed.
 *
 * The returned `token` is the one and only time the secret exists outside the
 * caller's memory — there is deliberately no function anywhere that can recover
 * it from a row.
 */
export async function createApiKey(input: MintApiKeyInput): Promise<ApiKeyCreated> {
  const minted = mintApiKey(process.env.NODE_ENV === "production" ? "live" : "test")

  const row = await prisma.apiKey.create({
    data: {
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId,
      name: input.name,
      prefix: minted.prefix,
      hash: minted.hash,
      scopes: [...input.scopes],
      expiresAt: input.expiresAt,
    },
  })

  return { key: toApiKeySummary(row), token: minted.token }
}

/** Every key a tenant holds, newest first. Revoked keys stay listed. */
export async function listApiKeys(tenantId: string): Promise<ApiKeySummary[]> {
  const rows = await prisma.apiKey.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  })
  return rows.map(toApiKeySummary)
}

/**
 * Revoke a key, with immediate effect.
 *
 * "Immediate" is a property of the read path, not of this write: every request
 * resolves its key from the database, so there is no cache to invalidate and no
 * window in which a revoked key still works. That is worth one indexed lookup
 * per request.
 *
 * Revoking twice is not an error — a second call is the same intent expressed
 * again, and reporting a failure would push callers toward read-then-write.
 */
export async function revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
  const { count } = await prisma.apiKey.updateMany({
    where: { id: keyId, tenantId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return count > 0
}

/** The principal an accepted key resolves to. */
export interface ApiKeyPrincipal {
  keyId: string
  tenantId: string
  /** The person who minted the key, or null for one the bootstrap script made. */
  userId: string | null
  role: MemberRole
  scopes: readonly Scope[]
}

/** Why a presented key was refused. Reported to the audit log, never to the caller. */
export type ApiKeyRejection = "malformed" | "unknown" | "revoked" | "expired" | "no-membership"

export type ApiKeyVerification =
  | { ok: true; principal: ApiKeyPrincipal }
  | { ok: false; reason: ApiKeyRejection }

/**
 * Resolve a presented token to a principal.
 *
 * The lookup is by prefix — indexed and unique — followed by a constant-time
 * comparison of the secret's hash. A wrong secret costs exactly the same as a
 * right one, and an unknown prefix costs one index probe.
 *
 * The role is read from the creator's *current* membership rather than stored
 * on the key. That is the whole point: demoting someone demotes their keys, and
 * removing them from the tenant kills their keys, without anyone having to
 * remember to go and revoke them.
 */
export async function verifyApiKey(token: string): Promise<ApiKeyVerification> {
  const parsed = parseApiKey(token)
  if (parsed === null) return { ok: false, reason: "malformed" }

  const row = await prisma.apiKey.findUnique({ where: { prefix: parsed.prefix } })
  // Compare regardless of whether the row exists, so a valid prefix and an
  // unknown one take the same time. `mintApiKey`'s hash length is fixed, so the
  // dummy digest below is the same size as a real one.
  const hash = row?.hash ?? "0".repeat(64)
  const matches = apiKeySecretMatches(parsed.secret, hash)

  if (row === null || !matches) return { ok: false, reason: "unknown" }
  if (row.revokedAt !== null) return { ok: false, reason: "revoked" }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" }
  }

  const scopes = storedScopesSchema.parse(row.scopes)

  // A key with no creator was minted out of band by an operator with database
  // access — the bootstrap path — and acts with full authority inside its
  // tenant. A key whose creator has since left the tenant has no authority at
  // all, which is what makes offboarding a single delete.
  if (row.createdByUserId === null) {
    return {
      ok: true,
      principal: { keyId: row.id, tenantId: row.tenantId, userId: null, role: "owner", scopes },
    }
  }

  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId: row.tenantId, userId: row.createdByUserId } },
  })
  if (membership === null) return { ok: false, reason: "no-membership" }

  return {
    ok: true,
    principal: {
      keyId: row.id,
      tenantId: row.tenantId,
      userId: row.createdByUserId,
      role: membership.role,
      scopes,
    },
  }
}

/** How stale `lastUsedAt` is allowed to get before another write is worth it. */
const LAST_USED_RESOLUTION_MS = 60_000

/**
 * Record that a key was used, cheaply.
 *
 * Writing on every request would put a row update in front of every API call to
 * maintain a field nobody reads to the second. Throttling to a minute keeps the
 * signal that matters — "this key is live" / "this key has been dormant since
 * March" — for a fraction of the writes.
 */
export async function touchApiKey(tenantId: string, keyId: string): Promise<void> {
  const cutoff = new Date(Date.now() - LAST_USED_RESOLUTION_MS)
  await prisma.apiKey.updateMany({
    where: {
      id: keyId,
      tenantId,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }],
    },
    data: { lastUsedAt: new Date() },
  })
}

/* ------------------------------------------------------------ audit trail */

export interface AuditInput {
  /** Null for an event with no resolved tenant — a failed authentication. */
  tenantId: string | null
  action: AuditAction
  actorType: ActorType
  actorId?: string | null
  resourceType?: string | null
  resourceId?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, JsonValue>
}

/**
 * Append to the audit log.
 *
 * Nothing in this codebase updates or deletes an `AuditEvent`: an audit trail
 * the audited system can edit is decoration. There is no `updateAudit`, and
 * adding one should be treated as a bug report against this comment.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      tenantId: input.tenantId,
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      metadata: toJson(input.metadata ?? {}),
    },
  })
}

/**
 * Audit an action without letting the logging fail the action.
 *
 * A cancelled run that could not be written to the audit log is still a
 * cancelled run; throwing here would turn an observability outage into a
 * user-facing one. The failure is reported to stderr, where the log pipeline
 * picks it up.
 */
export async function recordAuditSafely(input: AuditInput): Promise<void> {
  await recordAudit(input).catch((error: unknown) => {
    console.error("[audit] failed to record event", { action: input.action, error })
  })
}

export async function listAuditEvents(options: {
  tenantId: string
  limit?: number
}): Promise<AuditEvent[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { tenantId: options.tenantId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
  })
  return rows.map(toAuditEvent)
}

/* --------------------------------------------------- webhook idempotency */

/**
 * Claim a webhook delivery, or report that it was already handled.
 *
 * Svix retries, and a retried `organizationMembership.updated` must not be
 * applied twice. The claim is an insert on the delivery's own id, so two API
 * replicas racing on the same retry resolve it in the database rather than in a
 * read-then-write window between them.
 */
export async function claimWebhookDelivery(id: string, type: string): Promise<boolean> {
  const claimed = await prisma.webhookDelivery.createMany({
    data: [{ id, type }],
    skipDuplicates: true,
  })
  return claimed.count === 1
}
