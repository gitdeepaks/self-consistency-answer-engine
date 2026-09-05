import type { RunFilters } from "@sce/db"
import type { RunSearchQuery } from "@sce/shared"

/**
 * A parsed search query, as repository filters.
 *
 * Extracted from `app.ts` when `/v1` appeared, because the two surfaces must
 * translate a history query identically — the moment they do not, a filter
 * behaves one way in the web app and another way through the SDK, and the bug
 * report says "search is broken" without saying which one.
 *
 * The two interesting translations:
 *
 * **`to` is widened to the end of its day.** A person filtering "up to the 5th"
 * means the whole of the 5th; a naive `lt: 2026-09-05T00:00:00Z` silently drops
 * everything that happened on the day they named, which reads as a bug every
 * single time.
 *
 * **`mine` resolves to the actor's own id**, never to anything the client sent.
 * There is no parameter that names a user, so the filter cannot be turned into
 * "show me what my colleague has been asking".
 */
export function toRunFilters(query: RunSearchQuery, selfUserId: string | null): RunFilters {
  const dayAfter = (day: string): Date =>
    new Date(new Date(`${day}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000)

  return {
    ...(query.q === undefined ? {} : { q: query.q }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.providers === undefined ? {} : { providers: query.providers }),
    ...(query.tags === undefined ? {} : { tags: query.tags }),
    ...(query.from === undefined ? {} : { from: new Date(`${query.from}T00:00:00Z`) }),
    ...(query.to === undefined ? {} : { to: dayAfter(query.to) }),
    ...(query.minConfidence === undefined ? {} : { minConfidence: query.minConfidence }),
    // A key-bound credential has no person, so "only mine" has no meaning for
    // it and is dropped rather than matching every run with a null owner.
    ...(query.mine === true && selfUserId !== null ? { createdByUserId: selfUserId } : {}),
  }
}
