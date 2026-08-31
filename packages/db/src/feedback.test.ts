import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { prisma } from "./client.ts"
import { feedbackFor, listFeedback, submitFeedback } from "./feedback.ts"
import { createRun, deleteRun, type CandidateSeed } from "./repository.ts"
import { ensureMembership, ensureTenant, ensureUser } from "./tenancy.ts"

/**
 * Human verdicts, against the real database.
 *
 * The behaviour worth proving is the upsert. A person who changes their mind is
 * correcting a label, not adding a second one — and a table of contradictory
 * verdicts from the same reviewer is worse for Phase 7's eval set than having
 * no feedback at all. That guarantee is a unique constraint, which is exactly
 * the kind of thing a mocked client cannot demonstrate.
 */

const SEEDS: CandidateSeed[] = [
  { provider: "openai", label: "OpenAI", model: "gpt-5.5", status: "PENDING" },
]

let tenantId = ""
let otherTenantId = ""
let alice = ""
let bob = ""
let runId = ""
const runIds: string[] = []

async function newRun(prompt = "a feedback test"): Promise<string> {
  const run = await createRun({ tenantId, prompt, candidates: SEEDS })
  runIds.push(run.id)
  return run.id
}

beforeAll(async () => {
  tenantId = (await ensureTenant("test-feedback", "Feedback Test")).id
  otherTenantId = (await ensureTenant("test-feedback-other", "Other")).id

  alice = (await ensureUser({ email: "alice@feedback.test", displayName: "Alice" })).id
  bob = (await ensureUser({ email: "bob@feedback.test", displayName: "Bob" })).id
  await ensureMembership({ tenantId, userId: alice, role: "owner" })
  await ensureMembership({ tenantId, userId: bob, role: "member" })

  runId = await newRun()
})

afterAll(async () => {
  await prisma.runFeedback.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
  for (const id of runIds) await deleteRun(tenantId, id).catch(() => {})
  await prisma.membership.deleteMany({ where: { userId: { in: [alice, bob] } } })
  await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } })
})

describe("submitting", () => {
  test("a rating alone is a complete submission", async () => {
    // One click has to be enough. A form that demands an explanation before it
    // accepts a thumbs-down collects far fewer thumbs-downs.
    const feedback = await submitFeedback({ tenantId, runId, userId: alice, rating: "up" })

    expect(feedback?.rating).toBe("up")
    expect(feedback?.reason).toBeNull()
    expect(feedback?.note).toBeNull()
  })

  test("changing your mind corrects the label rather than adding a second one", async () => {
    const target = await newRun("mind-changing")

    await submitFeedback({ tenantId, runId: target, userId: alice, rating: "up" })
    await submitFeedback({
      tenantId,
      runId: target,
      userId: alice,
      rating: "down",
      reason: "incorrect",
      note: "It confused two APIs with the same name.",
    })

    const summary = await feedbackFor({ tenantId, runId: target, userId: alice })
    expect(summary.up).toBe(0)
    expect(summary.down).toBe(1)
    expect(summary.mine?.reason).toBe("incorrect")
  })

  test("a later rating clears the reason it no longer explains", async () => {
    // A thumbs-up that kept "factually wrong" attached would read as the reason
    // for the approval.
    const target = await newRun("reason-clearing")

    await submitFeedback({
      tenantId,
      runId: target,
      userId: alice,
      rating: "down",
      reason: "incomplete",
      note: "Missed half the question.",
    })
    await submitFeedback({ tenantId, runId: target, userId: alice, rating: "up" })

    const summary = await feedbackFor({ tenantId, runId: target, userId: alice })
    expect(summary.mine?.rating).toBe("up")
    expect(summary.mine?.reason).toBeNull()
    expect(summary.mine?.note).toBeNull()
  })

  test("two people may each hold their own verdict", async () => {
    const target = await newRun("two-verdicts")

    await submitFeedback({ tenantId, runId: target, userId: alice, rating: "up" })
    await submitFeedback({ tenantId, runId: target, userId: bob, rating: "down" })

    const asAlice = await feedbackFor({ tenantId, runId: target, userId: alice })
    expect(asAlice.up).toBe(1)
    expect(asAlice.down).toBe(1)
    expect(asAlice.mine?.rating).toBe("up")

    const asBob = await feedbackFor({ tenantId, runId: target, userId: bob })
    expect(asBob.mine?.rating).toBe("down")
  })

  test("feedback cannot be attached to another tenant's run", async () => {
    // The unique key is `[runId, userId]` and would happily accept a foreign
    // run id, so the run is resolved under the tenant filter first.
    const result = await submitFeedback({
      tenantId: otherTenantId,
      runId,
      userId: alice,
      rating: "down",
    })
    expect(result).toBeNull()
  })

  test("a run that does not exist yields null rather than an orphan row", async () => {
    const result = await submitFeedback({
      tenantId,
      runId: "run_does_not_exist",
      userId: alice,
      rating: "up",
    })
    expect(result).toBeNull()
  })
})

describe("reading", () => {
  test("an anonymous reader sees the tally but no verdict of their own", async () => {
    const target = await newRun("anonymous-read")
    await submitFeedback({ tenantId, runId: target, userId: alice, rating: "up" })

    const summary = await feedbackFor({ tenantId, runId: target, userId: null })
    expect(summary.up).toBe(1)
    expect(summary.mine).toBeNull()
  })

  test("the triage queue holds the thumbs-down, newest first", async () => {
    const target = await newRun("triage-me")
    await submitFeedback({
      tenantId,
      runId: target,
      userId: bob,
      rating: "down",
      reason: "off_topic",
      note: "Answered a different question entirely.",
    })

    const queue = await listFeedback({ tenantId })
    const entry = queue.find((item) => item.feedback.runId === target)

    expect(entry).toBeDefined()
    expect(entry?.runPrompt).toBe("triage-me")
    expect(entry?.feedback.reason).toBe("off_topic")
    // Defaults to the negative set — the queue somebody actually works through.
    expect(queue.every((item) => item.feedback.rating === "down")).toBe(true)
  })

  test("the queue is tenant-scoped", async () => {
    expect(await listFeedback({ tenantId: otherTenantId })).toHaveLength(0)
  })

  test("deleting a run takes its feedback with it", async () => {
    const doomed = await newRun("about to go")
    await submitFeedback({ tenantId, runId: doomed, userId: alice, rating: "down" })

    await deleteRun(tenantId, doomed)

    const remaining = await prisma.runFeedback.count({ where: { runId: doomed } })
    expect(remaining).toBe(0)
  })
})
