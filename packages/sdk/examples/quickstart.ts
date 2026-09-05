/**
 * The five-minute path: key in, streamed answer out.
 *
 *     SCE_API_KEY=sce_live_… SCE_BASE_URL=http://localhost:8787 \
 *       bun run packages/sdk/examples/quickstart.ts "Why is the sky blue?"
 *
 * Everything here is deliberately unabbreviated. It is the file somebody copies
 * into their own project as a starting point, so it shows the whole shape of an
 * integration — reading configuration, checking the panel, streaming, handling
 * a refusal — rather than the shortest thing that produces output.
 */

import { Sce, isSceApiError } from "../src/index.ts"

const apiKey = process.env["SCE_API_KEY"]
const baseUrl = process.env["SCE_BASE_URL"] ?? "http://localhost:8787"

if (apiKey === undefined || apiKey === "") {
  console.error(
    "Set SCE_API_KEY. Create a key in the web app under Settings → API keys, or run\n" +
      "  bun run auth:bootstrap\n" +
      "against a local install.",
  )
  process.exit(1)
}

const sce = new Sce({
  apiKey,
  // Accepted with or without the `/v1` suffix.
  baseUrl,
  appName: "quickstart",
  // Called on every response, not only on a 429 — which is what makes it useful
  // for pacing a batch rather than merely reacting to being throttled.
  onRateLimit: (state) => {
    if (state.remaining <= 2) {
      console.warn(`\n[rate limit] ${state.remaining}/${state.limit} left until ${state.resetAt}`)
    }
  },
})

const prompt = process.argv[2] ?? "Explain the CAP theorem to a senior engineer in five sentences."

/*
 * Which models are actually reachable from this deployment.
 *
 * Worth one request before spending money: a provider without a configured key
 * is seeded as a SKIPPED candidate rather than silently dropped, so a panel of
 * three can quietly become a panel of one.
 */
const { panel, evaluator } = await sce.providers()
console.log("panel:", panel.map((p) => `${p.label}${p.available ? "" : " (unavailable)"}`).join(", "))
console.log("evaluator:", evaluator.label)
console.log()

/*
 * Aborting stops the stream *and* cancels the run, so Ctrl-C stops the spend
 * rather than merely stopping the watching.
 */
const controller = new AbortController()
process.on("SIGINT", () => {
  console.log("\ncancelling…")
  controller.abort()
})

try {
  const run = await sce.ask(prompt, {
    signal: controller.signal,
    onRunCreated: (runId) => {
      console.log(`run ${runId}`)
    },
    onEvent: (event) => {
      if (event.type === "candidate.settled") {
        console.log(`  ${event.candidate.label.padEnd(10)} ${event.candidate.status}`)
      }
      if (event.type === "synthesis.started") console.log("\nsynthesising…\n")
    },
  })

  const synthesis = run.synthesis
  if (synthesis === null) {
    console.error(`Run ${run.status}: ${run.error ?? "no answer was produced"}`)
    process.exit(1)
  }

  console.log(synthesis.finalAnswer)
  console.log(`\nconfidence ${(synthesis.confidence * 100).toFixed(0)}%`)

  if (synthesis.agreements.length > 0) {
    console.log("\nthe panel agreed on:")
    for (const point of synthesis.agreements) console.log(`  · ${point}`)
  }
  if (synthesis.disagreements.length > 0) {
    console.log("\nthe panel disagreed on:")
    for (const point of synthesis.disagreements) console.log(`  · ${point}`)
  }
} catch (error: unknown) {
  /*
   * Branch on `code`, never on the status. A 429 is both "you are out of
   * monthly runs" and "you are sending too many requests a minute", and the
   * right response to each is different.
   */
  if (isSceApiError(error)) {
    console.error(`\n${error.code}: ${error.message}`)
    if (error.details?.quota !== undefined) {
      const { limit, used, ceiling, resetAt } = error.details.quota
      console.error(`  ${limit}: ${used}/${ceiling}, resets ${resetAt}`)
    }
    console.error(`  request ${error.requestId}`)
    process.exit(1)
  }
  throw error
}
