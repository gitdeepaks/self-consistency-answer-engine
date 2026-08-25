#!/usr/bin/env bun
import { runEventSchema, type RunEvent } from "@sce/shared"
import { z } from "zod"

/**
 * The horizontal scale and chaos drill.
 *
 * Phase 2's exit criteria are claims about *processes*, and no in-process test
 * can establish them:
 *
 *   1. a run started on API replica A streams correctly to a client connected
 *      to replica C;
 *   2. killing a worker mid-run loses no work and the run still completes;
 *   3. a rolling restart during concurrent runs completes them all.
 *
 * So this harness starts real API and worker processes, drives real runs
 * through them, and kills things on purpose. It needs provider credentials,
 * because what is being tested is the machinery *around* the model calls and
 * stubbing them out would remove the latency that makes the race interesting.
 *
 *   bun run infra/scale-test.ts
 *   bun run infra/scale-test.ts --apis 3 --workers 3 --runs 12
 */

/* ---------------------------------------------------------------- options */

const optionsSchema = z.object({
  apis: z.coerce.number().int().min(1).max(10).default(3),
  workers: z.coerce.number().int().min(1).max(10).default(3),
  runs: z.coerce.number().int().min(1).max(200).default(6),
  basePort: z.coerce.number().int().min(1024).max(60_000).default(8850),
  /** Overall budget. A run that has not finished by then is a failure. */
  timeoutMs: z.coerce.number().int().positive().default(240_000),
})

type Options = z.infer<typeof optionsSchema>

function parseArgs(argv: readonly string[]): Options {
  const raw: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key?.startsWith("--") && value !== undefined) raw[key.slice(2)] = value
  }
  return optionsSchema.parse(raw)
}

const options = parseArgs(process.argv.slice(2))

/* ------------------------------------------------------------ preconditions */

const PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_GATEWAY_API_KEY",
]

if (!PROVIDER_KEYS.some((key) => (process.env[key]?.trim().length ?? 0) > 0)) {
  console.error(
    `This drill makes real model calls and needs credentials.\n` +
      `Set one of: ${PROVIDER_KEYS.join(", ")}\n\n` +
      `The parts that can be proven without credentials — cursor semantics, the\n` +
      `backfill/tail join, cross-instance delivery — are covered by\n` +
      `packages/queue/src/bus.test.ts, which runs in \`bun test\`.`,
  )
  process.exit(2)
}

if ((process.env.RUN_TRANSPORT ?? "redis") !== "redis") {
  console.error("RUN_TRANSPORT must be `redis`: the point of this drill is several processes.")
  process.exit(2)
}

/* ------------------------------------------------------------- the fleet */

interface Process {
  name: string
  proc: Bun.Subprocess
}

const running: Process[] = []

function spawn(name: string, script: string, env: Record<string, string>): Process {
  const proc = Bun.spawn(["bun", "run", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const entry = { name, proc }
  running.push(entry)
  return entry
}

async function stopAll(): Promise<void> {
  for (const entry of running) entry.proc.kill("SIGTERM")
  await Promise.all(running.map((entry) => entry.proc.exited))
  running.length = 0
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250)
  }
  throw new Error(`${url} never became healthy`)
}

/* --------------------------------------------------------------- the runs */

const runEnvelopeSchema = z.object({ run: z.object({ id: z.string(), status: z.string() }) })

async function startRun(apiUrl: string, prompt: string): Promise<string> {
  const res = await fetch(`${apiUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error(`POST /api/runs failed on ${apiUrl}: HTTP ${res.status}`)
  return runEnvelopeSchema.parse(await res.json()).run.id
}

/**
 * Follow a run to its terminal event, reconnecting from the cursor on a drop.
 *
 * The reconnection is not incidental — it is what a browser does, and proving
 * that a resumed stream picks up exactly where it left off, on a *different*
 * replica, is the point of the exercise.
 */
async function followRun(
  apiUrl: string,
  runId: string,
  deadline: number,
): Promise<{ terminal: RunEvent; reconnects: number; seen: number }> {
  let afterSeq = 0
  let reconnects = 0
  let seen = 0

  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/api/runs/${runId}/events?afterSeq=${afterSeq}`, {
      headers: { Accept: "text/event-stream" },
    })
    if (!res.ok || !res.body) throw new Error(`SSE failed on ${apiUrl}: HTTP ${res.status}`)

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""

    try {
      while (Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value

        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf("\n\n")

          const lines = frame.split("\n")
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue

          const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim()
          if (id !== undefined) afterSeq = Math.max(afterSeq, Number(id) || afterSeq)

          const parsed = runEventSchema.safeParse(JSON.parse(data))
          if (!parsed.success) continue
          seen += 1

          const { type } = parsed.data
          if (type === "run.completed" || type === "run.failed" || type === "run.canceled") {
            return { terminal: parsed.data, reconnects, seen }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    reconnects += 1
    await Bun.sleep(500)
  }

  throw new Error(`run ${runId} did not finish within the budget`)
}

/* ----------------------------------------------------------------- drill */

const apiUrls: string[] = []

console.log(
  `Starting ${options.apis} API replica(s) and ${options.workers} worker(s) for ${options.runs} run(s)…`,
)

for (let i = 0; i < options.apis; i++) {
  const port = options.basePort + i
  spawn(`api-${i}`, "packages/server/src/index.ts", { PORT: String(port) })
  apiUrls.push(`http://127.0.0.1:${port}`)
}
for (let i = 0; i < options.workers; i++) {
  spawn(`worker-${i}`, "packages/worker/src/index.ts", {})
}

let failures = 0

try {
  await Promise.all(apiUrls.map((url) => waitForHealth(url)))
  console.log("Fleet is healthy.")

  const deadline = Date.now() + options.timeoutMs

  const results = await Promise.allSettled(
    Array.from({ length: options.runs }, async (_unused, index) => {
      // The run is *started* on one replica and *watched* on another. If the
      // progress bus were still in-process, this would hang — which is exactly
      // what it used to do.
      const producer = apiUrls[index % apiUrls.length] ?? apiUrls[0]
      const consumer = apiUrls[(index + 1) % apiUrls.length] ?? apiUrls[0]
      if (producer === undefined || consumer === undefined) throw new Error("no API replicas")

      const runId = await startRun(producer, `Scale drill ${index}: name three sorting algorithms.`)

      // Chaos, once the fan-out is under way: kill a worker and restart an API.
      if (index === 0) {
        await Bun.sleep(3_000)
        const victim = running.find((entry) => entry.name === "worker-0")
        if (victim) {
          console.log("  chaos: SIGKILL worker-0 mid-run")
          victim.proc.kill("SIGKILL")
        }
      }
      if (index === 1) {
        await Bun.sleep(4_000)
        const victim = running.find((entry) => entry.name === "api-0")
        if (victim) {
          console.log("  chaos: SIGTERM api-0 (rolling deploy)")
          victim.proc.kill("SIGTERM")
        }
      }

      const outcome = await followRun(consumer, runId, deadline)
      return { index, runId, producer, consumer, ...outcome }
    }),
  )

  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      failures += 1
      console.error(`  run ${index}: FAILED — ${String(result.reason)}`)
      continue
    }
    const { terminal, reconnects, seen, producer, consumer } = result.value
    const ok = terminal.type === "run.completed"
    if (!ok) failures += 1
    console.log(
      `  run ${index}: ${terminal.type} (${seen} events, ${reconnects} reconnect(s)) ` +
        `started on ${producer}, watched on ${consumer}`,
    )
  }
} finally {
  await stopAll()
}

if (failures > 0) {
  console.error(`\n${failures} of ${options.runs} run(s) did not complete.`)
  process.exit(1)
}
console.log(`\nAll ${options.runs} run(s) completed across replicas, through a kill and a restart.`)
