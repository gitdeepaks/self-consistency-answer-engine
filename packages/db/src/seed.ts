/**
 * Seed a local database: the price registry, a demo tenant with an owner, and a
 * handful of runs in different states.
 *
 * Idempotent — safe to run against an existing local database. It refuses to
 * run against anything that does not look local unless SCE_SEED_FORCE=1, since
 * seeding a shared database with fake runs is a bad afternoon.
 */
import { MODEL_PRICES, PROVIDERS, type CandidateReview } from "@sce/shared"
import { disconnect, prisma } from "./client.ts"
import {
  completeRun,
  createRun,
  failRun,
  saveSynthesis,
  settleCandidate,
  upsertModelPrice,
  type CandidateSeed,
} from "./repository.ts"
import { ensureUnmeteredPlan } from "./billing.ts"
import { defaultTenant, ensureMembership, ensureUser } from "./tenancy.ts"
import { redactDatabaseUrl, resolveDatabaseUrl } from "./url.ts"

const DEMO_PROMPTS = [
  "Explain the CAP theorem and when each trade-off is the right one.",
  "What are the practical differences between SSE and WebSockets?",
  "Summarise the tradeoffs between optimistic and pessimistic locking.",
]

function assertLocal(): void {
  if (process.env.SCE_SEED_FORCE === "1") return
  const host = new URL(resolveDatabaseUrl()).hostname
  if (host === "localhost" || host === "127.0.0.1" || host === "postgres") return
  throw new Error(
    `Refusing to seed a non-local database (${redactDatabaseUrl()}).\n` +
      "Set SCE_SEED_FORCE=1 if you really mean it.",
  )
}

async function seedPrices(): Promise<number> {
  for (const price of MODEL_PRICES) {
    await upsertModelPrice({ ...price, effectiveFrom: new Date(price.effectiveFrom) })
  }
  return MODEL_PRICES.length
}

function seeds(): CandidateSeed[] {
  return Object.values(PROVIDERS).map((spec) => ({
    provider: spec.id,
    label: spec.label,
    model: spec.defaultModel,
    status: "PENDING",
  }))
}

function reviews(): CandidateReview[] {
  return Object.values(PROVIDERS).map((spec, index) => ({
    provider: spec.id,
    score: 7 + index,
    strengths: [`${spec.label} covered the trade-offs concretely.`],
    weaknesses: [],
  }))
}

async function main(): Promise<void> {
  assertLocal()
  console.log(`seeding ${redactDatabaseUrl()}`)

  const priceCount = await seedPrices()
  console.log(`  prices:  ${priceCount}`)

  // The same tenant the API attributes unauthenticated requests to, so seeded
  // runs actually show up in the TUI's history.
  const tenant = await defaultTenant()
  const user = await ensureUser({ email: "demo@example.com", displayName: "Demo User" })
  await ensureMembership({ tenantId: tenant.id, userId: user.id, role: "owner" })

  // The install's own workspace is not a customer, so it is not metered against
  // a commercial plan. The global daily spend cap still applies to it, which is
  // the ceiling that actually matters for a local database.
  const subscription = await ensureUnmeteredPlan(tenant.id)
  console.log(`  tenant:  ${tenant.slug} (${tenant.id}) on the ${subscription.plan} plan`)

  const existing = await prisma.run.count({ where: { tenantId: tenant.id } })
  if (existing > 0) {
    console.log(`  runs:    ${existing} already present, skipping`)
    return
  }

  for (const [index, prompt] of DEMO_PROMPTS.entries()) {
    const run = await createRun({
      tenantId: tenant.id,
      createdByUserId: user.id,
      prompt,
      candidates: seeds(),
    })

    // The last demo run is left failed so error states have something to render.
    if (index === DEMO_PROMPTS.length - 1) {
      await failRun(tenant.id, run.id, "Every model in the panel failed — seeded failure state")
      continue
    }

    for (const candidate of run.candidates) {
      await settleCandidate(tenant.id, run.id, candidate.id, {
        status: "OK",
        content: `## ${candidate.label}\n\nA seeded answer to: ${prompt}`,
        latencyMs: 1200 + candidate.label.length * 10,
        inputTokens: 320,
        outputTokens: 480,
      })
    }

    await saveSynthesis(tenant.id, run.id, {
      model: "claude-opus-5",
      finalAnswer: `## Merged answer\n\nA seeded synthesis for: ${prompt}`,
      agreements: ["All three models framed the problem the same way."],
      disagreements: [],
      reviews: reviews(),
      confidence: 0.86,
      latencyMs: 3400,
      inputTokens: 1800,
      outputTokens: 700,
    })
    await completeRun(tenant.id, run.id, 5200)
  }

  console.log(`  runs:    ${DEMO_PROMPTS.length}`)
}

await main()
  .catch((error: unknown) => {
    console.error("[seed] failed", error)
    process.exitCode = 1
  })
  .finally(disconnect)
