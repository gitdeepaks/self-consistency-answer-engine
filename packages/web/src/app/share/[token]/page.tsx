import { shareTokenSchema } from "@sce/shared"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import type { ReactElement } from "react"
import { Markdown } from "@/components/markdown"
import { ConfidenceMeter, ProviderTag } from "@/components/run/status"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/ui/copy-button"
import { Panel, PanelBody, PanelHeader } from "@/components/ui/panel"
import { ThemeToggle } from "@/components/theme-toggle"
import { fetchSharedRun } from "@/lib/api/operations"
import { excerpt, exactly, when } from "@/lib/format"

interface Params {
  params: Promise<{ token: string }>
}

/**
 * A published answer.
 *
 * The only page in this app that serves somebody with no account, and the only
 * one deliberately outside the `(app)` route group's authentication wall.
 * Three properties follow from that, and each is load-bearing:
 *
 * **It is anonymous by construction.** There is no Clerk call, no token, and no
 * session — so it renders whether or not the visitor has an account, and
 * whether or not the identity provider is even reachable.
 *
 * **It shows a redacted projection, decided server-side.** The API's
 * `toSharedRun` builds it by naming every field, so this page renders what it
 * is given and cannot accidentally surface a candidate body, a cost, or who
 * asked the question — even if somebody later adds a field to `Run`.
 *
 * **Every failure looks the same.** Revoked, expired, deleted and never-existed
 * all reach `notFound()`, because telling an anonymous caller that a link
 * *expired* confirms it once existed. The API already collapses them for the
 * same reason; this page does not undo that.
 */

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params
  const parsed = shareTokenSchema.safeParse(token)
  const run = parsed.success ? await fetchSharedRun(parsed.data) : null

  if (run === null) return { title: "Link not available", robots: { index: false } }

  return {
    title: excerpt(run.prompt, 60),
    description: excerpt(run.finalAnswer, 180),
    // The one page that opts back in to indexing. A shared answer is meant to
    // be found — it is the growth loop the phase plan is after — and the
    // workspace chose to publish it.
    robots: { index: true, follow: true },
    openGraph: {
      type: "article",
      title: excerpt(run.prompt, 90),
      description: excerpt(run.finalAnswer, 180),
    },
  }
}

export default async function SharePage({ params }: Params): Promise<ReactElement> {
  const { token } = await params

  // Parsed before it reaches the network: a malformed path segment is a 404
  // here rather than a request the API has to refuse.
  const parsed = shareTokenSchema.safeParse(token)
  if (!parsed.success) notFound()

  const run = await fetchSharedRun(parsed.data)
  if (run === null) notFound()

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-4 px-4">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="inline-block size-2.5 rounded-full bg-accent" aria-hidden="true" />
            Answer Engine
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/sign-up"
              className="text-sm text-accent underline underline-offset-2"
            >
              Ask your own
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl space-y-6 px-4 py-10">
        <div>
          <p className="text-xs text-ink-faint">
            Shared by {run.sharedBy}
            <span aria-hidden="true"> · </span>
            <span title={exactly(run.createdAt)}>{when(run.createdAt)}</span>
          </p>
          <h1 className="mt-2 text-xl font-medium leading-snug text-ink">{run.prompt}</h1>
        </div>

        <Panel>
          <PanelHeader
            title="Answer"
            description={`Merged from ${run.panel.length} model${run.panel.length === 1 ? "" : "s"} answering independently.`}
            actions={<CopyButton value={run.finalAnswer} label="Copy" />}
          />
          <PanelBody>
            <Markdown>{run.finalAnswer}</Markdown>
          </PanelBody>
        </Panel>

        <div className="grid gap-4 sm:grid-cols-2">
          <Panel>
            <PanelHeader title="Where they agreed" />
            <PanelBody>
              {run.agreements.length === 0 ? (
                <p className="text-sm text-ink-faint">Nothing was independently converged on.</p>
              ) : (
                <ul className="space-y-2">
                  {run.agreements.map((item, index) => (
                    <li key={index} className="flex gap-2.5 text-sm text-ink">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Where they disagreed" />
            <PanelBody>
              {run.disagreements.length === 0 ? (
                <p className="text-sm text-ink-faint">No conflicts were found.</p>
              ) : (
                <ul className="space-y-2">
                  {run.disagreements.map((item, index) => (
                    <li key={index} className="flex gap-2.5 text-sm text-ink">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>
        </div>

        <Panel>
          <PanelHeader title="The panel" description="Who answered, and how confident the evaluator was." />
          <PanelBody className="space-y-4">
            <ul className="space-y-2">
              {run.panel.map((member) => (
                <li key={`${member.provider}-${member.model}`} className="flex items-center justify-between gap-3">
                  <ProviderTag provider={member.provider} model={member.model} />
                  <Badge tone={member.status === "OK" ? "success" : "neutral"}>
                    {member.status === "OK" ? "Answered" : "Did not answer"}
                  </Badge>
                </li>
              ))}
            </ul>
            <ConfidenceMeter value={run.confidence} className="max-w-sm" />
          </PanelBody>
        </Panel>

        <p className="border-t border-line pt-6 text-center text-sm text-ink-muted">
          This answer was produced by asking several frontier models the same question and merging
          their strongest parts.{" "}
          <Link href="/sign-up" className="text-accent underline underline-offset-2">
            Ask your own question
          </Link>
          .
        </p>
      </main>
    </div>
  )
}
