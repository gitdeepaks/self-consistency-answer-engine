import { z } from "zod"
import { assertNever } from "./assert.ts"
import { memberRoleSchema, type MemberRole } from "./schemas.ts"

/**
 * Who is asking, and what they are allowed to do.
 *
 * Authorization here is the conjunction of two independent things, and keeping
 * them independent is the whole design:
 *
 *   - a **role**, which is what a *person* may do inside a tenant, and
 *   - a **scope**, which is what *this particular credential* may do on that
 *     person's behalf.
 *
 * An owner who logs the CLI in with a read-only key is still an owner, and the
 * key still cannot start a run. Collapsing the two — letting the role imply the
 * scope, or the scope imply the role — is what turns a leaked CI token into a
 * full account takeover, so `can()` requires both to agree.
 */

/* ---------------------------------------------------------------- scopes */

/**
 * What a credential is permitted to attempt.
 *
 * These strings are also the OAuth scopes the CLI requests from Clerk and the
 * scopes stored on an `ApiKey` row, so the vocabulary is the same whether the
 * caller arrived with a session, an OAuth access token or a key. Colon-
 * separated because that is what every OAuth authorization server expects to
 * round-trip through a space-delimited `scope` parameter.
 */
export const scopeSchema = z.enum([
  "runs:read",
  "runs:write",
  "usage:read",
  "keys:read",
  "keys:write",
  "members:read",
  "members:write",
  "audit:read",
])
export type Scope = z.infer<typeof scopeSchema>

export const ALL_SCOPES: readonly Scope[] = scopeSchema.options

/** What a key gets when the caller does not ask for anything narrower. */
export const DEFAULT_SCOPES: readonly Scope[] = ["runs:read", "runs:write", "usage:read"]

/**
 * Parse a space-delimited `scope` string — the wire format OAuth uses.
 *
 * Unknown scopes are dropped rather than rejected: an authorization server that
 * grants a scope this build has never heard of is not an error, it is a newer
 * server, and the safe reading of an unrecognised grant is to ignore it.
 */
export function parseScopeList(raw: string): Scope[] {
  const seen = new Set<Scope>()
  for (const candidate of raw.split(/\s+/)) {
    const parsed = scopeSchema.safeParse(candidate)
    if (parsed.success) seen.add(parsed.data)
  }
  return [...seen]
}

/** Render scopes back into the wire format. */
export function formatScopeList(scopes: readonly Scope[]): string {
  return scopes.join(" ")
}

/**
 * Scopes stored on a row, read back.
 *
 * A `String[]` column is unvalidated input like any other: it may have been
 * written by an older build, or edited in psql. An unreadable entry is dropped,
 * which fails closed — the credential ends up with fewer permissions, never
 * more.
 */
export const storedScopesSchema = z
  .array(z.string())
  .transform((values) => values.flatMap((value) => scopeSchema.safeParse(value).data ?? []))

/* ----------------------------------------------------------- permissions */

/**
 * A single thing a caller can try to do.
 *
 * Routes ask for one of these; roles and scopes each grant a set of them. The
 * indirection is what stops authorization logic from being spelled out at every
 * route as an ad-hoc role comparison.
 */
export const permissionSchema = z.enum([
  "run.create",
  "run.read",
  "run.cancel",
  "run.delete",
  "usage.read",
  "key.create",
  "key.read",
  "key.revoke",
  "member.read",
  "member.manage",
  "tenant.manage",
  "audit.read",
])
export type Permission = z.infer<typeof permissionSchema>

/**
 * What each role may do.
 *
 * Written as an exhaustive switch rather than a lookup table so that adding a
 * role is a compile error here — in the one place where forgetting to decide
 * means a new role silently inherits whatever the fallback happened to be.
 */
export function permissionsForRole(role: MemberRole): readonly Permission[] {
  switch (role) {
    case "owner":
      return permissionSchema.options
    case "admin":
      return [
        "run.create",
        "run.read",
        "run.cancel",
        "run.delete",
        "usage.read",
        "key.create",
        "key.read",
        "key.revoke",
        "member.read",
        "member.manage",
        "audit.read",
      ]
    case "member":
      return ["run.create", "run.read", "run.cancel", "run.delete", "usage.read", "member.read"]
    case "viewer":
      return ["run.read", "usage.read", "member.read"]
    default:
      return assertNever(role, "permissionsForRole")
  }
}

/** What each scope unlocks. Same exhaustiveness argument as roles. */
export function permissionsForScope(scope: Scope): readonly Permission[] {
  switch (scope) {
    case "runs:read":
      return ["run.read"]
    case "runs:write":
      return ["run.create", "run.cancel", "run.delete"]
    case "usage:read":
      return ["usage.read"]
    case "keys:read":
      return ["key.read"]
    case "keys:write":
      return ["key.create", "key.revoke"]
    case "members:read":
      return ["member.read"]
    case "members:write":
      return ["member.manage", "tenant.manage"]
    case "audit:read":
      return ["audit.read"]
    default:
      return assertNever(scope, "permissionsForScope")
  }
}

/* ----------------------------------------------------------------- actor */

/** How the caller proved who they are. */
export const credentialKindSchema = z.enum(["session", "oauth", "api-key"])
export type CredentialKind = z.infer<typeof credentialKindSchema>

/**
 * The authenticated principal behind a request.
 *
 * `tenantId` is the tenant this request acts inside — one value, resolved once,
 * and the only owner any repository call is ever given. `userId` is null for a
 * key that belongs to a tenant rather than a person, which is the normal shape
 * of a CI credential.
 */
export const actorSchema = z.object({
  credential: credentialKindSchema,
  tenantId: z.string().min(1),
  userId: z.string().min(1).nullable(),
  role: memberRoleSchema,
  scopes: z.array(scopeSchema).readonly(),
  /** Identifier of the credential itself — an `ApiKey` id, or a Clerk session/client id. */
  credentialId: z.string().min(1).nullable(),
})
export type Actor = z.infer<typeof actorSchema>

/**
 * The thing being acted on.
 *
 * Carrying the owner lets `can()` express "a member may delete their own run
 * but not a colleague's" without every route re-deriving it, and carrying the
 * tenant makes cross-tenant access a policy failure as well as an empty query
 * result — two independent barriers rather than one.
 */
export interface Resource {
  tenantId: string
  /** Null when the resource has no individual owner, or predates identity. */
  createdByUserId?: string | null
}

/** Why a request was refused, in a form the HTTP layer can map to a status. */
export type DenialReason = "cross-tenant" | "role" | "scope" | "not-owner"

export type Decision = { allowed: true } | { allowed: false; reason: DenialReason }

/**
 * Permissions that a non-admin may exercise only on something they own.
 *
 * Reading is deliberately absent: a shared run library is the point of a
 * tenant, so every member reads everything inside it. Destructive verbs are
 * the ones that need an owner.
 */
const OWNER_ONLY_FOR_MEMBERS: readonly Permission[] = ["run.delete", "run.cancel"]

/**
 * The single authorization decision in the system.
 *
 * Every route funnels through this rather than comparing roles inline, because
 * a policy that lives in one function can be read, tested and audited in one
 * place — and `authorization.test.ts` enumerates the whole matrix against it.
 */
export function can(actor: Actor, permission: Permission, resource?: Resource): Decision {
  // Cross-tenant first: nothing a role or scope says can make this acceptable,
  // and checking it first means a mis-scoped resource can never reach the
  // cheaper checks below and be allowed by them.
  if (resource !== undefined && resource.tenantId !== actor.tenantId) {
    return { allowed: false, reason: "cross-tenant" }
  }

  if (!permissionsForRole(actor.role).includes(permission)) {
    return { allowed: false, reason: "role" }
  }

  const granted = actor.scopes.some((scope) => permissionsForScope(scope).includes(permission))
  if (!granted) return { allowed: false, reason: "scope" }

  if (
    resource !== undefined &&
    OWNER_ONLY_FOR_MEMBERS.includes(permission) &&
    (actor.role === "member" || actor.role === "viewer") &&
    // A run created before identity existed has no owner and stays tenant-wide;
    // treating null as "belongs to nobody, so nobody but an admin may touch it"
    // would strand every pre-Phase-3 run.
    resource.createdByUserId != null &&
    resource.createdByUserId !== actor.userId
  ) {
    return { allowed: false, reason: "not-owner" }
  }

  return { allowed: true }
}

/** `can()` reduced to a boolean, for call sites that do not report the reason. */
export function allows(actor: Actor, permission: Permission, resource?: Resource): boolean {
  return can(actor, permission, resource).allowed
}

/* ----------------------------------------------------------- clerk roles */

/**
 * Clerk's organization roles, mapped onto ours.
 *
 * Clerk namespaces its roles (`org:admin`); ours are a closed enum owned by
 * this codebase. Mapping in one place means a Clerk role we do not recognise
 * lands on `viewer` — the least privilege available — rather than throwing
 * inside a webhook that Clerk will then retry forever.
 */
export function memberRoleFromClerk(clerkRole: string): MemberRole {
  switch (clerkRole) {
    case "org:owner":
      return "owner"
    case "org:admin":
      return "admin"
    case "org:member":
      return "member"
    default: {
      // Custom roles created in the Clerk dashboard arrive verbatim. Honour one
      // that happens to match ours exactly; otherwise fail closed.
      const known = memberRoleSchema.safeParse(clerkRole.replace(/^org:/, ""))
      return known.success ? known.data : "viewer"
    }
  }
}

/* -------------------------------------------------------------- api keys */

/**
 * An API key as anyone other than its creator ever sees it.
 *
 * There is no `token` field and there never will be: the secret exists once, in
 * the response to the request that created it. Everything afterwards — the web
 * UI, `sce keys list`, an audit trail — works from the prefix.
 */
export const apiKeySummarySchema = z.object({
  id: z.string(),
  /** Human label, so a key can be revoked without guessing what it was for. */
  name: z.string(),
  /** `sce_live_a1b2c3d4e5f6` — identifies the key without authenticating it. */
  prefix: z.string(),
  scopes: z.array(scopeSchema),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>

/** The one response that carries a secret, returned exactly once at creation. */
export const apiKeyCreatedSchema = z.object({
  key: apiKeySummarySchema,
  /** Shown once. Clients that do not store it now cannot recover it later. */
  token: z.string(),
})
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>

export const createApiKeyInputSchema = z.object({
  name: z.string().trim().min(1, "A key needs a name").max(80),
  /** Omitted means `DEFAULT_SCOPES`; a caller can never grant itself more than it holds. */
  scopes: z.array(scopeSchema).min(1).optional(),
  /** Days until the key stops working. Absent means it does not expire. */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

/* ----------------------------------------------------------- audit trail */

/**
 * What happened, in the append-only log.
 *
 * SCREAMING_SNAKE because these labels are also the Postgres enum: dotted names
 * would need a mapping layer between the database and this union, and a mapping
 * layer is exactly where the two drift apart. `auth.schema.test.ts` asserts the
 * two definitions still match.
 */
export const auditActionSchema = z.enum([
  "AUTH_SUCCEEDED",
  "AUTH_FAILED",
  "API_KEY_CREATED",
  "API_KEY_REVOKED",
  "MEMBER_ADDED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "TENANT_CREATED",
  "TENANT_UPDATED",
  "TENANT_DELETED",
  "USER_SYNCED",
  "USER_DELETED",
  "RUN_CANCELED",
  "RUN_DELETED",
  /* Phase 4 — plans, quotas and the spend guard. */
  "PLAN_CHANGED",
  "SUBSCRIPTION_UPDATED",
  "QUOTA_EXCEEDED",
  "BUDGET_TRIPPED",
  "KILL_SWITCH_RELEASED",
])
export type AuditAction = z.infer<typeof auditActionSchema>

/** Who performed an audited action. */
export const actorTypeSchema = z.enum(["USER", "API_KEY", "SYSTEM"])
export type ActorType = z.infer<typeof actorTypeSchema>

export const auditEventSchema = z.object({
  id: z.string(),
  action: auditActionSchema,
  actorType: actorTypeSchema,
  actorId: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
})
export type AuditEvent = z.infer<typeof auditEventSchema>

/** The credential kind an audited actor used, as an `ActorType`. */
export function actorTypeFor(credential: CredentialKind): ActorType {
  switch (credential) {
    case "session":
    case "oauth":
      return "USER"
    case "api-key":
      return "API_KEY"
    default:
      return assertNever(credential, "actorTypeFor")
  }
}
