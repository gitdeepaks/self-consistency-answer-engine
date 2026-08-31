import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactElement } from "react";
import { RunView } from "@/components/run/run-view";
import { isApiRequestError } from "@/lib/api/client";
import { serverApi } from "@/lib/api/server";
import { excerpt } from "@/lib/format";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * The run page.
 *
 * Server-rendered from a single `GET /api/runs/:id`, so the answer is in the
 * HTML rather than appearing after a client round trip — and so a run that is
 * already finished needs no JavaScript at all to be readable. The live stream
 * is layered on top by `RunView` only when there is something still to watch.
 *
 * A run in another tenant answers 404 from the API by design (a 403 would
 * confirm the id exists), and that maps straight onto `notFound()` here — so
 * the web app inherits the isolation property rather than reimplementing it.
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const run = await serverApi()
    .getRun(id)
    .catch(() => null);

  return {
    title: run === null ? "Run" : excerpt(run.prompt, 60),
  };
}

export default async function RunPage({
  params,
}: Params): Promise<ReactElement> {
  const { id } = await params;

  const run = await serverApi()
    .getRun(id)
    .catch((error: unknown) => {
      // A 404 is a missing (or foreign) run and gets the not-found page. Any
      // other failure is this app's problem, not the user's, and is rethrown so
      // the error boundary reports it rather than pretending the run does not
      // exist.
      if (isApiRequestError(error) && error.status === 404) return null;
      throw error;
    });

  if (run === null) notFound();

  return <RunView initialRun={run} />;
}
