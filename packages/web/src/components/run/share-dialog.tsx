"use client"

import { shareIsLive, shareUrl, type RunShare } from "@sce/shared"
import { Link2, Loader2, Trash2 } from "lucide-react"
import { useCallback, useEffect, useState, type ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Dialog } from "@/components/ui/dialog"
import { Field, Select, TextInput } from "@/components/ui/field"
import { ErrorState } from "@/components/ui/states"
import { config } from "@/env"
import { useApi } from "@/lib/api/browser"
import { when } from "@/lib/format"

/**
 * Publishing a run.
 *
 * The dialog is deliberately blunt about what publishing means, because this is
 * the one action in the app that takes something private and makes it readable
 * by anyone with a URL. Two things follow from that:
 *
 *   - the consequence is stated in words next to the button, not buried in a
 *     tooltip, and
 *   - expiry is offered *first*, with a sensible default, because a link that
 *     expires is the safer choice and the one most people want once it is put
 *     in front of them. "Never" remains available and is labelled as such.
 *
 * Existing links are listed with their state — live, expired, revoked — so
 * "what have I shared?" is answerable from the same place as "share this".
 */

const EXPIRY_CHOICES: readonly { value: string; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never expires" },
]

export function ShareDialog({
  runId,
  open,
  onClose,
  canShare,
}: {
  runId: string
  open: boolean
  onClose: () => void
  /** False when the run has no synthesised answer yet, so there is nothing to publish. */
  canShare: boolean
}): ReactElement {
  const api = useApi()
  const [shares, setShares] = useState<readonly RunShare[] | null>(null)
  const [label, setLabel] = useState("")
  const [expiry, setExpiry] = useState("30")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setShares(await api.listRunShares(runId))
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not load share links")
    }
  }, [api, runId])

  // Loaded when the dialog opens rather than on mount: a run page that nobody
  // shares should not pay for this request at all.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const share = await api.createShare(runId, {
        ...(label.trim().length > 0 ? { label: label.trim() } : {}),
        ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
      })
      setShares((current) => [share, ...(current ?? [])])
      setLabel("")
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not create the link")
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (shareId: string): Promise<void> => {
    setError(null)
    // Optimistic, because revocation is the action people want to feel
    // instantaneous — and it is reconciled from the server on the next open.
    setShares((current) =>
      (current ?? []).map((share) =>
        share.id === shareId ? { ...share, revokedAt: new Date().toISOString() } : share,
      ),
    )
    try {
      await api.revokeShare(shareId)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the link")
      await load()
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share this answer"
      description="A link anyone can open, with no account and no sign-in."
    >
      <div className="space-y-5">
        {!canShare ? (
          <p className="text-sm text-ink-muted">
            This run has no synthesised answer yet, so there is nothing to publish. Come back once
            it has finished.
          </p>
        ) : (
          <>
            <div className="rounded-lg border border-line bg-surface-sunken p-3 text-xs text-ink-muted">
              A shared page shows the question, the final answer, the agreements and disagreements,
              and which models were on the panel. It does <strong className="text-ink">not</strong>{" "}
              show who asked, the individual drafts, or what the run cost.
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Label (optional)" hint="So you can tell your links apart later.">
                {({ controlId }) => (
                  <TextInput
                    id={controlId}
                    value={label}
                    maxLength={80}
                    placeholder="For the design review"
                    onChange={(event) => {
                      setLabel(event.target.value)
                    }}
                  />
                )}
              </Field>

              <Field label="Expires">
                {({ controlId }) => (
                  <Select
                    id={controlId}
                    value={expiry}
                    onChange={(event) => {
                      setExpiry(event.target.value)
                    }}
                  >
                    {EXPIRY_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <Button onClick={() => void create()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              Create a link
            </Button>
          </>
        )}

        {error !== null && <ErrorState detail={error} />}

        {shares !== null && shares.length > 0 && (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-xs font-medium text-ink-muted">Links for this run</p>
            {shares.map((share) => {
              const live = shareIsLive(share)
              const url = shareUrl(config.appUrl, share.token)
              return (
                <div key={share.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-ink">{share.label ?? "Untitled link"}</span>
                    <Badge tone={live ? "success" : "neutral"}>
                      {share.revokedAt !== null
                        ? "Revoked"
                        : live
                          ? "Live"
                          : "Expired"}
                    </Badge>
                  </div>

                  {live && (
                    <div className="mt-2 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-ink-muted">
                        {url}
                      </code>
                      <CopyButton value={url} size="sm" label="Copy" />
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-faint">
                    <span>
                      Created {when(share.createdAt)}
                      {share.expiresAt !== null && ` · expires ${when(share.expiresAt)}`}
                      {" · "}
                      {share.viewCount === 0
                        ? "not opened yet"
                        : `opened ${share.viewCount} time${share.viewCount === 1 ? "" : "s"}`}
                    </span>
                    {share.revokedAt === null && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void revoke(share.id)}
                        className="text-danger hover:text-danger"
                      >
                        <Trash2 aria-hidden="true" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Dialog>
  )
}
