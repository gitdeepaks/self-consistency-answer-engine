import { shareIsLive, shareUrl } from "@sce/shared"
import { Share2 } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { config } from "@/env"
import { serverApi } from "@/lib/api/server"
import { when } from "@/lib/format"

export const metadata: Metadata = { title: "Shared" }

/**
 * Everything this workspace has published.
 *
 * The page exists because "what have we made public?" is a question somebody
 * eventually needs answered — usually in a hurry, usually with a lawyer in the
 * room — and answering it by opening every run in turn is not an answer. Dead
 * links are listed alongside live ones for the same reason: "we revoked that on
 * Tuesday" is more useful than the link having silently vanished.
 */
export default async function SharesPage(): Promise<ReactElement> {
  const shares = await serverApi()
    .listShares()
    .catch(() => null)

  if (shares === null) {
    return (
      <ErrorState
        title="Could not load your share links"
        detail="The API did not answer, or this credential is not allowed to read runs."
      />
    )
  }

  const live = shares.filter((share) => shareIsLive(share))
  const dead = shares.filter((share) => !shareIsLive(share))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Shared answers</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Every public link this workspace has ever created. Revoking one takes effect on the next
          request.
        </p>
      </div>

      {shares.length === 0 ? (
        <EmptyState
          icon={<Share2 className="size-8" aria-hidden="true" />}
          title="Nothing is published"
          description="Open a finished run and press Share to create a read-only link that anyone can open."
          action={
            <Link href="/runs">
              <Button variant="secondary">Browse your runs</Button>
            </Link>
          }
        />
      ) : (
        <>
          <Panel>
            <PanelHeader
              title="Live links"
              description="Readable right now by anyone who has the URL."
              actions={<Badge tone={live.length > 0 ? "success" : "neutral"}>{live.length}</Badge>}
            />
            <PanelBody className="p-0">
              {live.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink-faint">Nothing is live.</p>
              ) : (
                <ul className="divide-y divide-[--border]">
                  {live.map((share) => (
                    <li key={share.id} className="space-y-2 px-5 py-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Link
                          href={`/runs/${share.runId}`}
                          className="text-sm text-ink underline-offset-2 hover:underline"
                        >
                          {share.label ?? "Untitled link"}
                        </Link>
                        <span className="text-xs text-ink-faint">
                          {share.viewCount === 0
                            ? "not opened yet"
                            : `opened ${share.viewCount} time${share.viewCount === 1 ? "" : "s"}`}
                          {share.lastViewedAt !== null && ` · last ${when(share.lastViewedAt)}`}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-ink-muted">
                          {shareUrl(config.appUrl, share.token)}
                        </code>
                        <CopyButton value={shareUrl(config.appUrl, share.token)} size="sm" />
                      </div>

                      <p className="text-xs text-ink-faint">
                        Created {when(share.createdAt)}
                        {share.expiresAt === null
                          ? " · never expires"
                          : ` · expires ${when(share.expiresAt)}`}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>

          {dead.length > 0 && (
            <Panel>
              <PanelHeader
                title="No longer live"
                description="Revoked or expired. Kept so a dead link can be explained rather than simply vanishing."
              />
              <PanelBody className="p-0">
                <ul className="divide-y divide-[--border]">
                  {dead.map((share) => (
                    <li
                      key={share.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                    >
                      <Link
                        href={`/runs/${share.runId}`}
                        className="text-sm text-ink-muted underline-offset-2 hover:underline"
                      >
                        {share.label ?? "Untitled link"}
                      </Link>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-ink-faint">
                          {share.viewCount} view{share.viewCount === 1 ? "" : "s"}
                        </span>
                        <Badge tone="neutral">
                          {share.revokedAt !== null
                            ? `Revoked ${when(share.revokedAt)}`
                            : `Expired ${when(share.expiresAt ?? share.createdAt)}`}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              </PanelBody>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}
