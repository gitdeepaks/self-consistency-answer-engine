import type { Metadata } from "next"
import { notFound } from "next/navigation"
import type { ReactElement } from "react"
import { AdminConsole } from "@/components/admin/console"
import { serverApi } from "@/lib/api/server"
import { currentViewer } from "@/lib/session"

export const metadata: Metadata = { title: "Operations" }

/**
 * The operations console.
 *
 * Guarded twice, on purpose. The API refuses every `/api/admin/*` route with a
 * 404 for anyone not on the install's operator list, and this page checks the
 * same fact before rendering. The API's check is the one that *matters* — it is
 * the one an attacker has to get past — and this one exists so a non-operator
 * who guesses the URL gets the not-found page rather than a console skeleton
 * that fails to load its data.
 */
export default async function AdminPage(): Promise<ReactElement> {
  const viewer = await currentViewer()
  if (!viewer.isOperator) notFound()

  const overview = await serverApi()
    .adminOverview()
    .catch(() => null)

  // A viewer who passed the operator check but whose overview failed is looking
  // at a broken install, not a permissions problem — and the console is exactly
  // the page they need. But without the first payload there is nothing to
  // render, so this falls through to the not-found rather than a blank shell.
  if (overview === null) notFound()

  return <AdminConsole initial={overview} />
}
