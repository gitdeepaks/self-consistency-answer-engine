import { test as base, type Page } from "@playwright/test"

/**
 * Seeding, over the real API.
 *
 * Fixtures are created by calling the API with an API key rather than by
 * writing to the database directly. That costs a little setup time and buys the
 * thing that matters: the data a test reads was produced by the same code path
 * a user's data goes through, so a schema change that breaks the write is
 * caught here rather than in production.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"
const API_KEY = process.env.SCE_API_KEY ?? null

/** Is there a backend to seed against? Specs skip themselves when there is not. */
export const canSeed = API_KEY !== null

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (API_KEY === null) throw new Error("SCE_API_KEY is required to seed fixtures")
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
}

export interface SeededShare {
  runId: string
  token: string
  prompt: string
}

/**
 * A finished run, published as a public link.
 *
 * Waits for the run to actually complete rather than assuming it has: the panel
 * is real, so how long it takes depends on the providers, and a fixed sleep is
 * the single most common source of flake in a suite like this.
 */
export async function seedSharedRun(prompt: string): Promise<SeededShare> {
  const started = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ prompt }),
  })
  if (!started.ok) throw new Error(`Could not start a run: HTTP ${started.status}`)

  const body: unknown = await started.json()
  const runId = extractRunId(body)

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const response = await api(`/api/runs/${runId}`)
    const run: unknown = await response.json()
    if (hasSynthesis(run)) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  const shared = await api(`/api/runs/${runId}/shares`, {
    method: "POST",
    body: JSON.stringify({ label: "e2e" }),
  })
  if (!shared.ok) throw new Error(`Could not publish the run: HTTP ${shared.status}`)

  return { runId, token: extractToken(await shared.json()), prompt }
}

/* The API's responses are unknown here as everywhere else, so they are read
 * with narrowing guards rather than assertions — a test helper that casts is a
 * test helper that reports a shape mismatch as a null-pointer error. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function extractRunId(body: unknown): string {
  if (isRecord(body) && isRecord(body.run) && typeof body.run.id === "string") return body.run.id
  throw new Error("The API did not return a run id")
}

function extractToken(body: unknown): string {
  if (isRecord(body) && isRecord(body.share) && typeof body.share.token === "string") {
    return body.share.token
  }
  throw new Error("The API did not return a share token")
}

function hasSynthesis(body: unknown): boolean {
  return isRecord(body) && isRecord(body.run) && isRecord(body.run.synthesis)
}

/** Assert the page never scrolls sideways — the responsive rule that always slips. */
export async function expectNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
}

export const test = base
export { expect } from "@playwright/test"
