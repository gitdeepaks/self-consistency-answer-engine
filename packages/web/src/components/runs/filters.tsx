"use client"

import {
  IN_FLIGHT_STATUSES,
  PROVIDER_IDS,
  runSearchToParams,
  type ProviderId,
  type RunSearchQuery,
  type RunStatus,
} from "@sce/shared"
import { Search, X } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useState, type FormEvent, type ReactElement, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Select, TextInput } from "@/components/ui/field"
import { cn } from "@/lib/cn"
import { providerColor, providerLabel } from "@/lib/format"

/**
 * History filters.
 *
 * **The URL is the state.** Every control writes to the query string and the
 * page reads it back, which buys three things a `useState` filter panel does
 * not: the back button undoes a filter, a filtered view can be sent to a
 * colleague, and a reload does not silently drop what somebody had narrowed
 * down to. The serializer is `runSearchToParams` from `@sce/shared` — the same
 * function the query schema parses — so a URL this component builds always
 * parses back to the query it came from.
 *
 * The free-text box is the one exception: it holds local state while somebody
 * types and commits on submit, because pushing a route on every keystroke would
 * put thirty entries in the history stack for one search.
 */

const STATUS_GROUPS: readonly { label: string; statuses: readonly RunStatus[] }[] = [
  { label: "In flight", statuses: IN_FLIGHT_STATUSES },
  { label: "Complete", statuses: ["COMPLETE"] },
  { label: "Failed", statuses: ["FAILED"] },
  { label: "Canceled", statuses: ["CANCELED"] },
]

export function RunFilters({
  query,
  tags,
}: {
  query: RunSearchQuery
  tags: readonly { tag: string; count: number }[]
}): ReactElement {
  const router = useRouter()
  const pathname = usePathname()
  const [text, setText] = useState(query.q ?? "")

  // Re-synced when the URL changes underneath — a back navigation has to put
  // the previous term back in the box, not leave the one that is no longer
  // applied.
  useEffect(() => {
    setText(query.q ?? "")
  }, [query.q])

  const navigate = (next: Partial<RunSearchQuery>): void => {
    const merged: Partial<RunSearchQuery> = { ...query, ...next }
    // Any change to the filters invalidates the page cursor: keeping it would
    // page into the middle of a result set the user has just redefined.
    delete merged.cursor
    const params = runSearchToParams(merged)
    const search = params.toString()
    router.push(search.length > 0 ? `${pathname}?${search}` : pathname)
  }

  const active = useMemo(
    () =>
      (query.q !== undefined ? 1 : 0) +
      (query.status?.length ?? 0) +
      (query.providers?.length ?? 0) +
      (query.tags?.length ?? 0) +
      (query.from !== undefined ? 1 : 0) +
      (query.to !== undefined ? 1 : 0) +
      (query.minConfidence !== undefined ? 1 : 0) +
      (query.mine === true ? 1 : 0),
    [query],
  )

  const toggleStatuses = (statuses: readonly RunStatus[]): void => {
    const current = query.status ?? []
    const allOn = statuses.every((status) => current.includes(status))
    const next = allOn
      ? current.filter((status) => !statuses.includes(status))
      : [...new Set([...current, ...statuses])]
    navigate({ status: next.length > 0 ? next : undefined })
  }

  const toggleProvider = (provider: ProviderId): void => {
    const current = query.providers ?? []
    const next = current.includes(provider)
      ? current.filter((entry) => entry !== provider)
      : [...current, provider]
    navigate({ providers: next.length > 0 ? next : undefined })
  }

  const toggleTag = (tag: string): void => {
    const current = query.tags ?? []
    const next = current.includes(tag)
      ? current.filter((entry) => entry !== tag)
      : [...current, tag]
    navigate({ tags: next.length > 0 ? next : undefined })
  }

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    navigate({ q: text.trim().length > 0 ? text.trim() : undefined })
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submitSearch} className="flex gap-2">
        <Field label="Search prompts and answers" labelHidden className="flex-1">
          {({ controlId }) => (
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                aria-hidden="true"
              />
              <TextInput
                id={controlId}
                type="search"
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                }}
                placeholder="Search your questions and the answers you got…"
                className="pl-9"
                maxLength={200}
              />
            </div>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <FilterGroup label="Status">
          {STATUS_GROUPS.map((group) => {
            const on = group.statuses.every((status) => (query.status ?? []).includes(status))
            return (
              <Chip
                key={group.label}
                active={on}
                onClick={() => {
                  toggleStatuses(group.statuses)
                }}
              >
                {group.label}
              </Chip>
            )
          })}
        </FilterGroup>

        <FilterGroup label="Model">
          {PROVIDER_IDS.map((provider) => (
            <Chip
              key={provider}
              active={(query.providers ?? []).includes(provider)}
              onClick={() => {
                toggleProvider(provider)
              }}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: providerColor(provider) }}
                aria-hidden="true"
              />
              {providerLabel(provider)}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Mine">
          <Chip
            active={query.mine === true}
            onClick={() => {
              navigate({ mine: query.mine === true ? undefined : true })
            }}
          >
            Only my runs
          </Chip>
        </FilterGroup>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-ink-muted" htmlFor="min-confidence">
            Confidence
          </label>
          <Select
            id="min-confidence"
            value={query.minConfidence === undefined ? "" : String(query.minConfidence)}
            onChange={(event) => {
              navigate({
                minConfidence: event.target.value === "" ? undefined : Number(event.target.value),
              })
            }}
            className="h-8 w-auto py-0 text-xs"
          >
            <option value="">Any</option>
            <option value="0.5">50% or more</option>
            <option value="0.75">75% or more</option>
            <option value="0.9">90% or more</option>
          </Select>
        </div>

        {active > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              router.push(pathname)
            }}
          >
            <X aria-hidden="true" />
            Clear {active} filter{active === 1 ? "" : "s"}
          </Button>
        )}
      </div>

      {tags.length > 0 && (
        <FilterGroup label="Tags">
          {tags.slice(0, 12).map(({ tag, count }) => (
            <Chip
              key={tag}
              active={(query.tags ?? []).includes(tag)}
              onClick={() => {
                toggleTag(tag)
              }}
            >
              {tag}
              <Badge tone="neutral" className="px-1.5 py-0 text-[0.65rem]">
                {count}
              </Badge>
            </Chip>
          ))}
        </FilterGroup>
      )}
    </div>
  )
}

function FilterGroup({
  label,
  children,
}: {
  label: string
  children: ReactElement | readonly ReactElement[]
}): ReactElement {
  return (
    // A real fieldset, so the group has a name in the accessibility tree rather
    // than being a row of unlabelled buttons.
    <fieldset className="flex flex-wrap items-center gap-1.5">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="text-xs font-medium text-ink-muted">
        {label}
      </span>
      {children}
    </fieldset>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-accent bg-accent-soft font-medium text-accent"
          : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
      )}
    >
      {children}
    </button>
  )
}
