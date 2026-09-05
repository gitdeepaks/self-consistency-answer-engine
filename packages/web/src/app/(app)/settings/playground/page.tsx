import type { Metadata } from "next"
import Link from "next/link"
import type { ReactElement } from "react"
import { Playground } from "@/components/settings/playground"
import { config } from "@/env"

export const metadata: Metadata = { title: "API playground" }

/**
 * The developer's first successful request.
 *
 * A client component doing all the work, because the whole page is interaction
 * — there is nothing to render on the server that would not immediately be
 * replaced.
 */
export default function PlaygroundPage(): ReactElement {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">API playground</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          The public API, from inside your session. Base URL{" "}
          <code className="font-mono text-xs text-ink">{config.apiUrl}/v1</code> ·{" "}
          <Link
            href={`${config.apiUrl}/v1/openapi.json`}
            className="text-accent underline underline-offset-2"
          >
            OpenAPI document
          </Link>
        </p>
      </div>

      <Playground />
    </div>
  )
}
