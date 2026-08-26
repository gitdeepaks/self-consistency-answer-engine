import { describe, expect, test } from "bun:test"
import {
  ALL_SCOPES,
  actorTypeFor,
  allows,
  can,
  formatScopeList,
  memberRoleFromClerk,
  parseScopeList,
  permissionSchema,
  permissionsForRole,
  storedScopesSchema,
  type Actor,
  type MemberRole,
  type Permission,
  type Scope,
} from "./index.ts"

/**
 * The authorization matrix.
 *
 * `can()` is the only place in the system that decides whether a request may
 * proceed, which makes it the one function worth enumerating exhaustively
 * rather than spot-checking. Everything below is a claim about the policy, not
 * about the implementation — if a rule changes, a test here should have to
 * change with it, deliberately.
 */

const TENANT = "tenant_a"
const OTHER = "tenant_b"
const ALICE = "user_alice"
const BOB = "user_bob"

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    credential: "session",
    tenantId: TENANT,
    userId: ALICE,
    role: "owner",
    scopes: ALL_SCOPES,
    credentialId: "sess_1",
    ...overrides,
  }
}

describe("roles", () => {
  test("an owner may do everything there is", () => {
    expect([...permissionsForRole("owner")].sort()).toEqual([...permissionSchema.options].sort())
  })

  test("privileges are strictly nested: owner ⊇ admin ⊇ member ⊇ viewer", () => {
    const ladder: MemberRole[] = ["viewer", "member", "admin", "owner"]

    for (let i = 1; i < ladder.length; i++) {
      const lower = permissionsForRole(ladder[i - 1] ?? "viewer")
      const higher = permissionsForRole(ladder[i] ?? "owner")
      const missing = lower.filter((permission) => !higher.includes(permission))
      expect(missing).toEqual([])
    }
  })

  test("a viewer cannot write anything", () => {
    const viewer = actor({ role: "viewer" })
    expect(allows(viewer, "run.create")).toBe(false)
    expect(allows(viewer, "run.delete")).toBe(false)
    expect(allows(viewer, "key.create")).toBe(false)
    expect(allows(viewer, "member.manage")).toBe(false)
    // …but reading is the whole point of the role.
    expect(allows(viewer, "run.read")).toBe(true)
    expect(allows(viewer, "usage.read")).toBe(true)
  })

  test("only an owner may manage the tenant itself", () => {
    for (const role of ["admin", "member", "viewer"] as const) {
      expect(allows(actor({ role }), "tenant.manage")).toBe(false)
    }
    expect(allows(actor({ role: "owner" }), "tenant.manage")).toBe(true)
  })

  test("the audit trail is not readable by ordinary members", () => {
    expect(allows(actor({ role: "member" }), "audit.read")).toBe(false)
    expect(allows(actor({ role: "viewer" }), "audit.read")).toBe(false)
    expect(allows(actor({ role: "admin" }), "audit.read")).toBe(true)
  })
})

describe("scopes", () => {
  test("a credential cannot exceed its scopes, whatever the role", () => {
    // An owner — the most privileged role there is — holding a read-only key.
    const readOnly = actor({ credential: "api-key", scopes: ["runs:read"] })

    expect(allows(readOnly, "run.read")).toBe(true)
    expect(can(readOnly, "run.create")).toEqual({ allowed: false, reason: "scope" })
    expect(can(readOnly, "key.create")).toEqual({ allowed: false, reason: "scope" })
  })

  test("a role cannot be exceeded by scopes either", () => {
    // The mirror image: every scope there is, but only a viewer's role.
    const viewer = actor({ role: "viewer", scopes: ALL_SCOPES })
    expect(can(viewer, "run.create")).toEqual({ allowed: false, reason: "role" })
  })

  test("every permission is reachable through some scope", () => {
    // A permission no scope grants would be dead code that no credential could
    // ever exercise — a policy bug that is invisible from either side alone.
    const unreachable = permissionSchema.options.filter(
      (permission: Permission) => !allows(actor(), permission),
    )
    expect(unreachable).toEqual([])
  })
})

describe("tenancy", () => {
  test("a resource in another tenant is refused before anything else", () => {
    // The most privileged actor there is, denied purely on tenancy.
    expect(can(actor(), "run.read", { tenantId: OTHER })).toEqual({
      allowed: false,
      reason: "cross-tenant",
    })
    expect(can(actor(), "run.delete", { tenantId: OTHER })).toEqual({
      allowed: false,
      reason: "cross-tenant",
    })
  })

  test("cross-tenant beats every other reason, so the response can be a 404", () => {
    // A viewer with no scopes at all: role and scope would both refuse, but
    // tenancy is what must be reported, because that is what maps to "not
    // found" rather than "forbidden" — and 403 on a foreign id confirms it.
    const powerless = actor({ role: "viewer", scopes: [] })
    expect(can(powerless, "run.delete", { tenantId: OTHER })).toEqual({
      allowed: false,
      reason: "cross-tenant",
    })
  })
})

describe("ownership", () => {
  const colleagues = { tenantId: TENANT, createdByUserId: BOB }
  const mine = { tenantId: TENANT, createdByUserId: ALICE }

  test("a member may delete their own run but not a colleague's", () => {
    const member = actor({ role: "member" })
    expect(allows(member, "run.delete", mine)).toBe(true)
    expect(can(member, "run.delete", colleagues)).toEqual({
      allowed: false,
      reason: "not-owner",
    })
  })

  test("an admin may act on anyone's run", () => {
    const admin = actor({ role: "admin" })
    expect(allows(admin, "run.delete", colleagues)).toBe(true)
    expect(allows(admin, "run.cancel", colleagues)).toBe(true)
  })

  test("reading is tenant-wide — a shared library is the point of a tenant", () => {
    expect(allows(actor({ role: "member" }), "run.read", colleagues)).toBe(true)
    expect(allows(actor({ role: "viewer" }), "run.read", colleagues)).toBe(true)
  })

  test("an ownerless run stays tenant-wide rather than stranded", () => {
    // Runs created before Phase 3 have no owner. Treating null as "belongs to
    // someone else" would make every historical run undeletable by its team.
    const legacy = { tenantId: TENANT, createdByUserId: null }
    expect(allows(actor({ role: "member" }), "run.delete", legacy)).toBe(true)
  })

  test("a tenant credential with no user is not treated as owning everything", () => {
    // `userId: null` must not accidentally equal a null `createdByUserId`.
    const key = actor({ credential: "api-key", role: "member", userId: null })
    expect(can(key, "run.delete", colleagues)).toEqual({ allowed: false, reason: "not-owner" })
  })
})

describe("scope wire format", () => {
  test("round-trips through the space-delimited OAuth representation", () => {
    const scopes: Scope[] = ["runs:read", "runs:write"]
    expect(parseScopeList(formatScopeList(scopes))).toEqual(scopes)
  })

  test("unknown scopes are dropped rather than rejected", () => {
    // A newer authorization server granting something this build has never
    // heard of is not an error; ignoring it can only reduce authority.
    expect(parseScopeList("runs:read openid profile future:scope")).toEqual(["runs:read"])
  })

  test("duplicates collapse", () => {
    expect(parseScopeList("runs:read runs:read  runs:write")).toEqual(["runs:read", "runs:write"])
  })

  test("a corrupt stored scope array fails closed", () => {
    expect(storedScopesSchema.parse(["runs:read", "nonsense", ""])).toEqual(["runs:read"])
    expect(storedScopesSchema.parse([])).toEqual([])
  })
})

describe("clerk role mapping", () => {
  // Typed as a table rather than inferred from the literal: without the
  // annotation the tuple widens to `string` and the assertion below would need
  // a cast, which is exactly what this codebase does not do.
  const CLERK_ROLES: readonly (readonly [string, MemberRole])[] = [
    ["org:owner", "owner"],
    ["org:admin", "admin"],
    ["org:member", "member"],
  ]

  test.each(CLERK_ROLES)("%s maps to %s", (clerk, expected) => {
    expect(memberRoleFromClerk(clerk)).toBe(expected)
  })

  test("an unmodelled custom role falls back to the least privilege", () => {
    expect(memberRoleFromClerk("org:billing_manager")).toBe("viewer")
    expect(memberRoleFromClerk("")).toBe("viewer")
  })

  test("a custom role that happens to match ours is honoured", () => {
    expect(memberRoleFromClerk("org:viewer")).toBe("viewer")
  })
})

describe("audit actor types", () => {
  test("both interactive credentials audit as a person", () => {
    expect(actorTypeFor("session")).toBe("USER")
    expect(actorTypeFor("oauth")).toBe("USER")
    expect(actorTypeFor("api-key")).toBe("API_KEY")
  })
})
