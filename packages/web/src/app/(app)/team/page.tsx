import type { Metadata } from "next"
import type { ReactElement } from "react"
import { Badge } from "@/components/ui/badge"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { EmptyState, ErrorState } from "@/components/ui/states"
import { count, when } from "@/lib/format"
import { serverApi } from "@/lib/api/server"

export const metadata: Metadata = { title: "Team" }

/**
 * The workspace roster.
 *
 * Read-only, and the page says why rather than leaving people hunting for an
 * "Invite" button that is not there: Clerk owns identity, so invitations,
 * removals and role changes happen in Clerk's organization UI and reach this
 * database through the webhook that already syncs them. A second write path
 * would let the two disagree about who works at a company.
 *
 * What this page adds is the join Clerk cannot do — who has actually used the
 * product, and when they last did.
 */
export default async function TeamPage(): Promise<ReactElement> {
  const api = serverApi()

  const [members, workspaces] = await Promise.all([
    api.listMembers().catch(() => null),
    api.listWorkspaces().catch(() => null),
  ])

  if (members === null) {
    return (
      <ErrorState
        title="Could not load the team"
        detail="The API did not answer, or this credential is not allowed to read members."
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Team</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Everyone in this workspace, and what they have run in it.
        </p>
      </div>

      <Panel>
        <PanelHeader
          title="Members"
          description="Managed in Clerk. Changes there appear here within seconds, through the identity webhook."
          actions={<Badge tone="neutral">{members.length} member{members.length === 1 ? "" : "s"}</Badge>}
        />
        <PanelBody className="p-0">
          {members.length === 0 ? (
            <EmptyState
              title="Nobody has been synced yet"
              description="Members appear here once Clerk's webhook has mirrored them into the database. If this stays empty, check the webhook's delivery log."
            />
          ) : (
            <ul className="divide-y divide-[--border]">
              {members.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">
                      {member.displayName ?? member.email}
                      {member.isSelf && <span className="ml-2 text-xs text-ink-faint">(you)</span>}
                    </p>
                    {member.displayName !== null && (
                      <p className="truncate text-xs text-ink-faint">{member.email}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <span className="text-xs text-ink-muted">
                      {member.runCount === 0
                        ? "no runs yet"
                        : `${count(member.runCount)} run${member.runCount === 1 ? "" : "s"}`}
                      {member.lastRunAt !== null && ` · last ${when(member.lastRunAt)}`}
                    </span>
                    <Badge tone={member.role === "owner" || member.role === "admin" ? "accent" : "neutral"}>
                      {member.role}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

      {workspaces !== null && workspaces.workspaces.length > 1 && (
        <Panel>
          <PanelHeader
            title="Your workspaces"
            description="What the API resolves for your credential. Switch with the picker in the header — Clerk owns the active organization, and the API follows it."
          />
          <PanelBody className="p-0">
            <ul className="divide-y divide-[--border]">
              {workspaces.workspaces.map((workspace) => (
                <li
                  key={workspace.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{workspace.name}</p>
                    <p className="truncate font-mono text-xs text-ink-faint">{workspace.slug}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{workspace.role}</Badge>
                    {workspace.active && <Badge tone="success">Active</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>
      )}
    </div>
  )
}
