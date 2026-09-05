/**
 * The domain contract, vendored into the published package.
 *
 * `@sce/shared` is a private workspace package, so it cannot be a dependency of
 * something published to a registry. Re-exporting it through one relative-path
 * module means the schemas the server validates *with* are the schemas this SDK
 * parses *against* — one definition, no code generation step, and no chance of
 * the two disagreeing after a change to either.
 *
 * The modules below are named individually rather than pulled from the package
 * barrel, and that is deliberate: the barrel also exports the `.env` reader and
 * the API-key hasher, which import `node:fs` and `node:crypto`. One Node-only
 * import at the top of a bundled module poisons the browser build for every
 * pure export beside it, so the SDK's dependency surface is chosen here rather
 * than inherited.
 *
 * Everything in this closure uses Web Crypto and nothing else, which is what
 * makes one bundle work in Node, Bun, Deno, Cloudflare Workers and a browser.
 */

export * from "../../../shared/src/api-error.ts"
export * from "../../../shared/src/assert.ts"
export * from "../../../shared/src/billing.ts"
export * from "../../../shared/src/budget.ts"
export * from "../../../shared/src/events.ts"
export * from "../../../shared/src/idempotency.ts"
export * from "../../../shared/src/models.ts"
export * from "../../../shared/src/plans.ts"
export * from "../../../shared/src/pricing.ts"
export * from "../../../shared/src/quota.ts"
export * from "../../../shared/src/ratelimit.ts"
export * from "../../../shared/src/schemas.ts"
export * from "../../../shared/src/search.ts"
export * from "../../../shared/src/share.ts"
export * from "../../../shared/src/sse.ts"
export * from "../../../shared/src/usage.ts"
export * from "../../../shared/src/v1.ts"
export * from "../../../shared/src/webhook.ts"
