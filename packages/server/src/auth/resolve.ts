import {
  findUserByExternalId,
  recordAuditSafely,
  resolveMembership,
  tenantMatches,
  touchApiKey,
  verifyApiKey,
  type ApiKeyRejection,
} from "@sce/db"
import { ALL_SCOPES, looksLikeApiKey, type Actor, type Scope } from "@sce/shared"
import { verifyClerkRequest } from "./clerk.ts"

/**
 * From an HTTP request to an `Actor`, or to a refusal.
 *
 * This is the only place in the system that decides who someone is. Route
 * handlers never look at a header; they read the actor the middleware attached,
 * and pass `actor.tenantId` to the repository. That is what keeps tenant
 * isolation a property of one function rather than a habit spread across
 * fifteen.
 */

/**
 * Which tenant to act inside, for a principal that belongs to several.
 *
 * A browser has an active organization in its session; a terminal does not, so
 * the CLI names one. Slug or id are both accepted because a human types the
 * slug and a machine stores the id.
 */
export const TENANT_HEADER = "x-sce-tenant"

export type AuthFailure =
  /** No credential at all, or one that does not identify anybody. */
  | { ok: false; status: 401; reason: string }
  /** Authenticated, but not a member of the tenant they asked to act inside. */
  | { ok: false; status: 403; reason: string }

export type Authentication = { ok: true; actor: Actor } | AuthFailure

/** The bearer token, or null. Case-insensitive scheme, per RFC 9110. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (header === null) return null

  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

function requestedTenant(request: Request): string | null {
  const raw = request.headers.get(TENANT_HEADER)?.trim()
  return raw === undefined || raw === "" ? null : raw
}

/** Request provenance for the audit log. Attacker-controlled; stored, never trusted. */
export function requestProvenance(request: Request): { ip: string | null; userAgent: string | null } {
  // Left-most entry of `x-forwarded-for` is the client as the first proxy saw
  // it. Only meaningful behind a proxy that overwrites the header; recorded for
  // correlation, and never used to make a decision.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return {
    ip: forwarded === undefined || forwarded === "" ? null : forwarded,
    userAgent: request.headers.get("user-agent"),
  }
}

/**
 * Refusals worth recording.
 *
 * A key that never existed is not interesting and is unbounded — anyone can
 * send a million bad tokens and would otherwise write a million audit rows. A
 * key that *does* exist and was refused is the opposite: bounded by the number
 * of real keys, and exactly the signal an operator wants ("someone is still
 * using the credential we revoked on Tuesday").
 */
const AUDITED_KEY_REJECTIONS: readonly ApiKeyRejection[] = ["revoked", "expired", "no-membership"]

async function authenticateApiKey(request: Request, token: string): Promise<Authentication> {
  const verification = await verifyApiKey(token)

  if (!verification.ok) {
    if (AUDITED_KEY_REJECTIONS.includes(verification.reason)) {
      const { ip, userAgent } = requestProvenance(request)
      await recordAuditSafely({
        tenantId: null,
        action: "AUTH_FAILED",
        actorType: "API_KEY",
        ip,
        userAgent,
        metadata: { credential: "api-key", reason: verification.reason },
      })
    }
    return { ok: false, status: 401, reason: `api-key-${verification.reason}` }
  }

  const { principal } = verification

  // A key is bound to one tenant, and that binding is the key's whole security
  // boundary. If the caller also named a tenant it must be this one — even when
  // the key's creator is a member of the other, because the credential was
  // issued for A and a request that asked for B must not be served as A.
  const wanted = requestedTenant(request)
  if (wanted !== null && !(await tenantMatches(principal.tenantId, wanted))) {
    return { ok: false, status: 403, reason: "api-key-tenant-mismatch" }
  }

  // Best-effort and throttled; a failure here must not fail the request.
  await touchApiKey(principal.tenantId, principal.keyId).catch(() => {})

  return {
    ok: true,
    actor: {
      credential: "api-key",
      tenantId: principal.tenantId,
      userId: principal.userId,
      role: principal.role,
      scopes: principal.scopes,
      credentialId: principal.keyId,
    },
  }
}

async function authenticateClerk(request: Request): Promise<Authentication> {
  const verification = await verifyClerkRequest(request)
  if (!verification.ok) return { ok: false, status: 401, reason: verification.reason }

  const { principal } = verification

  // Identity lives in Clerk; ownership lives here. A user Clerk knows about but
  // no webhook has mirrored yet cannot own anything locally, so the request is
  // refused rather than served against a row invented on the spot — inventing
  // one is how a race between a webhook and a first request creates two users.
  const user = await findUserByExternalId(principal.externalUserId)
  if (user === null) {
    return { ok: false, status: 403, reason: "user-not-synced" }
  }

  const wanted = requestedTenant(request)
  const membership = await resolveMembership(user.id, {
    // Precedence, not a union: what the caller explicitly asked for, else the
    // organization the session is already acting inside, else their oldest
    // membership. Naming a tenant they do not belong to must fail, never fall
    // back — a request that asked to act as A and was served as B is the
    // confusion this phase exists to remove.
    identifier: wanted,
    externalId: principal.externalOrgId,
  })

  if (membership === null) {
    return {
      ok: false,
      status: 403,
      reason: wanted === null ? "no-membership" : "not-a-member-of-requested-tenant",
    }
  }

  const scopes: readonly Scope[] = principal.scopes === "all" ? ALL_SCOPES : principal.scopes

  return {
    ok: true,
    actor: {
      credential: principal.kind,
      tenantId: membership.tenant.id,
      userId: user.id,
      role: membership.role,
      scopes,
      credentialId: principal.credentialId,
    },
  }
}

/**
 * Authenticate a request.
 *
 * The order is by cost: our own key format is recognised from its prefix and
 * settled with one indexed lookup, so it never pays for a Clerk round trip.
 * Anything else — a session cookie, an OAuth access token — goes to Clerk.
 */
export async function authenticate(request: Request): Promise<Authentication> {
  const token = bearerToken(request)

  if (token !== null && looksLikeApiKey(token)) {
    return authenticateApiKey(request, token)
  }

  return authenticateClerk(request)
}
