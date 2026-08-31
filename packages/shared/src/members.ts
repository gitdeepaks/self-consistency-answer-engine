import { z } from "zod"
import { memberRoleSchema } from "./schemas.ts"

/**
 * The people in a workspace.
 *
 * Read-only from this API's point of view, and that is a decision rather than
 * an omission: Clerk owns identity, so invitations, removals and role changes
 * happen in Clerk's organization UI and arrive here through the webhook that
 * already syncs them. A second write path would let this database and Clerk
 * disagree about who is in a company — the exact drift Phase 3's reconciliation
 * job exists to detect.
 *
 * What the web app needs from us is the *joined* view Clerk cannot give it:
 * who is a member, and what they have actually done here.
 */

export const tenantMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: memberRoleSchema,
  joinedAt: z.string(),
  /** Runs this person has started in this workspace. */
  runCount: z.number().int().nonnegative(),
  /** Their most recent run, or null if they have never started one. */
  lastRunAt: z.string().nullable(),
  /** True for the member making the request, so a UI can mark "you". */
  isSelf: z.boolean(),
})
export type TenantMember = z.infer<typeof tenantMemberSchema>

export const tenantMembersSchema = z.object({
  members: z.array(tenantMemberSchema),
  /** The workspace being described, so an org switcher has a label to show. */
  tenant: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
})
export type TenantMembers = z.infer<typeof tenantMembersSchema>

/**
 * The workspaces the calling person belongs to.
 *
 * Powers the org switcher. `active` is resolved server-side by the same
 * precedence the auth layer uses, so the switcher can never show a different
 * workspace from the one requests are actually being served against.
 */
export const workspaceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  role: memberRoleSchema,
  active: z.boolean(),
})
export type Workspace = z.infer<typeof workspaceSchema>
