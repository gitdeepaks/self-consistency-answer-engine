import {
  ALL_SCOPES,
  credentialsPath,
  loadRootEnv,
  maskApiKey,
  writeCredential,
  type Scope,
} from "@sce/shared"
import { createApiKey } from "./auth.ts"
import { ensureUnmeteredPlan } from "./billing.ts"
import { disconnect } from "./client.ts"
import { DEFAULT_TENANT_SLUG, ensureTenant } from "./tenancy.ts"

loadRootEnv()

/**
 * Mint the first credential for a fresh install.
 *
 * Phase 3 closes the API to anonymous callers, which leaves a chicken-and-egg
 * problem: the endpoint that creates keys needs a key. Every system with an API
 * solves this the same way — an out-of-band path that requires access to the
 * database rather than to the API — and this is ours.
 *
 * Deliberately *not* a dev-mode bypass in the auth middleware. A bypass would
 * mean production runs different authentication code from development, and the
 * one branch nobody exercises is the one that ships enabled. This script
 * produces a real key, verified by the real code path, and `bun run dev` is
 * then an ordinary authenticated client.
 *
 *   bun run auth:bootstrap                    # default workspace, all scopes
 *   bun run auth:bootstrap --tenant acme      # a named tenant
 *   bun run auth:bootstrap --print            # print only; do not save
 */

interface Options {
  tenantSlug: string
  name: string
  save: boolean
  serverUrl: string
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    tenantSlug: DEFAULT_TENANT_SLUG,
    name: "bootstrap",
    save: true,
    serverUrl: (process.env.SCE_SERVER_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]

    switch (flag) {
      case "--tenant":
        if (value === undefined) throw new Error("--tenant needs a slug")
        options.tenantSlug = value
        i++
        break
      case "--name":
        if (value === undefined) throw new Error("--name needs a label")
        options.name = value
        i++
        break
      case "--server":
        if (value === undefined) throw new Error("--server needs a URL")
        options.serverUrl = value.replace(/\/+$/, "")
        i++
        break
      case "--print":
        options.save = false
        break
      default:
        if (flag !== undefined && flag.startsWith("--")) {
          throw new Error(`Unknown flag ${flag}`)
        }
    }
  }

  return options
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  const tenant = await ensureTenant(options.tenantSlug, "Default workspace")

  // The workspace an install bootstraps for itself is not a customer, so it is
  // not held to a commercial plan's monthly ceilings. The global daily spend
  // cap still applies to it — that is the limit that protects the bill.
  await ensureUnmeteredPlan(tenant.id)

  // No creator: this key was minted by whoever holds the database credentials,
  // not by a user. `verifyApiKey` gives an ownerless key full authority inside
  // its tenant precisely because that access is already equivalent.
  const scopes: readonly Scope[] = ALL_SCOPES
  const { key, token } = await createApiKey({
    tenantId: tenant.id,
    createdByUserId: null,
    name: options.name,
    scopes,
    expiresAt: null,
  })

  const lines = [
    "",
    `  Tenant   ${tenant.name} (${tenant.slug})`,
    `  Key      ${maskApiKey(key.prefix)}  ·  ${key.name}`,
    `  Scopes   ${scopes.join(", ")}`,
    "",
    "  This secret is shown once and cannot be recovered:",
    "",
    `    ${token}`,
    "",
  ]

  if (options.save) {
    writeCredential(options.serverUrl, { kind: "api-key", token, tenant: tenant.slug })
    lines.push(
      `  Saved to ${credentialsPath()} (0600) for ${options.serverUrl}.`,
      "  The CLI will use it automatically; `sce auth status` confirms.",
      "",
    )
  } else {
    lines.push("  Not saved. Export it yourself:", "", `    export SCE_API_KEY=${token}`, "")
  }

  console.log(lines.join("\n"))
}

await main()
  .catch((error: unknown) => {
    console.error("[bootstrap]", error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnect()
  })
