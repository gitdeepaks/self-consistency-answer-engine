import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mintShareToken, shareIsLive } from "@sce/shared"
import { prisma } from "./client.ts"
import { createRun, deleteRun, saveSynthesis, type CandidateSeed } from "./repository.ts"
import { createShare, listShares, listSharesForRun, resolveShare, revokeShare } from "./shares.ts"
import { ensureTenant } from "./tenancy.ts"

/**
 * Share links, against the real database.
 *
 * The two properties worth proving here cannot be proved against a mock:
 *
 *   - **resolution is a capability check, not a tenant check** — it is the one
 *     function in this layer that resolves a tenant *from* its input, and it
 *     has to refuse revoked and expired links on the very next request, with no
 *     cache to wait out;
 *   - **the public projection leaks nothing** — the test asserts on what is
 *     *absent* from the served object, because a projection built by naming
 *     fields only stays safe if somebody checks that the naming is complete.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
]

let tenantId = ""
let otherTenantId = ""
let runId = ""
const runIds: string[] = []

async function shareableRun(prompt = "why is the sky blue?"): Promise<string> {
  const run = await createRun({ tenantId, prompt, candidates: SEEDS })
  runIds.push(run.id)
  await saveSynthesis(tenantId, run.id, {
    model: "claude-opus-5",
    finalAnswer: "Rayleigh scattering.",
    agreements: ["Shorter wavelengths scatter more."],
    disagreements: ["Whether violet matters."],
    reviews: [],
    confidence: 0.91,
    latencyMs: 1200,
    inputTokens: 900,
    outputTokens: 120,
  })
  return run.id
}

beforeAll(async () => {
  tenantId = (await ensureTenant("test-shares", "Shares Test")).id
  otherTenantId = (await ensureTenant("test-shares-other", "Other")).id
  runId = await shareableRun()
})

afterAll(async () => {
  for (const id of runIds) await deleteRun(tenantId, id).catch(() => {})
  await prisma.runShare.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
})

describe("creating links", () => {
  test("a share is minted for a run in the caller's tenant", async () => {
    const share = await createShare({
      tenantId,
      runId,
      createdByUserId: null,
      label: "for the review",
    })

    expect(share).not.toBeNull()
    expect(share?.runId).toBe(runId)
    expect(share?.label).toBe("for the review")
    expect(share?.viewCount).toBe(0)
    expect(share?.revokedAt).toBeNull()
  })

  test("a share cannot be minted for another tenant's run", async () => {
    // The run is re-read under the tenant filter rather than trusted from the
    // caller, so this is impossible even if a route forgets to check.
    const share = await createShare({
      tenantId: otherTenantId,
      runId,
      createdByUserId: null,
    })
    expect(share).toBeNull()
  })

  test("expiry is stored as an absolute instant", async () => {
    const share = await createShare({
      tenantId,
      runId,
      createdByUserId: null,
      expiresInDays: 7,
    })
    expect(share?.expiresAt).not.toBeNull()

    const days = (new Date(share?.expiresAt ?? 0).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
  })
})

describe("resolving links", () => {
  test("a live link serves the run", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    const resolved = await resolveShare(share?.token ?? "")

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.run.prompt).toBe("why is the sky blue?")
    expect(resolved.run.finalAnswer).toBe("Rayleigh scattering.")
    expect(resolved.run.sharedBy).toBe("Shares Test")
  })

  test("the projection carries nothing that identifies the workspace or the spend", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    const resolved = await resolveShare(share?.token ?? "")
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    // Asserted on the serialized object, so a field added to `Run` and
    // accidentally spread into the projection would fail here rather than
    // shipping. The panel survives by name; the drafts do not.
    const keys = Object.keys(resolved.run).sort()
    expect(keys).toEqual([
      "agreements",
      "completedAt",
      "confidence",
      "createdAt",
      "disagreements",
      "finalAnswer",
      "panel",
      "prompt",
      "sharedBy",
      "status",
    ])

    const blob = JSON.stringify(resolved.run)
    expect(blob).not.toContain(tenantId)
    expect(blob).not.toContain(runId)
    for (const member of resolved.run.panel) {
      expect(Object.keys(member).sort()).toEqual(["label", "model", "provider", "status"])
    }
  })

  test("a revoked link stops working immediately", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    expect((await resolveShare(share?.token ?? "")).ok).toBe(true)

    // No cache to wait out: the row is read on every visit.
    await revokeShare(tenantId, share?.id ?? "")
    const after = await resolveShare(share?.token ?? "")
    expect(after.ok).toBe(false)
    if (after.ok) return
    expect(after.reason).toBe("revoked")
  })

  test("an expired link is refused", async () => {
    const share = await createShare({
      tenantId,
      runId,
      createdByUserId: null,
      expiresInDays: 1,
    })
    // Evaluated against a clock two days on, rather than by sleeping.
    const later = new Date(Date.now() + 2 * 86_400_000)
    const resolved = await resolveShare(share?.token ?? "", later)

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe("expired")
  })

  test("a run with no synthesis has nothing to publish", async () => {
    const bare = await createRun({ tenantId, prompt: "unfinished", candidates: SEEDS })
    runIds.push(bare.id)

    const share = await createShare({ tenantId, runId: bare.id, createdByUserId: null })
    const resolved = await resolveShare(share?.token ?? "")

    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe("unavailable")
  })

  test("a token that was never issued is not found", async () => {
    const resolved = await resolveShare(mintShareToken())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toBe("not-found")
  })

  test("a malformed token never reaches the database", async () => {
    for (const bad of ["", "nonsense", "sce_share_../../etc/passwd", "' OR 1=1--"]) {
      const resolved = await resolveShare(bad)
      expect(resolved.ok).toBe(false)
      if (resolved.ok) continue
      expect(resolved.reason).toBe("not-found")
    }
  })

  test("resolving counts a view", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    await resolveShare(share?.token ?? "")
    await resolveShare(share?.token ?? "")

    const listed = await listSharesForRun(tenantId, runId)
    const found = listed.find((entry) => entry.id === share?.id)
    expect(found?.viewCount).toBe(2)
    expect(found?.lastViewedAt).not.toBeNull()
  })
})

describe("listing and revoking", () => {
  test("listing is tenant-scoped", async () => {
    await createShare({ tenantId, runId, createdByUserId: null })
    const mine = await listShares({ tenantId })
    const theirs = await listShares({ tenantId: otherTenantId })

    expect(mine.length).toBeGreaterThan(0)
    expect(theirs).toHaveLength(0)
  })

  test("another tenant cannot revoke a link", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    expect(await revokeShare(otherTenantId, share?.id ?? "")).toBe(false)

    const resolved = await resolveShare(share?.token ?? "")
    expect(resolved.ok).toBe(true)
  })

  test("revoking twice is not an error, and reports that nothing changed", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null })
    expect(await revokeShare(tenantId, share?.id ?? "")).toBe(true)
    expect(await revokeShare(tenantId, share?.id ?? "")).toBe(false)
  })

  test("dead links stay listed so they can be explained", async () => {
    const share = await createShare({ tenantId, runId, createdByUserId: null, label: "dead" })
    await revokeShare(tenantId, share?.id ?? "")

    const listed = await listSharesForRun(tenantId, runId)
    const found = listed.find((entry) => entry.id === share?.id)
    expect(found).toBeDefined()
    expect(found === undefined ? true : shareIsLive(found)).toBe(false)
  })

  test("deleting a run takes its links with it", async () => {
    const doomed = await shareableRun("about to be deleted")
    const share = await createShare({ tenantId, runId: doomed, createdByUserId: null })

    await deleteRun(tenantId, doomed)

    const resolved = await resolveShare(share?.token ?? "")
    expect(resolved.ok).toBe(false)
  })
})
