import { hasEntitlement } from "@sce/shared"
import type { Metadata } from "next"
import type { ReactElement } from "react"
import { KeysManager } from "@/components/settings/keys-manager"
import { ErrorState } from "@/components/ui/states"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "API keys" }

export default async function KeysPage(): Promise<ReactElement> {
  const api = serverApi()

  const [keys, billing] = await Promise.all([
    api.listKeys().catch(() => null),
    api.getBilling().catch(() => null),
  ])

  if (keys === null) {
    return (
      <ErrorState
        title="Could not load your keys"
        detail="The API did not answer, or this credential is not allowed to read them."
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">API keys</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Long-lived credentials for anything that cannot open a browser.
        </p>
      </div>

      <KeysManager
        initialKeys={keys}
        // The restrictive fallback again: a billing lookup that failed must not
        // unlock a paid capability. The API refuses it independently anyway.
        canCreate={billing !== null && hasEntitlement(billing.plan, "api.keys")}
      />
    </div>
  )
}
