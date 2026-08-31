"use client"

import {
  ALL_SCOPES,
  DEFAULT_SCOPES,
  maskApiKey,
  scopeSchema,
  type ApiKeySummary,
  type Scope,
} from "@sce/shared"
import { KeyRound, Loader2, Plus, ShieldOff } from "lucide-react"
import { useState, type ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { Dialog } from "@/components/ui/dialog"
import { Field, Select, TextInput } from "@/components/ui/field"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { useApi } from "@/lib/api/browser"
import { when } from "@/lib/format"

/**
 * API keys.
 *
 * The rule that shapes every part of this component: **the secret exists once**,
 * in the response to the request that created it, and is unrecoverable
 * afterwards. So the reveal is a modal that has to be dismissed deliberately,
 * the copy button is the most prominent thing in it, and the warning is stated
 * before the value rather than under it.
 *
 * Scopes default to the narrow set rather than everything. A key minted with
 * every scope because that was the path of least resistance is the credential
 * that turns a leaked CI token into a full account takeover — and the API
 * intersects whatever is requested with what the *caller* holds, so asking for
 * more than you have quietly gets you less rather than an error.
 */

const EXPIRY_CHOICES: readonly { value: string; label: string }[] = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "One year" },
  { value: "never", label: "Never expires" },
]

export function KeysManager({
  initialKeys,
  canCreate,
}: {
  initialKeys: readonly ApiKeySummary[]
  /** False when the plan does not include API keys. */
  canCreate: boolean
}): ReactElement {
  const api = useApi()
  const [keys, setKeys] = useState<readonly ApiKeySummary[]>(initialKeys)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<{ token: string; key: ApiKeySummary } | null>(null)

  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<readonly Scope[]>(DEFAULT_SCOPES)
  const [expiry, setExpiry] = useState("90")

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await api.createKey({
        name: name.trim(),
        scopes: [...scopes],
        ...(expiry === "never" ? {} : { expiresInDays: Number(expiry) }),
      })
      setKeys((current) => [created.key, ...current])
      setCreating(false)
      setName("")
      setScopes(DEFAULT_SCOPES)
      setRevealed({ token: created.token, key: created.key })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not create the key")
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string): Promise<void> => {
    setError(null)
    const now = new Date().toISOString()
    setKeys((current) =>
      current.map((key) => (key.id === id ? { ...key, revokedAt: now } : key)),
    )
    try {
      await api.revokeKey(id)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not revoke the key")
      setKeys(await api.listKeys().catch(() => keys))
    }
  }

  return (
    <div className="space-y-4">
      {error !== null && <ErrorState detail={error} />}

      <Panel>
        <PanelHeader
          title="API keys"
          description="For CI, the SDK and anything that cannot open a browser. A person at a terminal uses `sce auth login` instead."
          actions={
            <Button
              size="sm"
              disabled={!canCreate}
              title={canCreate ? undefined : "API keys are part of the Pro plan and above"}
              onClick={() => {
                setCreating(true)
              }}
            >
              <Plus aria-hidden="true" />
              New key
            </Button>
          }
        />
        <PanelBody className="p-0">
          {keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="size-8" aria-hidden="true" />}
              title="No keys yet"
              description={
                canCreate
                  ? "Create one when you need to call the API from CI or a script."
                  : "API keys are part of the Pro plan and above."
              }
            />
          ) : (
            <ul className="divide-y divide-[--border]">
              {keys.map((key) => {
                const dead =
                  key.revokedAt !== null ||
                  (key.expiresAt !== null && new Date(key.expiresAt).getTime() <= Date.now())
                return (
                  <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm text-ink">
                        {key.name}
                        {dead && (
                          <Badge tone="neutral">
                            {key.revokedAt !== null ? "Revoked" : "Expired"}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                        {maskApiKey(key.prefix)}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} tone="neutral" className="px-1.5 py-0 text-[0.65rem]">
                            {scope}
                          </Badge>
                        ))}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-xs text-ink-faint">
                        Created {when(key.createdAt)}
                        {key.lastUsedAt !== null && ` · last used ${when(key.lastUsedAt)}`}
                        {key.lastUsedAt === null && " · never used"}
                      </span>
                      {!dead && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger hover:text-danger"
                          onClick={() => void revoke(key.id)}
                        >
                          <ShieldOff aria-hidden="true" />
                          Revoke
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </PanelBody>
      </Panel>

      <Dialog
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
        title="Create an API key"
        description="You will see the secret once. Store it before closing the next screen."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setCreating(false)
              }}
            >
              Cancel
            </Button>
            <Button disabled={busy || name.trim().length === 0 || scopes.length === 0} onClick={() => void create()}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" hint="A key nobody can identify is a key nobody dares revoke.">
            {({ controlId }) => (
              <TextInput
                id={controlId}
                value={name}
                maxLength={80}
                placeholder="CI — nightly evals"
                onChange={(event) => {
                  setName(event.target.value)
                }}
              />
            )}
          </Field>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">Scopes</legend>
            <p className="text-xs text-ink-muted">
              Narrower is better. A key cannot be granted more than your own credential holds — the
              API intersects the two.
            </p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {ALL_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => {
                      const parsed = scopeSchema.safeParse(scope)
                      if (!parsed.success) return
                      setScopes((current) =>
                        current.includes(parsed.data)
                          ? current.filter((entry) => entry !== parsed.data)
                          : [...current, parsed.data],
                      )
                    }}
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className="font-mono text-xs">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>

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
      </Dialog>

      <Dialog
        open={revealed !== null}
        onClose={() => {
          setRevealed(null)
        }}
        title="Copy this key now"
        description="This is the only time it will ever be shown. It is stored as a hash, so it cannot be recovered."
        footer={
          <Button
            onClick={() => {
              setRevealed(null)
            }}
          >
            I have stored it
          </Button>
        }
      >
        {revealed !== null && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface-sunken p-3 font-mono text-xs text-ink">
                {revealed.token}
              </code>
            </div>
            <CopyButton
              value={revealed.token}
              variant="primary"
              size="md"
              label="Copy the key"
              copiedLabel="Copied — store it somewhere safe"
            />
            <p className="text-xs text-ink-muted">
              Set it as <code className="font-mono">SCE_API_KEY</code> in your CI environment.
              Revoking it here stops it working on the very next request — there is no cache to
              wait out.
            </p>
          </div>
        )}
      </Dialog>
    </div>
  )
}
