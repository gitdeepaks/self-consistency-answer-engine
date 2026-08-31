import {
  mintShareToken,
  shareTokenSchema,
  type CreateShareInput,
  type RunShare,
  type ShareResolution,
  type SharedCandidate,
  type SharedRun,
} from "@sce/shared"
import { blobStore } from "./blob.ts"
import { prisma } from "./client.ts"

/**
 * Public share links.
 *
 * Two halves that must not be confused with each other:
 *
 *   - **Management** — creating, listing and revoking links — is tenant-scoped
 *     like everything else in this layer, and every function below takes a
 *     `tenantId`.
 *   - **Resolution** — turning a visitor's token into an answer — cannot be,
 *     because the visitor is anonymous and the token *is* what determines which
 *     tenant's data is served. `resolveShare` is that lookup, and it is the
 *     direct analogue of `verifyApiKey` in `auth.ts`: it resolves a tenant from
 *     a credential, so it cannot be given one. `repository.scoping.test.ts`
 *     records that exemption with the same reasoning.
 *
 * The projection `toSharedRun` builds is the security boundary of the whole
 * feature, so it exists exactly once, here.
 */

const DAY_MS = 24 * 60 * 60 * 1000

type ShareRow = Awaited<ReturnType<typeof prisma.runShare.findFirstOrThrow>>

export function toRunShare(row: ShareRow): RunShare {
  return {
    id: row.id,
    runId: row.runId,
    // Parsed rather than passed through: the column is a plain `text`, and a
    // value edited in psql or written by an older build must not reach a client
    // typed as a token. A row that fails this is a data error, not a share.
    token: shareTokenSchema.parse(row.token),
    label: row.label,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    viewCount: row.viewCount,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
  }
}

/* ------------------------------------------------------------- management */

export interface CreateShareOptions extends CreateShareInput {
  tenantId: string
  runId: string
  createdByUserId: string | null
}

/**
 * Publish a run.
 *
 * The run is re-read inside the same tenant filter rather than trusted from the
 * caller, so a share can never be minted for a run in another workspace even if
 * a route forgets to check — the insert simply finds nothing to attach to.
 */
export async function createShare(options: CreateShareOptions): Promise<RunShare | null> {
  const run = await prisma.run.findFirst({
    where: { id: options.runId, tenantId: options.tenantId },
    select: { id: true },
  })
  if (run === null) return null

  const row = await prisma.runShare.create({
    data: {
      tenantId: options.tenantId,
      runId: run.id,
      createdByUserId: options.createdByUserId,
      token: mintShareToken(),
      label: options.label ?? null,
      expiresAt:
        options.expiresInDays === undefined
          ? null
          : new Date(Date.now() + options.expiresInDays * DAY_MS),
    },
  })
  return toRunShare(row)
}

/** Every link ever created for one run, newest first — live and dead alike. */
export async function listSharesForRun(tenantId: string, runId: string): Promise<RunShare[]> {
  const rows = await prisma.runShare.findMany({
    where: { tenantId, runId },
    orderBy: { createdAt: "desc" },
  })
  return rows.map(toRunShare)
}

/** Every link in a workspace. The "what have we published?" audit view. */
export async function listShares(options: {
  tenantId: string
  limit?: number
}): Promise<RunShare[]> {
  const rows = await prisma.runShare.findMany({
    where: { tenantId: options.tenantId },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 100,
  })
  return rows.map(toRunShare)
}

/**
 * Turn a link off.
 *
 * Effective on the next request, because `resolveShare` reads the row every
 * time and there is no cache to wait out — the same property that makes API key
 * revocation immediate. Returns false when the link was already revoked or
 * never existed, which the route treats as success either way: the caller's
 * intent is satisfied.
 */
export async function revokeShare(tenantId: string, shareId: string): Promise<boolean> {
  const result = await prisma.runShare.updateMany({
    where: { id: shareId, tenantId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return result.count > 0
}

/* ------------------------------------------------------------- resolution */

/**
 * The public projection.
 *
 * Every field a visitor receives is listed here explicitly, and nothing is
 * spread in from a row. That is deliberate: a projection built by spreading and
 * deleting leaks the next column somebody adds, whereas one built by naming
 * cannot. What is left out is the point —
 *
 *   - the person who asked, and the workspace id,
 *   - the candidates' bodies and their provider errors,
 *   - tokens, cost, deadlines, ceilings and the idempotency key.
 *
 * The panel survives by *name* only, because "three models agreed" is the
 * claim the artefact is making and it is meaningless without saying which.
 */
async function toSharedRun(
  row: Awaited<ReturnType<typeof prisma.run.findFirstOrThrow>> & {
    candidates: { provider: SharedCandidate["provider"]; label: string; model: string; status: SharedCandidate["status"] }[]
    synthesis: { finalAnswer: string | null; finalAnswerRef: string | null; agreements: unknown; disagreements: unknown; confidence: number } | null
    tenant: { name: string }
  },
): Promise<SharedRun | null> {
  const synthesis = row.synthesis
  // A run with no synthesis has no artefact to publish. Reported as "not found"
  // rather than an empty page, because a share of a failed run is a link its
  // owner almost certainly did not mean to send.
  if (synthesis === null) return null

  const finalAnswer =
    synthesis.finalAnswer ??
    (synthesis.finalAnswerRef === null ? null : await blobStore().get(synthesis.finalAnswerRef))
  if (finalAnswer === null) return null

  return {
    prompt: row.prompt,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    panel: row.candidates.map((candidate) => ({
      provider: candidate.provider,
      label: candidate.label,
      model: candidate.model,
      status: candidate.status,
    })),
    finalAnswer,
    agreements: stringList(synthesis.agreements),
    disagreements: stringList(synthesis.disagreements),
    confidence: synthesis.confidence,
    sharedBy: row.tenant.name,
  }
}

/** A `Json` column read as a list of strings, degrading to empty rather than throwing. */
function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === "string")
}

/**
 * Serve a visitor's link.
 *
 * The rejection reasons are distinguished here so an operator can tell
 * "revoked" from "never existed" in a log. The *route* collapses all of them to
 * 404 — telling an anonymous caller that a link has expired confirms it once
 * existed, and that is information they were not given.
 *
 * The view counter is a fire-and-forget update: a share must render even if the
 * write fails, and a counter that can take the page down is worse than no
 * counter.
 */
export async function resolveShare(token: string, now: Date = new Date()): Promise<ShareResolution> {
  const parsed = shareTokenSchema.safeParse(token)
  if (!parsed.success) return { ok: false, reason: "not-found" }

  const share = await prisma.runShare.findUnique({
    where: { token: parsed.data },
    include: {
      run: {
        include: {
          candidates: {
            orderBy: { position: "asc" },
            select: { provider: true, label: true, model: true, status: true },
          },
          synthesis: {
            select: {
              finalAnswer: true,
              finalAnswerRef: true,
              agreements: true,
              disagreements: true,
              confidence: true,
            },
          },
          tenant: { select: { name: true } },
        },
      },
    },
  })

  if (share === null) return { ok: false, reason: "not-found" }
  if (share.revokedAt !== null) return { ok: false, reason: "revoked" }
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" }
  }

  const run = await toSharedRun(share.run)
  if (run === null) return { ok: false, reason: "unavailable" }

  await prisma.runShare
    .update({
      where: { id: share.id },
      data: { viewCount: { increment: 1 }, lastViewedAt: now },
    })
    .catch(() => {})

  return { ok: true, run }
}
