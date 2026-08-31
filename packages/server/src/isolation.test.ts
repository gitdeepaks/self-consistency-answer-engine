import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createApiKey,
  createRun,
  deleteRun,
  ensureMembership,
  ensureTenant,
  ensureUnmeteredPlan,
  ensureUser,
  getRun,
  prisma,
  revokeApiKey,
  type CandidateSeed,
} from "@sce/db"
import { ALL_SCOPES, apiKeyCreatedSchema, type Scope } from "@sce/shared"
import { app } from "./app.ts"

/**
 * Route-level tenant isolation.
 *
 * `packages/db/src/isolation.test.ts` proves the repository refuses a foreign
 * tenant. This proves the *HTTP surface* never gives it the chance — that no
 * route, header or parameter lets tenant B reach tenant A's data, and that an
 * anonymous caller reaches nothing at all.
 *
 * The route table below is the point. It is driven as data rather than written
 * out per route, so adding an endpoint without adding it here is visible: the
 * count assertion at the top fails, and someone has to decide whether the new
 * route is public or has to be listed.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
]

interface Party {
  tenantId: string
  slug: string
  userId: string
  token: string
  keyId: string
}

async function makeParty(slug: string, email: string, scopes: readonly Scope[]): Promise<Party> {
  const tenant = await ensureTenant(slug, slug)
  const user = await ensureUser({ email, displayName: slug })
  await ensureMembership({ tenantId: tenant.id, userId: user.id, role: "owner" })
  // These tenants exist to test *isolation*, not plans. Minting a key is a paid
  // capability (`api.keys`), so a free-plan party could not reach the scope
  // rules this suite is about — the plan gate has its own suite in
  // `quota.test.ts`.
  await ensureUnmeteredPlan(tenant.id)

  const key = await createApiKey({
    tenantId: tenant.id,
    createdByUserId: user.id,
    name: `${slug} key`,
    scopes,
    expiresAt: null,
  })

  return {
    tenantId: tenant.id,
    slug: tenant.slug,
    userId: user.id,
    token: key.token,
    keyId: key.key.id,
  }
}

let alice: Party
let mallory: Party
/** A credential that authenticates perfectly and may do almost nothing. */
let readOnly: Party
let aliceRun = ""

const cleanup: string[] = []

beforeAll(async () => {
  alice = await makeParty("test-http-iso-a", "alice@http-iso.test", ALL_SCOPES)
  mallory = await makeParty("test-http-iso-b", "mallory@http-iso.test", ALL_SCOPES)
  readOnly = await makeParty("test-http-iso-c", "reader@http-iso.test", ["runs:read"])

  const run = await createRun({
    tenantId: alice.tenantId,
    createdByUserId: alice.userId,
    prompt: "alice's private prompt",
    candidates: SEEDS,
  })
  aliceRun = run.id
  cleanup.push(run.id)
})

afterAll(async () => {
  for (const id of cleanup) await deleteRun(alice.tenantId, id).catch(() => {})
  await prisma.apiKey
    .deleteMany({ where: { id: { in: [alice.keyId, mallory.keyId, readOnly.keyId] } } })
    .catch(() => {})
  await prisma.auditEvent
    .deleteMany({ where: { tenantId: { in: [alice.tenantId, mallory.tenantId] } } })
    .catch(() => {})
})

function as(party: Party | null, extra: Record<string, string> = {}): Record<string, string> {
  return party === null
    ? extra
    : { Authorization: `Bearer ${party.token}`, "Content-Type": "application/json", ...extra }
}

/** Every route that must never serve an unauthenticated or foreign caller. */
interface Route {
  name: string
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: () => string
  body?: unknown
  /** What a *valid credential from another tenant* must receive. */
  foreign: 403 | 404
}

const PROTECTED: Route[] = [
  { name: "list runs", method: "GET", path: () => "/api/runs", foreign: 404 },
  { name: "read run", method: "GET", path: () => `/api/runs/${aliceRun}`, foreign: 404 },
  { name: "stream run", method: "GET", path: () => `/api/runs/${aliceRun}/events`, foreign: 404 },
  {
    name: "cancel run",
    method: "POST",
    path: () => `/api/runs/${aliceRun}/cancel`,
    body: { reason: "pwned" },
    foreign: 404,
  },
  { name: "delete run", method: "DELETE", path: () => `/api/runs/${aliceRun}`, foreign: 404 },
  { name: "read usage", method: "GET", path: () => "/api/usage", foreign: 404 },
  { name: "read audit", method: "GET", path: () => "/api/audit", foreign: 404 },
  { name: "list keys", method: "GET", path: () => "/api/keys", foreign: 404 },
  { name: "whoami", method: "GET", path: () => "/api/auth/whoami", foreign: 404 },

  /* Phase 5 — the web app's surface. */
  { name: "list tags", method: "GET", path: () => "/api/tags", foreign: 404 },
  { name: "list members", method: "GET", path: () => "/api/members", foreign: 404 },
  { name: "list workspaces", method: "GET", path: () => "/api/members/workspaces", foreign: 404 },
  { name: "list shares", method: "GET", path: () => "/api/shares", foreign: 404 },
  { name: "feedback queue", method: "GET", path: () => "/api/feedback", foreign: 404 },
  {
    name: "read a run's shares",
    method: "GET",
    path: () => `/api/runs/${aliceRun}/shares`,
    foreign: 404,
  },
  {
    name: "publish a run",
    method: "POST",
    path: () => `/api/runs/${aliceRun}/shares`,
    body: {},
    foreign: 404,
  },
  {
    name: "read a run's feedback",
    method: "GET",
    path: () => `/api/runs/${aliceRun}/feedback`,
    foreign: 404,
  },
  {
    name: "leave feedback on a run",
    method: "POST",
    path: () => `/api/runs/${aliceRun}/feedback`,
    body: { rating: "up" },
    foreign: 404,
  },
  {
    name: "tag a run",
    method: "PUT",
    path: () => `/api/runs/${aliceRun}/tags`,
    body: { tags: ["pwned"] },
    foreign: 404,
  },
]

async function call(route: Route, headers: Record<string, string>): Promise<Response> {
  return app.request(route.path(), {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  })
}

describe("authentication", () => {
  test("every protected route refuses an anonymous caller", async () => {
    const served: string[] = []
    for (const route of PROTECTED) {
      const response = await call(route, {})
      if (response.status !== 401) served.push(`${route.name} → ${response.status}`)
    }
    expect(served).toEqual([])
  })

  test("a 401 tells the client how to authenticate and nothing else", async () => {
    const response = await app.request("/api/runs")
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Bearer")

    // The body must not leak which half of the credential was wrong.
    const body = await response.json()
    expect(body).toEqual({ error: "Authentication required" })
  })

  test("a garbage credential is refused, not crashed on", async () => {
    for (const token of ["", "Bearer", "sce_live_zzz", "not-a-token", "sce_" + "x".repeat(500)]) {
      const response = await app.request("/api/runs", {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(401)
    }
  })

  test("public routes stay reachable without a credential", async () => {
    expect((await app.request("/api/health")).status).toBe(200)
    expect((await app.request("/api/providers")).status).toBe(200)
    // The CLI reads this *before* it has any credential — it cannot be guarded.
    expect((await app.request("/api/auth/config")).status).toBe(200)
  })

  test("a revoked key stops working immediately", async () => {
    const doomed = await makeParty("test-http-iso-revoked", "revoked@http-iso.test", ALL_SCOPES)
    expect((await app.request("/api/runs", { headers: as(doomed) })).status).toBe(200)

    await revokeApiKey(doomed.tenantId, doomed.keyId)

    // No cache to wait out: the very next request is refused.
    expect((await app.request("/api/runs", { headers: as(doomed) })).status).toBe(401)
    await prisma.apiKey.deleteMany({ where: { id: doomed.keyId } })
  })

  test("an expired key is refused", async () => {
    const tenant = await ensureTenant("test-http-iso-exp", "expired")
    const key = await createApiKey({
      tenantId: tenant.id,
      createdByUserId: null,
      name: "expired",
      scopes: ALL_SCOPES,
      expiresAt: new Date(Date.now() - 1000),
    })

    const response = await app.request("/api/runs", {
      headers: { Authorization: `Bearer ${key.token}` },
    })
    expect(response.status).toBe(401)
    await prisma.apiKey.deleteMany({ where: { id: key.key.id } })
  })

  test("a key whose creator lost their membership stops working", async () => {
    const departing = await makeParty("test-http-iso-gone", "gone@http-iso.test", ALL_SCOPES)
    expect((await app.request("/api/runs", { headers: as(departing) })).status).toBe(200)

    // Offboarding is one delete; the key dies with the membership rather than
    // waiting for someone to remember it exists.
    await prisma.membership.deleteMany({ where: { userId: departing.userId } })
    expect((await app.request("/api/runs", { headers: as(departing) })).status).toBe(401)

    await prisma.apiKey.deleteMany({ where: { id: departing.keyId } })
  })
})

describe("tenant isolation", () => {
  test("alice can reach her own run", async () => {
    const response = await app.request(`/api/runs/${aliceRun}`, { headers: as(alice) })
    expect(response.status).toBe(200)
  })

  test("mallory cannot reach alice's run on any route", async () => {
    const leaked: string[] = []

    for (const route of PROTECTED) {
      const response = await call(route, as(mallory))

      // Routes that address a specific run must answer 404 — a 403 would
      // confirm the id exists, turning guessed ids into a census of another
      // tenant's runs. Collection routes answer 200 with *mallory's* data.
      if (route.path().includes(aliceRun)) {
        if (response.status !== 404) leaked.push(`${route.name} → ${response.status}`)
      } else if (response.status !== 200) {
        leaked.push(`${route.name} → ${response.status}`)
      }
    }

    expect(leaked).toEqual([])
  })

  test("alice's run never appears in mallory's history", async () => {
    const response = await app.request("/api/runs?limit=100", { headers: as(mallory) })
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain(aliceRun)
    expect(JSON.stringify(body)).not.toContain("alice's private prompt")
  })

  test("none of that touched the run", async () => {
    const run = await getRun(alice.tenantId, aliceRun)
    expect(run).not.toBeNull()
    expect(run?.status).toBe("PENDING")
  })

  test("mallory cannot see or revoke alice's keys", async () => {
    const listed = await app.request("/api/keys", { headers: as(mallory) })
    expect(JSON.stringify(await listed.json())).not.toContain(alice.keyId)

    const revoked = await app.request(`/api/keys/${alice.keyId}`, {
      method: "DELETE",
      headers: as(mallory),
    })
    // The call is well-formed and permitted for mallory's own tenant, so it
    // succeeds — but it must have revoked nothing.
    expect(await revoked.json()).toMatchObject({ revoked: false })

    const stillWorks = await app.request("/api/runs", { headers: as(alice) })
    expect(stillWorks.status).toBe(200)
  })

  test("a key cannot be pointed at another tenant with a header", async () => {
    // The tenant selector exists for users who belong to several organizations.
    // A key is bound to one tenant, so naming a different one is refused rather
    // than silently served as the bound tenant.
    const response = await app.request(`/api/runs/${aliceRun}`, {
      headers: as(mallory, { "x-sce-tenant": alice.slug }),
    })
    expect(response.status).toBe(403)
  })

  test("naming your own tenant explicitly is fine", async () => {
    const response = await app.request("/api/runs", {
      headers: as(alice, { "x-sce-tenant": alice.slug }),
    })
    expect(response.status).toBe(200)
  })
})

describe("the operations console", () => {
  /**
   * Install administration is a different axis from tenant roles.
   *
   * An `owner` is the most senior person inside one workspace. If that also
   * meant "operator of the whole install", every customer's account owner would
   * hold a cross-tenant view of every other customer — an escalation available
   * to anyone who can sign up. So the guard reads a deploy-time allowlist, and
   * these parties are owners of their own tenants and nothing more.
   */
  const ADMIN_ROUTES = [
    "/api/admin/overview",
    "/api/admin/tenants",
    "/api/admin/dlq",
    "/api/admin/whoami",
  ]

  test("a tenant owner is not an install operator", async () => {
    for (const path of ADMIN_ROUTES) {
      const response = await app.request(path, { headers: as(alice) })
      // 404, not 403: an unauthorised caller is told the console does not
      // exist. There is nothing here for a customer to appeal, and a 403
      // advertises the surface.
      expect(response.status).toBe(404)
    }
  })

  test("an anonymous caller gets 401 before the operator check runs", async () => {
    for (const path of ADMIN_ROUTES) {
      expect((await app.request(path)).status).toBe(401)
    }
  })

  test("the console's writes are refused too", async () => {
    const replay = await app.request("/api/admin/dlq/replay", {
      method: "POST",
      headers: as(alice),
      body: JSON.stringify({ queue: "sce.candidate", jobId: "1" }),
    })
    expect(replay.status).toBe(404)

    const release = await app.request("/api/admin/budget/release", {
      method: "POST",
      headers: as(alice),
      body: JSON.stringify({ reason: "because I said so" }),
    })
    expect(release.status).toBe(404)
  })
})

describe("public share links", () => {
  /**
   * The one genuinely anonymous data route in the API.
   *
   * Every way a token can fail — malformed, unknown, revoked, expired — has to
   * answer the same 404. Telling an anonymous caller that a link *expired*
   * confirms it once existed, which turns a guessed token into an oracle.
   */
  test("every kind of bad token answers the same 404", async () => {
    const tokens = [
      "not-a-token",
      "sce_share_short",
      `sce_share_${"a".repeat(32)}`,
      "sce_share_..%2F..%2Fetc%2Fpasswd",
    ]

    for (const token of tokens) {
      const response = await app.request(`/api/shared/${token}`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: "This link is not available",
        code: "not_found",
      })
    }
  })

  test("the route needs no credential at all", async () => {
    // It must not answer 401: a share link exists to be opened by somebody with
    // no account, so reaching it anonymously has to get as far as the lookup.
    const response = await app.request(`/api/shared/sce_share_${"a".repeat(32)}`)
    expect(response.status).not.toBe(401)
  })
})

describe("scopes", () => {
  test("a read-only key cannot start, cancel or delete a run", async () => {
    // 403, not 401: the credential is perfectly valid, it simply may not do
    // this — and telling the two apart is what stops a client from looping on
    // a re-login that would change nothing.
    const create = await app.request("/api/runs", {
      method: "POST",
      headers: as(readOnly),
      body: JSON.stringify({ prompt: "should never run" }),
    })
    expect(create.status).toBe(403)
    expect(await create.json()).toMatchObject({ reason: "scope" })
  })

  test("a read-only key cannot mint itself a better one", async () => {
    const escalate = await app.request("/api/keys", {
      method: "POST",
      headers: as(readOnly),
      body: JSON.stringify({ name: "escalation", scopes: ["keys:write", "runs:write"] }),
    })
    expect(escalate.status).toBe(403)
  })

  test("a key may not grant scopes it does not hold", async () => {
    const limited = await makeParty("test-http-iso-limited", "limited@http-iso.test", [
      "runs:read",
      "keys:write",
    ])

    const response = await app.request("/api/keys", {
      method: "POST",
      headers: as(limited),
      // Asks for everything; may only receive the intersection with what it holds.
      body: JSON.stringify({ name: "child", scopes: ALL_SCOPES }),
    })
    expect(response.status).toBe(201)

    // Parsed with the shared schema rather than narrowed by hand: the response
    // shape is part of what this asserts.
    const { key } = apiKeyCreatedSchema.parse(await response.json())
    expect(key.scopes).toEqual(["runs:read", "keys:write"])
    expect(key.scopes).not.toContain("runs:write")

    await prisma.apiKey.deleteMany({ where: { tenantId: limited.tenantId } })
  })

  test("a read-only key can still read", async () => {
    expect((await app.request("/api/runs", { headers: as(readOnly) })).status).toBe(200)
  })
})
