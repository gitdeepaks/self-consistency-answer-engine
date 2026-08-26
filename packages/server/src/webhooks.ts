import { verifyWebhook, type WebhookEvent } from "@clerk/backend/webhooks"
import {
  claimWebhookDelivery,
  deleteClerkOrganization,
  deleteClerkUser,
  recordAuditSafely,
  removeClerkMembership,
  syncClerkMembership,
  syncClerkOrganization,
  syncClerkUser,
} from "@sce/db"
import { describeError, memberRoleFromClerk } from "@sce/shared"
import { Hono } from "hono"
import { config } from "./env.ts"

/**
 * Clerk → Postgres synchronisation.
 *
 * Clerk is the authority on *who exists*; this database is the authority on
 * *who owns what*. Runs, usage records, keys and audit rows all join against
 * local ids, so every Clerk user and organization has to have a local row —
 * a foreign key cannot point at somebody else's API.
 *
 * Three properties this handler has to have, because Svix guarantees none of
 * them:
 *
 *   **Verified.** Anyone can POST here. The signature is the only thing that
 *   distinguishes Clerk from a stranger who read the docs, so it is checked
 *   before the payload is looked at, never after.
 *
 *   **Idempotent.** Delivery is at-least-once. Every event is claimed by its
 *   `svix-id` first, and a duplicate is acknowledged without being applied.
 *
 *   **Order-independent.** A membership event can overtake the `user.created`
 *   it depends on. The sync functions create the placeholder rows they need and
 *   let the later event fill them in.
 *
 * The route answers 2xx for anything it handled or deliberately ignored, and
 * 5xx only for a failure worth retrying — because a 4xx/5xx is a retry request,
 * and retrying an event we will never understand is an infinite loop.
 */

const webhooks = new Hono()

/** The `identifier` on a membership payload is an email when it looks like one. */
function emailFromIdentifier(identifier: string): string | null {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier) ? identifier : null
}

function displayName(first: string | null, last: string | null): string | null {
  const name = `${first ?? ""} ${last ?? ""}`.trim()
  return name === "" ? null : name
}

/**
 * Apply one verified event.
 *
 * Returns the audit note for what it did, or null when the event is one we
 * deliberately do not act on — session and billing events, which Clerk sends
 * because the endpoint subscribes broadly and which have no local consequence
 * until Phase 4.
 */
async function apply(event: WebhookEvent): Promise<string | null> {
  switch (event.type) {
    case "user.created":
    case "user.updated": {
      const { id, email_addresses, primary_email_address_id, first_name, last_name } = event.data

      // Prefer the address Clerk marks primary; fall back to the first one.
      // A user with no email at all (phone-only sign-up) has nothing that can
      // satisfy the local unique constraint honestly, so a namespaced
      // placeholder stands in until they add one.
      const primary = email_addresses.find((address) => address.id === primary_email_address_id)
      const email = (primary ?? email_addresses[0])?.email_address ?? `${id}@users.noreply.clerk`

      await syncClerkUser({
        externalId: id,
        email,
        displayName: displayName(first_name, last_name),
      })
      return `user ${id}`
    }

    case "user.deleted": {
      const { id } = event.data
      // `DeletedObjectJSON.id` is optional in Clerk's own types. Without it
      // there is nothing to delete and nothing to retry for.
      if (id === undefined) return null
      await deleteClerkUser(id)
      return `user ${id} deleted`
    }

    case "organization.created":
    case "organization.updated": {
      const { id, name, slug } = event.data
      await syncClerkOrganization({ externalId: id, name, slug })
      return `organization ${id}`
    }

    case "organization.deleted": {
      const { id } = event.data
      if (id === undefined) return null
      await deleteClerkOrganization(id)
      return `organization ${id} deleted`
    }

    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const { organization, public_user_data, role } = event.data
      await syncClerkMembership({
        organizationExternalId: organization.id,
        organizationName: organization.name,
        organizationSlug: organization.slug,
        userExternalId: public_user_data.user_id,
        userEmail: emailFromIdentifier(public_user_data.identifier),
        userDisplayName: displayName(public_user_data.first_name, public_user_data.last_name),
        // Clerk's roles are namespaced (`org:admin`) and can be customised in
        // the dashboard. Mapping fails closed to `viewer` rather than throwing,
        // because throwing here would make Clerk retry an event forever over a
        // role this build simply does not model.
        role: memberRoleFromClerk(role),
      })
      return `membership ${public_user_data.user_id}@${organization.id}`
    }

    case "organizationMembership.deleted": {
      const { organization, public_user_data } = event.data
      await removeClerkMembership({
        organizationExternalId: organization.id,
        userExternalId: public_user_data.user_id,
      })
      return `membership ${public_user_data.user_id}@${organization.id} removed`
    }

    default:
      // Deliberately not exhaustive. Clerk's union covers sessions, billing,
      // invitations, roles and waitlist entries; subscribing to an event this
      // build does not model must be a no-op, not a 500 that Clerk retries.
      return null
  }
}

/** The audit action that best describes an applied event. */
function auditActionFor(type: WebhookEvent["type"]): Parameters<typeof recordAuditSafely>[0]["action"] {
  switch (type) {
    case "user.deleted":
      return "USER_DELETED"
    case "organization.created":
      return "TENANT_CREATED"
    case "organization.updated":
      return "TENANT_UPDATED"
    case "organization.deleted":
      return "TENANT_DELETED"
    case "organizationMembership.created":
      return "MEMBER_ADDED"
    case "organizationMembership.updated":
      return "MEMBER_ROLE_CHANGED"
    case "organizationMembership.deleted":
      return "MEMBER_REMOVED"
    default:
      return "USER_SYNCED"
  }
}

webhooks.post("/clerk", async (c) => {
  const signingSecret = config.clerk.webhookSigningSecret
  if (signingSecret === null) {
    // Not configured is not "accept anything" — an endpoint that cannot verify
    // must not process. 503 rather than 500: the deployment is incomplete, and
    // Clerk's retries will succeed once the secret is set.
    return c.json({ error: "Webhooks are not configured" }, 503)
  }

  let event: WebhookEvent
  try {
    event = await verifyWebhook(c.req.raw, { signingSecret })
  } catch (error: unknown) {
    // A bad signature is not a retryable condition — the same bytes will fail
    // the same way — so this is a 400, which tells Svix to stop.
    console.warn("[webhooks] signature verification failed", { error: describeError(error) })
    return c.json({ error: "Invalid signature" }, 400)
  }

  // Claim before applying. Two API replicas handed the same retry resolve it
  // here, in the database, rather than in the window between a read and a write.
  const deliveryId = c.req.header("svix-id")
  if (deliveryId !== undefined) {
    const claimed = await claimWebhookDelivery(deliveryId, event.type)
    if (!claimed) return c.json({ ok: true, deduplicated: true })
  }

  try {
    const applied = await apply(event)
    if (applied === null) return c.json({ ok: true, ignored: event.type })

    await recordAuditSafely({
      tenantId: null,
      action: auditActionFor(event.type),
      actorType: "SYSTEM",
      resourceType: "clerk-webhook",
      resourceId: deliveryId ?? null,
      metadata: { event: event.type, applied },
    })

    return c.json({ ok: true, applied: event.type })
  } catch (error: unknown) {
    // A database failure *is* worth retrying, so this one is a 500 — and the
    // delivery claim is released so the retry is not deduplicated away.
    console.error("[webhooks] failed to apply event", {
      type: event.type,
      error: describeError(error),
    })
    if (deliveryId !== undefined) await releaseClaim(deliveryId)
    return c.json({ error: "Could not apply event" }, 500)
  }
})

/**
 * Undo a delivery claim so Svix's retry is not swallowed by the dedupe.
 *
 * Imported lazily to keep the failure path from widening the module's import
 * surface: this is the only caller, and it runs only when something has already
 * gone wrong.
 */
async function releaseClaim(deliveryId: string): Promise<void> {
  const { prisma } = await import("@sce/db")
  await prisma.webhookDelivery
    .deleteMany({ where: { id: deliveryId } })
    .catch((error: unknown) => {
      console.error("[webhooks] could not release delivery claim", {
        deliveryId,
        error: describeError(error),
      })
    })
}

export { webhooks }
