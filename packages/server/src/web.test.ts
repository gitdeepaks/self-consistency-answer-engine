import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  ALL_SCOPES,
  feedbackSummarySchema,
  runShareSchema,
  runSummarySchema,
  sharedRunSchema,
} from "@sce/shared"
import { z } from "zod"
import { app } from "./app.ts"

/**
 * The HTTP surface Phase 5's web app consumes.
 *
 * Search, tags, sharing and feedback, driven through the real router with a
 * real credential — so the validators, the permission checks and the tenant
 * resolution are all under test on every request, not stubbed around.
 *
 * `isolation.test.ts` proves these routes refuse the wrong caller. This proves
 * they do the right thing for the right one.
 */

const {
  createApiKey,
  createRun,
  defaultTenant,
  deleteRun,
  ensureUnmeteredPlan,
  prisma,
  saveSynthesis,
  setRunTags,
} = await import("@sce/db")

const tenantId = (await defaultTenant()).id
await ensureUnmeteredPlan(tenantId)

const bootstrap = await createApiKey({
  tenantId,
  createdByUserId: null,
  name: "web.test.ts",
  scopes: ALL_SCOPES,
  expiresAt: null,
})
const AUTH = { Authorization: `Bearer ${bootstrap.token}`, "Content-Type": "application/json" }

const created: string[] = []

const shareEnvelope = z.object({ share: runShareSchema })
const sharesEnvelope = z.object({ shares: z.array(runShareSchema) })
const sharedEnvelope = z.object({ run: sharedRunSchema })
const feedbackEnvelope = z.object({ feedback: feedbackSummarySchema })
const tagsEnvelope = z.object({ tags: z.array(z.string()) })
const historyEnvelope = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json())
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, { ...init, headers: { ...AUTH, ...init.headers } })
}

async function send(method: string, path: string, body: unknown): Promise<Response> {
  return request(path, { method, body: JSON.stringify(body) })
}

/** A finished run, so there is something worth sharing and rating. */
async function completedRun(prompt: string, tags: string[] = []): Promise<string> {
  const run = await createRun({
    tenantId,
    prompt,
    candidates: [
      { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
      { provider: "google", label: "Gemini", model: "gemini-3.7-flash", status: "PENDING" },
    ],
  })
  created.push(run.id)

  await saveSynthesis(tenantId, run.id, {
    model: "claude-opus-5",
    finalAnswer: `A synthesised answer about ${prompt}.`,
    agreements: ["they agreed"],
    disagreements: [],
    reviews: [],
    confidence: 0.88,
    latencyMs: 900,
    inputTokens: 100,
    outputTokens: 50,
  })

  if (tags.length > 0) await setRunTags(tenantId, run.id, tags)
  return run.id
}

let searchable = ""
let taggable = ""

beforeAll(async () => {
  searchable = await completedRun("kubernetes ingress controllers", ["infra"])
  taggable = await completedRun("postgres connection pooling", ["infra", "database"])
})

afterAll(async () => {
  await prisma.runShare.deleteMany({ where: { tenantId } }).catch(() => {})
  await prisma.runFeedback.deleteMany({ where: { tenantId } }).catch(() => {})
  for (const id of created) await deleteRun(tenantId, id).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { id: bootstrap.key.id } }).catch(() => {})
})

describe("history search", () => {
  test("a bare request still means what it always meant", async () => {
    // The CLI issues exactly this and must keep working unchanged.
    const body = await readJson(await request("/api/runs?limit=5"), historyEnvelope)
    expect(body.items.length).toBeGreaterThan(0)
  })

  test("free text matches the prompt", async () => {
    const body = await readJson(await request("/api/runs?q=kubernetes"), historyEnvelope)
    expect(body.items.some((item) => item.id === searchable)).toBe(true)
    expect(body.items.some((item) => item.id === taggable)).toBe(false)
  })

  test("free text matches the synthesised answer too", async () => {
    // People search for the answer they got, not only the question they asked.
    const body = await readJson(
      await request("/api/runs?q=" + encodeURIComponent("synthesised answer about postgres")),
      historyEnvelope,
    )
    expect(body.items.some((item) => item.id === taggable)).toBe(true)
  })

  test("search is case-insensitive", async () => {
    const body = await readJson(await request("/api/runs?q=KUBERNETES"), historyEnvelope)
    expect(body.items.some((item) => item.id === searchable)).toBe(true)
  })

  test("a tag filter narrows to runs carrying any of them", async () => {
    const both = await readJson(await request("/api/runs?tags=infra"), historyEnvelope)
    expect(both.items.some((item) => item.id === searchable)).toBe(true)
    expect(both.items.some((item) => item.id === taggable)).toBe(true)

    const one = await readJson(await request("/api/runs?tags=database"), historyEnvelope)
    expect(one.items.some((item) => item.id === taggable)).toBe(true)
    expect(one.items.some((item) => item.id === searchable)).toBe(false)
  })

  test("a provider filter matches runs that asked any of them", async () => {
    const hit = await readJson(await request("/api/runs?providers=google"), historyEnvelope)
    expect(hit.items.some((item) => item.id === searchable)).toBe(true)

    const miss = await readJson(await request("/api/runs?providers=anthropic"), historyEnvelope)
    expect(miss.items.some((item) => item.id === searchable)).toBe(false)
  })

  test("an unknown provider in the list is dropped rather than rejected", async () => {
    // A bookmarked URL naming a provider this build no longer ships is a stale
    // link, not a 400.
    const response = await request("/api/runs?providers=google,mistral")
    expect(response.status).toBe(200)
    const body = historyEnvelope.parse(await response.json())
    expect(body.items.some((item) => item.id === searchable)).toBe(true)
  })

  test("a malformed date is a 400, because there is no safe narrowing of it", async () => {
    expect((await request("/api/runs?from=yesterday")).status).toBe(400)
  })

  test("a confidence floor excludes runs without a synthesis", async () => {
    const bare = await createRun({
      tenantId,
      prompt: "never synthesised",
      candidates: [{ provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" }],
    })
    created.push(bare.id)

    const body = await readJson(await request("/api/runs?minConfidence=0"), historyEnvelope)
    expect(body.items.some((item) => item.id === bare.id)).toBe(false)
    expect(body.items.some((item) => item.id === searchable)).toBe(true)
  })

  test("the summary carries the confidence a list needs to sort on", async () => {
    const body = await readJson(await request(`/api/runs?q=kubernetes`), historyEnvelope)
    expect(body.items[0]?.confidence).toBeCloseTo(0.88, 5)
    expect(body.items[0]?.tags).toEqual(["infra"])
  })

  test("`to` covers the whole day it names", async () => {
    // A naive `lt: <day>T00:00:00Z` drops everything that happened on the day
    // the user asked for, which reads as a bug every single time.
    const today = new Date().toISOString().slice(0, 10)
    const body = await readJson(await request(`/api/runs?to=${today}`), historyEnvelope)
    expect(body.items.some((item) => item.id === searchable)).toBe(true)
  })
})

describe("tags", () => {
  test("tags are replaced wholesale and deduplicated", async () => {
    const body = await readJson(
      await send("PUT", `/api/runs/${taggable}/tags`, { tags: ["alpha", "alpha", "beta"] }),
      tagsEnvelope,
    )
    expect(body.tags).toEqual(["alpha", "beta"])
  })

  test("an invalid tag is refused before it reaches the database", async () => {
    const response = await send("PUT", `/api/runs/${taggable}/tags`, { tags: ["has space"] })
    expect(response.status).toBe(400)
  })

  test("more than sixteen tags is refused", async () => {
    const many = Array.from({ length: 17 }, (_, index) => `tag${index}`)
    expect((await send("PUT", `/api/runs/${taggable}/tags`, { tags: many })).status).toBe(400)
  })

  test("tagging a run that does not exist is a 404", async () => {
    const response = await send("PUT", "/api/runs/run_nope/tags", { tags: ["x"] })
    expect(response.status).toBe(404)
  })

  test("the tag index reports what is in use, with counts", async () => {
    await send("PUT", `/api/runs/${searchable}/tags`, { tags: ["shared-tag"] })
    await send("PUT", `/api/runs/${taggable}/tags`, { tags: ["shared-tag", "solo"] })

    const body = z
      .object({ tags: z.array(z.object({ tag: z.string(), count: z.number() })) })
      .parse(await (await request("/api/tags")).json())

    expect(body.tags.find((entry) => entry.tag === "shared-tag")?.count).toBe(2)
    expect(body.tags.find((entry) => entry.tag === "solo")?.count).toBe(1)
  })
})

describe("sharing", () => {
  test("publishing returns a link, and the link serves the answer anonymously", async () => {
    const created = await send("POST", `/api/runs/${searchable}/shares`, { label: "for review" })
    expect(created.status).toBe(201)

    const { share } = await readJson(created, shareEnvelope)

    // No credential at all — the whole point of the route.
    const response = await app.request(`/api/shared/${share.token}`)
    expect(response.status).toBe(200)

    const { run } = await readJson(response, sharedEnvelope)
    expect(run.prompt).toBe("kubernetes ingress controllers")
    expect(run.finalAnswer).toContain("synthesised answer")
    expect(run.panel).toHaveLength(2)
  })

  test("the shared projection leaks no identity, no drafts and no cost", async () => {
    const { share } = await readJson(
      await send("POST", `/api/runs/${searchable}/shares`, {}),
      shareEnvelope,
    )
    const raw = await (await app.request(`/api/shared/${share.token}`)).text()

    expect(raw).not.toContain(tenantId)
    expect(raw).not.toContain(searchable)
    expect(raw).not.toContain("createdByUserId")
    expect(raw).not.toContain("costMicroCents")
    expect(raw).not.toContain("inputTokens")
  })

  test("a run with no synthesis cannot be published", async () => {
    const bare = await createRun({
      tenantId,
      prompt: "nothing to publish",
      candidates: [{ provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" }],
    })
    created.push(bare.id)

    const response = await send("POST", `/api/runs/${bare.id}/shares`, {})
    expect(response.status).toBe(409)
  })

  test("revoking a link takes effect on the very next request", async () => {
    const { share } = await readJson(
      await send("POST", `/api/runs/${searchable}/shares`, {}),
      shareEnvelope,
    )
    expect((await app.request(`/api/shared/${share.token}`)).status).toBe(200)

    expect((await request(`/api/shares/${share.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await app.request(`/api/shared/${share.token}`)).status).toBe(404)
  })

  test("dead links stay listed so they can be explained", async () => {
    const { shares } = await readJson(await request("/api/shares"), sharesEnvelope)
    expect(shares.some((share) => share.revokedAt !== null)).toBe(true)
  })

  test("a run's own links are listed against it", async () => {
    const { shares } = await readJson(
      await request(`/api/runs/${searchable}/shares`),
      sharesEnvelope,
    )
    expect(shares.length).toBeGreaterThan(0)
    expect(shares.every((share) => share.runId === searchable)).toBe(true)
  })

  test("listing links for a run that does not exist is a 404", async () => {
    expect((await request("/api/runs/run_nope/shares")).status).toBe(404)
  })
})

describe("feedback", () => {
  test("a credential with no person behind it cannot leave a verdict", async () => {
    // The bootstrap key has no `createdByUserId`. An unattributable verdict is
    // noise in a dataset whose whole value is that a human produced it.
    const response = await send("POST", `/api/runs/${searchable}/feedback`, { rating: "up" })
    expect(response.status).toBe(403)
  })

  test("the tally is readable even by a credential that cannot vote", async () => {
    const body = await readJson(
      await request(`/api/runs/${searchable}/feedback`),
      feedbackEnvelope,
    )
    expect(body.feedback.up).toBe(0)
    expect(body.feedback.down).toBe(0)
    expect(body.feedback.mine).toBeNull()
  })

  test("an invalid rating is refused", async () => {
    const response = await send("POST", `/api/runs/${searchable}/feedback`, { rating: "sideways" })
    expect(response.status).toBe(400)
  })

  test("feedback on a run that does not exist is a 404 or a 403, never a new row", async () => {
    const response = await send("POST", "/api/runs/run_nope/feedback", { rating: "up" })
    expect([403, 404]).toContain(response.status)
    expect(await prisma.runFeedback.count({ where: { runId: "run_nope" } })).toBe(0)
  })
})

describe("the roster", () => {
  test("members are listed for the calling workspace", async () => {
    const response = await request("/api/members")
    expect(response.status).toBe(200)
    const body = z
      .object({ members: z.array(z.object({ userId: z.string(), email: z.string() })) })
      .parse(await response.json())
    expect(Array.isArray(body.members)).toBe(true)
  })

  test("a key-bound credential belongs to exactly one workspace", async () => {
    const body = z
      .object({
        workspaces: z.array(z.unknown()),
        reason: z.string().nullable(),
      })
      .parse(await (await request("/api/members/workspaces")).json())

    // It has no person, so there is no set of workspaces to choose between.
    expect(body.workspaces).toHaveLength(0)
    expect(body.reason).toBe("credential-bound-to-one-workspace")
  })
})
