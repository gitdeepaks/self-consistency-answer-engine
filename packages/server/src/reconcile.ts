import { createClerkClient } from "@clerk/backend"
import {
  deleteClerkOrganization,
  disconnect,
  prisma,
  recordAuditSafely,
  syncClerkMembership,
  syncClerkOrganization,
} from "@sce/db"
import { describeError, memberRoleFromClerk } from "@sce/shared"
import { clerkConfigured, config } from "./env.ts"

/**
 * Nightly reconciliation between Clerk and Postgres.
 *
 * Webhooks are the fast path and they are eventually consistent — which is a
 * polite way of saying they are eventually *wrong*. A delivery fails past its
 * retry budget, an endpoint is misconfigured for an hour, a deploy drops a
 * window of events. Nothing about that is visible: the database simply carries
 * on being quietly stale, and the first symptom is a real person who cannot
 * sign in to an organization they were added to last week.
 *
 * So the webhook is not the only writer. This walks Clerk's own list of
 * organizations and memberships and makes the local mirror match it, reporting
 * every difference it had to fix. A run that repairs nothing is the expected
 * result; a run that repairs something is an alert about the webhook path.
 *
 *   bun run auth:reconcile            # repair drift and report
 *   bun run auth:reconcile --dry-run  # report only
 */

interface Drift {
  kind: "organization" | "membership" | "orphan-tenant"
  detail: string
}

interface Options {
  dryRun: boolean
}

function parseArgs(argv: readonly string[]): Options {
  return { dryRun: argv.includes("--dry-run") }
}

/** Clerk paginates; 100 is its maximum page size. */
const PAGE = 100

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (!clerkConfigured() || config.clerk.secretKey === null) {
    console.log(
      "\n  Clerk is not configured — nothing to reconcile.\n" +
        "  Set CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY to enable identity sync.\n",
    )
    return
  }

  const clerk = createClerkClient({
    secretKey: config.clerk.secretKey,
    ...(config.clerk.publishableKey === null
      ? {}
      : { publishableKey: config.clerk.publishableKey }),
  })

  const drift: Drift[] = []
  const seenOrgIds = new Set<string>()

  for (let offset = 0; ; offset += PAGE) {
    const page = await clerk.organizations.getOrganizationList({ limit: PAGE, offset })
    if (page.data.length === 0) break

    for (const org of page.data) {
      seenOrgIds.add(org.id)

      const local = await prisma.tenant.findUnique({ where: { externalId: org.id } })
      const nameDiffers = local !== null && local.name !== org.name
      const resurrected = local !== null && local.deletedAt !== null

      if (local === null || nameDiffers || resurrected) {
        drift.push({
          kind: "organization",
          detail:
            local === null
              ? `missing tenant for ${org.id} (${org.name})`
              : `${org.id}: ${resurrected ? "soft-deleted upstream but live in Clerk" : `name "${local.name}" → "${org.name}"`}`,
        })
        if (!options.dryRun) {
          await syncClerkOrganization({ externalId: org.id, name: org.name, slug: org.slug })
          if (resurrected) {
            await prisma.tenant.update({
              where: { externalId: org.id },
              data: { deletedAt: null },
            })
          }
        }
      }

      await reconcileMemberships(clerk, org, drift, options)
    }

    if (page.data.length < PAGE) break
  }

  // A tenant with a Clerk id that Clerk no longer lists is an organization
  // whose `organization.deleted` never arrived. Soft-deleted, never dropped:
  // usage records feed billing that outlives the org.
  const orphans = await prisma.tenant.findMany({
    where: { externalId: { not: null }, deletedAt: null },
    select: { id: true, externalId: true, name: true },
  })
  for (const tenant of orphans) {
    if (tenant.externalId === null || seenOrgIds.has(tenant.externalId)) continue

    drift.push({
      kind: "orphan-tenant",
      detail: `${tenant.externalId} (${tenant.name}) no longer exists in Clerk`,
    })
    if (!options.dryRun) await deleteClerkOrganization(tenant.externalId)
  }

  report(drift, options)
}

/** Bring one organization's membership list into line. */
async function reconcileMemberships(
  clerk: ReturnType<typeof createClerkClient>,
  org: { id: string; name: string; slug: string | null },
  drift: Drift[],
  options: Options,
): Promise<void> {
  const tenant = await prisma.tenant.findUnique({
    where: { externalId: org.id },
    select: { id: true },
  })
  // Created a moment ago in a dry run; nothing local to compare against.
  if (tenant === null) return

  const upstream = new Set<string>()

  for (let offset = 0; ; offset += PAGE) {
    const page = await clerk.organizations.getOrganizationMembershipList({
      organizationId: org.id,
      limit: PAGE,
      offset,
    })
    if (page.data.length === 0) break

    for (const membership of page.data) {
      const externalUserId = membership.publicUserData?.userId
      if (externalUserId === undefined) continue
      upstream.add(externalUserId)

      const role = memberRoleFromClerk(membership.role)
      const local = await prisma.membership.findFirst({
        where: { tenantId: tenant.id, user: { externalId: externalUserId } },
        select: { role: true },
      })

      if (local === null || local.role !== role) {
        drift.push({
          kind: "membership",
          detail:
            local === null
              ? `missing membership ${externalUserId}@${org.id} (${role})`
              : `${externalUserId}@${org.id}: role ${local.role} → ${role}`,
        })
        if (!options.dryRun) {
          await syncClerkMembership({
            organizationExternalId: org.id,
            organizationName: org.name,
            organizationSlug: org.slug,
            userExternalId: externalUserId,
            userEmail: membership.publicUserData?.identifier ?? null,
            userDisplayName:
              `${membership.publicUserData?.firstName ?? ""} ${membership.publicUserData?.lastName ?? ""}`.trim() ||
              null,
            role,
          })
        }
      }
    }

    if (page.data.length < PAGE) break
  }

  // Local memberships Clerk does not list: a `organizationMembership.deleted`
  // that never arrived. This is the security-relevant direction — someone
  // removed upstream who still has access here — so it is repaired even though
  // it means a delete.
  const locals = await prisma.membership.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, userId: true, user: { select: { externalId: true } } },
  })

  for (const local of locals) {
    const externalId = local.user.externalId
    // A user with no Clerk id was seeded locally and is not Clerk's to remove.
    if (externalId === null || upstream.has(externalId)) continue

    drift.push({
      kind: "membership",
      detail: `stale membership ${externalId}@${org.id} — removed in Clerk but still local`,
    })
    if (!options.dryRun) {
      await prisma.membership.delete({ where: { id: local.id } })
      await prisma.apiKey.updateMany({
        where: { tenantId: tenant.id, createdByUserId: local.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
    }
  }
}

function report(drift: Drift[], options: Options): void {
  if (drift.length === 0) {
    console.log("\n  Clerk and Postgres agree. No drift.\n")
    return
  }

  console.log(
    [
      "",
      `  ${drift.length} difference${drift.length === 1 ? "" : "s"} ` +
        `${options.dryRun ? "found (dry run — nothing changed)" : "repaired"}:`,
      "",
      ...drift.map((item) => `    [${item.kind}] ${item.detail}`),
      "",
      "  Drift means the webhook path missed events. Check the endpoint's",
      "  delivery log in the Clerk dashboard before dismissing this.",
      "",
    ].join("\n"),
  )

  if (!options.dryRun) {
    void recordAuditSafely({
      tenantId: null,
      action: "USER_SYNCED",
      actorType: "SYSTEM",
      resourceType: "reconciliation",
      metadata: { repaired: drift.length, kinds: drift.map((item) => item.kind) },
    })
  }

  // Non-zero so a scheduled run surfaces as a failed job and pages someone,
  // rather than scrolling past in a log nobody reads.
  process.exitCode = 1
}

await main()
  .catch((error: unknown) => {
    console.error("[reconcile]", describeError(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await disconnect()
  })
