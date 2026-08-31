import { zValidator } from "@hono/zod-validator"
import { feedbackFor, getRun, listFeedback, submitFeedback } from "@sce/db"
import { submitFeedbackInputSchema } from "@sce/shared"
import { Hono } from "hono"
import { actorOf, requirePermission, type AuthEnv } from "./auth/middleware.ts"

/**
 * Human verdicts on runs.
 *
 * The cheapest ground truth this product will ever collect, and Phase 7 reads
 * the table directly — so the design goal here is *submission rate*, not
 * ceremony. One click is a complete submission; a reason and a note are invited
 * and never required.
 *
 * Two policy decisions are enforced at this layer rather than in the database:
 *
 * **Feedback needs a person.** The unique key is `[runId, userId]`, and a
 * credential with no user behind it — a CI key — has nothing to key on. Rather
 * than inventing a synthetic id, such a caller is refused: an unattributable
 * verdict is noise in a dataset whose entire value is that a human produced it.
 *
 * **Reading a run is enough to judge it.** Gated on `run.read`, not on
 * ownership: a colleague spotting that an answer is wrong is exactly the signal
 * worth having, and restricting the button to the person who asked would
 * discard most of it.
 */

const feedback = new Hono<AuthEnv>()

  .get("/", requirePermission("run.read"), async (c) => {
    const actor = actorOf(c)
    const runId = c.req.param("id") ?? ""

    // Loaded under the tenant filter first, so a run in another workspace is a
    // 404 rather than an empty tally that would confirm the id is unknown here.
    const run = await getRun(actor.tenantId, runId)
    if (!run) return c.json({ error: "Run not found" }, 404)

    return c.json({
      feedback: await feedbackFor({ tenantId: actor.tenantId, runId, userId: actor.userId }),
    })
  })

  .post(
    "/",
    requirePermission("run.read"),
    zValidator("json", submitFeedbackInputSchema),
    async (c) => {
      const actor = actorOf(c)
      const runId = c.req.param("id") ?? ""

      if (actor.userId === null) {
        return c.json(
          {
            error: "Feedback has to come from a person — this credential has no user attached",
            code: "forbidden" as const,
          },
          403,
        )
      }

      const submitted = await submitFeedback({
        tenantId: actor.tenantId,
        runId,
        userId: actor.userId,
        ...c.req.valid("json"),
      })
      if (submitted === null) return c.json({ error: "Run not found" }, 404)

      return c.json({
        feedback: await feedbackFor({ tenantId: actor.tenantId, runId, userId: actor.userId }),
      })
    },
  )

/**
 * The triage queue: every thumbs-down in the workspace, newest first.
 *
 * Mounted separately from the per-run routes because it is a different
 * question — "what did we get wrong lately" rather than "what did people think
 * of this one" — and because it is the endpoint Phase 7's eval harness will
 * pull from.
 */
const feedbackQueue = new Hono<AuthEnv>().get("/", requirePermission("run.read"), async (c) =>
  c.json({ entries: await listFeedback({ tenantId: actorOf(c).tenantId }) }),
)

export { feedback, feedbackQueue }
