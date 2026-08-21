import { PROVIDER_LIST } from "@sce/shared"
import { app } from "./app.ts"
import { config } from "./env.ts"
import { resolveEvaluator, resolvePanel } from "./providers.ts"

export type { AppType } from "./app.ts"
export { app } from "./app.ts"

const panel = resolvePanel()
const evaluator = resolveEvaluator()

console.log("Self-Consistency Answer Engine")
for (const provider of panel) {
  const state = provider.model ? `ready via ${provider.route}` : "UNAVAILABLE"
  console.log(`  panel      ${provider.spec.label.padEnd(8)} ${provider.modelId.padEnd(22)} ${state}`)
}
console.log(
  `  evaluator  ${evaluator.spec.label.padEnd(8)} ${evaluator.modelId.padEnd(22)} ${
    evaluator.model ? `ready via ${evaluator.route}` : "UNAVAILABLE"
  }`,
)
if (!panel.some((p) => p.model)) {
  console.warn(
    `\n  No provider credentials found. Set one of ${PROVIDER_LIST.map((p) => p.apiKeyEnv).join(
      ", ",
    )} or AI_GATEWAY_API_KEY in .env\n`,
  )
}

export default {
  port: config.port,
  hostname: config.hostname,
  // The evaluator pass can legitimately run for minutes; do not let Bun's
  // default request timeout cut an SSE stream short.
  idleTimeout: 255,
  fetch: app.fetch,
}
