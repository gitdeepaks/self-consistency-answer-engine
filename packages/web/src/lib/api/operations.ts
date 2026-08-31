import {
  readRunEventStream,
  runSearchToParams,
  type AskInput,
  type CreateApiKeyInput,
  type CreateShareInput,
  type ReplayDeadLetterInput,
  type RunSearchQuery,
  type StreamedRunEvent,
  type SubmitFeedbackInput,
} from "@sce/shared"
import type { z } from "zod"
import { config } from "@/env"
import { ApiRequestError, createClient, unwrap, type TokenProvider } from "./client"
import * as e from "./envelopes"

/**
 * Every call this app makes to the API, in one place.
 *
 * Built as a factory over a `TokenProvider` rather than as a module of free
 * functions, because the same operations are issued from two places that
 * authenticate completely differently: React Server Components hold a Clerk
 * token from `auth()`, and the browser holds one from `useAuth()`. Duplicating
 * the operation list per surface is how the two drift; parameterising the
 * credential is how they cannot.
 *
 * Two rules hold throughout:
 *
 *   - **Nothing is assembled from a raw `fetch`.** Paths come from
 *     `hc<AppType>()`, so a renamed route is a compile error here rather than a
 *     404 a user finds.
 *   - **Nothing is trusted.** Every response goes through `unwrap` and a shared
 *     schema. See `client.ts` for why the two are not redundant.
 */

export interface Api {
  /* runs */
  listRuns(query: Partial<RunSearchQuery>): Promise<z.infer<typeof e.historyEnvelope>>
  getRun(id: string): Promise<z.infer<typeof e.runEnvelope>["run"]>
  createRun(input: AskInput, idempotencyKey?: string): Promise<z.infer<typeof e.runEnvelope>["run"]>
  cancelRun(id: string, reason?: string): Promise<z.infer<typeof e.cancelEnvelope>>
  deleteRun(id: string): Promise<void>
  setRunTags(id: string, tags: readonly string[]): Promise<string[]>
  listTags(): Promise<z.infer<typeof e.tagsEnvelope>["tags"]>
  /**
   * Follow a run's progress.
   *
   * Not `EventSource`, which cannot send an `Authorization` header, cannot be
   * aborted cleanly and re-sends only the cursor *it* chose. The body is read
   * as a stream and decoded by `readRunEventStream` in `@sce/shared` — the same
   * decoder the CLI uses, so the two clients cannot disagree about frame
   * boundaries or multi-byte characters.
   */
  streamRun(
    id: string,
    options: { signal: AbortSignal; afterSeq: number },
  ): AsyncGenerator<StreamedRunEvent>

  /* panel and account */
  getProviders(): Promise<z.infer<typeof e.providersEnvelope>>
  getUsage(): Promise<z.infer<typeof e.usageEnvelope>>
  getUsageDaily(range?: { from?: string; to?: string }): Promise<z.infer<typeof e.usageDailyEnvelope>>
  getBilling(): Promise<z.infer<typeof e.billingEnvelope>>
  whoami(): Promise<z.infer<typeof e.whoamiEnvelope>>

  /* team */
  listMembers(): Promise<z.infer<typeof e.membersEnvelope>["members"]>
  listWorkspaces(): Promise<z.infer<typeof e.workspacesEnvelope>>

  /* keys */
  listKeys(): Promise<z.infer<typeof e.keysEnvelope>["keys"]>
  createKey(input: CreateApiKeyInput): Promise<z.infer<typeof e.keyCreatedEnvelope>>
  revokeKey(id: string): Promise<void>

  /* sharing */
  listRunShares(runId: string): Promise<z.infer<typeof e.sharesEnvelope>["shares"]>
  createShare(runId: string, input: CreateShareInput): Promise<z.infer<typeof e.shareEnvelope>["share"]>
  listShares(): Promise<z.infer<typeof e.sharesEnvelope>["shares"]>
  revokeShare(shareId: string): Promise<void>

  /* feedback */
  getFeedback(runId: string): Promise<z.infer<typeof e.feedbackEnvelope>["feedback"]>
  submitFeedback(
    runId: string,
    input: SubmitFeedbackInput,
  ): Promise<z.infer<typeof e.feedbackEnvelope>["feedback"]>

  /* operator */
  /**
   * Whether the caller may use the console at all.
   *
   * The route answers 404 to everyone else, so this either resolves or throws —
   * there is no "false" to return. Callers treat any failure as "no", which is
   * the safe direction and the one that also covers the API being unreachable.
   */
  whoamiOperator(): Promise<z.infer<typeof e.adminWhoamiEnvelope>>
  adminOverview(): Promise<z.infer<typeof e.adminOverviewEnvelope>>
  adminTenants(query: { q?: string; days?: number }): Promise<z.infer<typeof e.adminTenantsEnvelope>>
  adminRun(id: string): Promise<z.infer<typeof e.adminRunEnvelope>>
  adminDeadLetters(): Promise<z.infer<typeof e.adminDlqEnvelope>["deadLetters"]>
  adminReplay(input: ReplayDeadLetterInput): Promise<z.infer<typeof e.adminReplayEnvelope>>
  adminReleaseBudget(reason: string): Promise<z.infer<typeof e.adminBudgetEnvelope>>
}

export function createApi(getToken: TokenProvider): Api {
  const client = createClient(getToken)

  return {
    async listRuns(query) {
      // Rendered through the shared serializer, so a URL this app builds always
      // parses back to the query it came from — the round trip that makes
      // filters shareable and the back button correct.
      const params = runSearchToParams(query)
      const res = await client.api.runs.$get({ query: Object.fromEntries(params) })
      return unwrap(res, e.historyEnvelope, "Loading history")
    },

    async getRun(id) {
      const res = await client.api.runs[":id"].$get({ param: { id } })
      return (await unwrap(res, e.runEnvelope, "Loading run")).run
    },

    async createRun(input, idempotencyKey) {
      const res = await client.api.runs.$post({
        json: input,
        // The header field is always present in the request type; the *value*
        // is what is optional, so it is left undefined rather than omitted.
        header: idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
      })
      return (await unwrap(res, e.runEnvelope, "Starting run")).run
    },

    async cancelRun(id, reason) {
      const res = await client.api.runs[":id"].cancel.$post({
        param: { id },
        json: reason === undefined ? {} : { reason },
      })
      return unwrap(res, e.cancelEnvelope, "Canceling run")
    },

    async deleteRun(id) {
      const res = await client.api.runs[":id"].$delete({ param: { id } })
      await unwrap(res, e.okEnvelope, "Deleting run")
    },

    async setRunTags(id, tags) {
      const res = await client.api.runs[":id"].tags.$put({ param: { id }, json: { tags: [...tags] } })
      return (await unwrap(res, e.runTagsEnvelope, "Saving tags")).tags
    },

    async listTags() {
      const res = await client.api.tags.$get()
      return (await unwrap(res, e.tagsEnvelope, "Loading tags")).tags
    },

    async *streamRun(id, options) {
      const res = await client.api.runs[":id"].events.$get(
        {
          param: { id },
          query: { afterSeq: options.afterSeq > 0 ? String(options.afterSeq) : undefined },
        },
        { init: { signal: options.signal } },
      )

      if (!res.ok || res.body === null) {
        throw new ApiRequestError(
          `Could not subscribe to this run (HTTP ${res.status})`,
          res.status,
          null,
        )
      }

      yield* readRunEventStream(res.body)
    },

    async getProviders() {
      const res = await client.api.providers.$get()
      return unwrap(res, e.providersEnvelope, "Loading the panel")
    },

    async getUsage() {
      const res = await client.api.usage.$get()
      return unwrap(res, e.usageEnvelope, "Loading usage")
    },

    async getUsageDaily(range) {
      const res = await client.api.usage.daily.$get({
        query: {
          ...(range?.from === undefined ? {} : { from: range.from }),
          ...(range?.to === undefined ? {} : { to: range.to }),
        },
      })
      return unwrap(res, e.usageDailyEnvelope, "Loading the spend breakdown")
    },

    async getBilling() {
      const res = await client.api.billing.$get()
      return unwrap(res, e.billingEnvelope, "Loading billing")
    },

    async whoami() {
      const res = await client.api.auth.whoami.$get()
      return unwrap(res, e.whoamiEnvelope, "Identifying the current session")
    },

    async listMembers() {
      const res = await client.api.members.$get()
      return (await unwrap(res, e.membersEnvelope, "Loading the team")).members
    },

    async listWorkspaces() {
      const res = await client.api.members.workspaces.$get()
      return unwrap(res, e.workspacesEnvelope, "Loading workspaces")
    },

    async listKeys() {
      const res = await client.api.keys.$get()
      return (await unwrap(res, e.keysEnvelope, "Loading API keys")).keys
    },

    async createKey(input) {
      const res = await client.api.keys.$post({ json: input })
      return unwrap(res, e.keyCreatedEnvelope, "Creating an API key")
    },

    async revokeKey(id) {
      const res = await client.api.keys[":id"].$delete({ param: { id } })
      await unwrap(res, e.okEnvelope, "Revoking the key")
    },

    async listRunShares(runId) {
      const res = await client.api.runs[":id"].shares.$get({ param: { id: runId } })
      return (await unwrap(res, e.sharesEnvelope, "Loading share links")).shares
    },

    async createShare(runId, input) {
      const res = await client.api.runs[":id"].shares.$post({ param: { id: runId }, json: input })
      return (await unwrap(res, e.shareEnvelope, "Creating a share link")).share
    },

    async listShares() {
      const res = await client.api.shares.$get()
      return (await unwrap(res, e.sharesEnvelope, "Loading share links")).shares
    },

    async revokeShare(shareId) {
      const res = await client.api.shares[":id"].$delete({ param: { id: shareId } })
      await unwrap(res, e.okEnvelope, "Revoking the link")
    },

    async getFeedback(runId) {
      const res = await client.api.runs[":id"].feedback.$get({ param: { id: runId } })
      return (await unwrap(res, e.feedbackEnvelope, "Loading feedback")).feedback
    },

    async submitFeedback(runId, input) {
      const res = await client.api.runs[":id"].feedback.$post({ param: { id: runId }, json: input })
      return (await unwrap(res, e.feedbackEnvelope, "Saving feedback")).feedback
    },

    async whoamiOperator() {
      const res = await client.api.admin.whoami.$get()
      return unwrap(res, e.adminWhoamiEnvelope, "Checking operator access")
    },

    async adminOverview() {
      const res = await client.api.admin.overview.$get()
      return unwrap(res, e.adminOverviewEnvelope, "Loading the operations overview")
    },

    async adminTenants(query) {
      const res = await client.api.admin.tenants.$get({
        query: {
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(query.days === undefined ? {} : { days: String(query.days) }),
        },
      })
      return unwrap(res, e.adminTenantsEnvelope, "Looking up workspaces")
    },

    async adminRun(id) {
      const res = await client.api.admin.runs[":id"].$get({ param: { id } })
      return unwrap(res, e.adminRunEnvelope, "Inspecting the run")
    },

    async adminDeadLetters() {
      const res = await client.api.admin.dlq.$get()
      return (await unwrap(res, e.adminDlqEnvelope, "Loading the dead-letter queue")).deadLetters
    },

    async adminReplay(input) {
      const res = await client.api.admin.dlq.replay.$post({ json: input })
      return unwrap(res, e.adminReplayEnvelope, "Replaying the job")
    },

    async adminReleaseBudget(reason) {
      const res = await client.api.admin.budget.release.$post({ json: { reason } })
      return unwrap(res, e.adminBudgetEnvelope, "Releasing the spend guard")
    },
  }
}

/**
 * The one call that needs no credential.
 *
 * A share link is opened by somebody with no account, so it goes through plain
 * `fetch` rather than the authenticated client — there is no token to resolve,
 * and asking Clerk for one would make an anonymous page depend on an identity
 * provider being reachable.
 *
 * Returns null for every failure, because the page has exactly one thing to say
 * either way: this link is not available. The API already collapses revoked,
 * expired and never-existed to a single 404 for the same reason.
 */
export async function fetchSharedRun(
  token: string,
): Promise<z.infer<typeof e.sharedRunEnvelope>["run"] | null> {
  const response = await fetch(`${config.apiUrl}/api/shared/${encodeURIComponent(token)}`, {
    // A published answer is immutable in practice but revocable at any moment,
    // so it is revalidated rather than cached indefinitely: a revoked link has
    // to stop working, and a minute is the longest anybody should wait for it.
    next: { revalidate: 60 },
  }).catch(() => null)

  if (response === null || !response.ok) return null

  const body: unknown = await response.json().catch(() => null)
  const parsed = e.sharedRunEnvelope.safeParse(body)
  return parsed.success ? parsed.data.run : null
}
