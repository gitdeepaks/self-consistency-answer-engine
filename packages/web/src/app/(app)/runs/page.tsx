import { isFilteredSearch, runSearchQuerySchema, runSearchToParams } from "@sce/shared"
import { History, SearchX } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import type { ReactElement } from "react"
import { RunFilters } from "@/components/runs/filters"
import { RunList } from "@/components/runs/run-list"
import { Button } from "@/components/ui/button"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "History" }

/**
 * Run history.
 *
 * The query string is the state, so this page is a pure function of the URL —
 * which is what makes a filtered view shareable, the back button correct, and
 * this component server-renderable with real data in the HTML.
 *
 * The parse is deliberately forgiving in one direction only. A bookmarked URL
 * naming a provider this build no longer ships has that entry dropped
 * (`csvEnum` in `@sce/shared`), because a stale link is not an attack and
 * narrowing a filter cannot surprise anyone. A malformed *scalar* — a date that
 * is not a date — has no safe narrowing, so the whole query falls back to the
 * default rather than being half-applied.
 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<ReactElement> {
  const raw = await searchParams

  // Repeated keys are collapsed to the first value: this app never produces
  // them (lists are comma-separated), so one arriving means a hand-edited URL,
  // and taking the first is the least surprising reading of it.
  const flat = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]),
  )

  const parsed = runSearchQuerySchema.safeParse(flat)
  const query = parsed.success ? parsed.data : runSearchQuerySchema.parse({})

  const api = serverApi()
  const [page, tags] = await Promise.all([
    api.listRuns(query).catch(() => null),
    // A failure here costs a filter menu, not the page — so it degrades to an
    // empty tag list rather than taking the history down with it.
    api.listTags().catch(() => []),
  ])

  if (page === null) {
    return (
      <ErrorState
        title="Could not load your history"
        detail="The API did not answer. Check that it is running and that you are signed in."
      />
    )
  }

  const filtered = isFilteredSearch(query)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">History</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every run in this workspace, newest first.
          </p>
        </div>
        <Link href="/ask">
          <Button>Ask something new</Button>
        </Link>
      </div>

      <RunFilters query={query} tags={tags} />

      {page.items.length === 0 ? (
        // The distinction that makes a working filter look like a working
        // filter: "you have not asked anything" and "nothing matches" are
        // different situations with different next steps.
        filtered ? (
          <EmptyState
            icon={<SearchX className="size-8" aria-hidden="true" />}
            title="Nothing matches these filters"
            description="Try a broader search, or clear the filters to see everything in this workspace."
            action={
              <Link href="/runs">
                <Button variant="secondary">Clear the filters</Button>
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={<History className="size-8" aria-hidden="true" />}
            title="No runs yet"
            description="Ask the panel a question and it will show up here, along with everything your teammates ask."
            action={
              <Link href="/ask">
                <Button>Ask the panel</Button>
              </Link>
            }
          />
        )
      ) : (
        <>
          <RunList runs={page.items} />

          {page.nextCursor !== null && (
            <div className="flex justify-center">
              <Link
                href={`/runs?${runSearchToParams({ ...query, cursor: page.nextCursor }).toString()}`}
              >
                <Button variant="secondary">Load older runs</Button>
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  )
}
