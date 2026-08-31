import {
  accessSchema,
  adminOverviewSchema,
  adminTenantSchema,
  apiKeyCreatedSchema,
  apiKeySummarySchema,
  credentialKindSchema,
  deadLetterSchema,
  feedbackSummarySchema,
  killSwitchSchema,
  memberRoleSchema,
  planIdSchema,
  planSchema,
  providerHealthSchema,
  runSchema,
  runShareSchema,
  runSummarySchema,
  scopeSchema,
  sharedRunSchema,
  subscriptionSchema,
  tenantMemberSchema,
  usageDailySchema,
  usageSummarySchema,
  workspaceSchema,
} from "@sce/shared"
import { z } from "zod"

/**
 * The response shapes this app parses.
 *
 * `hc<AppType>()` gives the compile-time contract: what the server *intends* to
 * send, derived from the route definitions themselves. That is a contract, not
 * a guarantee — the process on the other end may be a different build, a proxy
 * may have replaced the body with an error page, and a CDN may have served a
 * cached 200 containing HTML. So every response is additionally parsed against
 * the shared schema that defined it, exactly as the CLI does.
 *
 * The two halves are complementary and neither is redundant: the types stop a
 * typo at compile time, and the parse stops a lie at runtime.
 */

export const errorEnvelopeSchema = z.object({ error: z.string() })

export const runEnvelope = z.object({ run: runSchema })
export const cancelEnvelope = z.object({ run: runSchema, canceled: z.boolean() })
export const okEnvelope = z.object({ ok: z.boolean() })

export const historyEnvelope = z.object({
  items: z.array(runSummarySchema),
  nextCursor: z.string().nullable(),
})

export const providersEnvelope = z.object({
  panel: z.array(providerHealthSchema),
  evaluator: providerHealthSchema,
})

export const tagsEnvelope = z.object({
  tags: z.array(z.object({ tag: z.string(), count: z.number().int().nonnegative() })),
})

export const runTagsEnvelope = z.object({ tags: z.array(z.string()) })

export const usageEnvelope = usageSummarySchema
export const usageDailyEnvelope = usageDailySchema

/**
 * `GET /api/billing`.
 *
 * Declared with the shared subscription and access schemas rather than
 * re-described here, so the pricing page cannot advertise a limit the API does
 * not apply — the plan catalogue in the response is the same `PLANS` record the
 * API enforces against.
 */
export const billingEnvelope = z.object({
  plan: planIdSchema,
  subscription: subscriptionSchema,
  access: accessSchema,
  plans: z.array(planSchema),
})

export const keysEnvelope = z.object({ keys: z.array(apiKeySummarySchema) })
export const keyCreatedEnvelope = apiKeyCreatedSchema

export const membersEnvelope = z.object({ members: z.array(tenantMemberSchema) })
export const workspacesEnvelope = z.object({
  workspaces: z.array(workspaceSchema),
  reason: z.literal("credential-bound-to-one-workspace").nullable(),
})

export const sharesEnvelope = z.object({ shares: z.array(runShareSchema) })
export const shareEnvelope = z.object({ share: runShareSchema })
export const sharedRunEnvelope = z.object({ run: sharedRunSchema })

export const feedbackEnvelope = z.object({ feedback: feedbackSummarySchema })

export const whoamiEnvelope = z.object({
  credential: credentialKindSchema,
  tenantId: z.string(),
  userId: z.string().nullable(),
  role: memberRoleSchema,
  scopes: z.array(scopeSchema),
})

/* --------------------------------------------------------------- operator */

export const adminWhoamiEnvelope = z.object({
  userId: z.string().nullable(),
  tenantId: z.string(),
  /** How many operators this install has. Never their addresses. */
  operatorCount: z.number().int().nonnegative(),
})

export const adminOverviewEnvelope = adminOverviewSchema
export const adminTenantsEnvelope = z.object({
  tenants: z.array(adminTenantSchema),
  window: z.object({ from: z.string(), to: z.string() }),
})
export const adminRunEnvelope = z.object({
  run: runSchema,
  tenant: z.object({ id: z.string(), slug: z.string() }),
  costMicroCents: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
})
export const adminDlqEnvelope = z.object({ deadLetters: z.array(deadLetterSchema) })
export const adminReplayEnvelope = z.object({ ok: z.boolean(), replayed: z.boolean() })
export const adminBudgetEnvelope = z.object({
  killSwitch: killSwitchSchema,
  budget: adminOverviewSchema.shape.budget,
})
