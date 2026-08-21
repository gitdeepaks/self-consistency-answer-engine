import {
  candidateReviewSchema,
  type Candidate,
  type CandidateReview,
  type CandidateStatus,
  type ProviderId,
  type Run,
  type RunStatus,
  type RunSummary,
  type Synthesis,
} from "@sce/shared"
import { z } from "zod"
import { prisma } from "./client.ts"
import type { Prisma } from "../generated/client.ts"

/* ------------------------------------------------------------------ types */

type CandidateRow = Awaited<ReturnType<typeof prisma.candidate.findFirstOrThrow>>
type SynthesisRow = Awaited<ReturnType<typeof prisma.synthesis.findFirstOrThrow>>
type RunRow = Awaited<ReturnType<typeof prisma.run.findFirstOrThrow>>

const runInclude = {
  candidates: { orderBy: { createdAt: "asc" } },
  synthesis: true,
} satisfies Prisma.RunInclude

/* --------------------------------------------------------------- mappers */

/** SQLite has no JSON column type, so list fields round-trip as text. */
function parseJson<T>(raw: string, schema: z.ZodType<T>, fallback: T): T {
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

const stringArray = z.array(z.string())
const reviewArray = z.array(candidateReviewSchema)

export function toCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    model: row.model,
    status: row.status as CandidateStatus,
    content: row.content,
    error: row.error,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  }
}

export function toSynthesis(row: SynthesisRow): Synthesis {
  return {
    id: row.id,
    model: row.model,
    finalAnswer: row.finalAnswer,
    agreements: parseJson(row.agreements, stringArray, []),
    disagreements: parseJson(row.disagreements, stringArray, []),
    reviews: parseJson<CandidateReview[]>(row.reviews, reviewArray, []),
    confidence: row.confidence,
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  }
}

export function toRun(
  row: RunRow & { candidates: CandidateRow[]; synthesis: SynthesisRow | null },
): Run {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status as RunStatus,
    error: row.error,
    totalLatencyMs: row.totalLatencyMs,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    candidates: row.candidates.map(toCandidate),
    synthesis: row.synthesis ? toSynthesis(row.synthesis) : null,
  }
}

/* ------------------------------------------------------------- mutations */

export interface CandidateSeed {
  provider: ProviderId
  label: string
  model: string
  status: CandidateStatus
  error?: string | null
}

export async function createRun(input: {
  prompt: string
  temperature?: number
  candidates: CandidateSeed[]
}): Promise<Run> {
  const row = await prisma.run.create({
    data: {
      prompt: input.prompt,
      temperature: input.temperature ?? null,
      status: "PENDING",
      candidates: {
        create: input.candidates.map((c) => ({
          provider: c.provider,
          label: c.label,
          model: c.model,
          status: c.status,
          error: c.error ?? null,
        })),
      },
    },
    include: runInclude,
  })
  return toRun(row)
}

export async function setRunStatus(runId: string, status: RunStatus): Promise<void> {
  await prisma.run.update({ where: { id: runId }, data: { status } })
}

export async function setCandidateRunning(candidateId: string): Promise<Candidate> {
  const row = await prisma.candidate.update({
    where: { id: candidateId },
    data: { status: "RUNNING" },
  })
  return toCandidate(row)
}

export async function settleCandidate(
  candidateId: string,
  result:
    | {
        status: "OK"
        content: string
        latencyMs: number
        inputTokens: number | null
        outputTokens: number | null
      }
    | { status: "ERROR"; error: string; latencyMs: number },
): Promise<Candidate> {
  const data =
    result.status === "OK"
      ? {
          status: "OK",
          content: result.content,
          error: null,
          latencyMs: result.latencyMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }
      : { status: "ERROR", error: result.error, latencyMs: result.latencyMs }

  const row = await prisma.candidate.update({ where: { id: candidateId }, data })
  return toCandidate(row)
}

export async function saveSynthesis(
  runId: string,
  input: {
    model: string
    finalAnswer: string
    agreements: string[]
    disagreements: string[]
    reviews: CandidateReview[]
    confidence: number
    latencyMs: number
    inputTokens: number | null
    outputTokens: number | null
  },
): Promise<Synthesis> {
  const payload = {
    model: input.model,
    finalAnswer: input.finalAnswer,
    agreements: JSON.stringify(input.agreements),
    disagreements: JSON.stringify(input.disagreements),
    reviews: JSON.stringify(input.reviews),
    confidence: input.confidence,
    latencyMs: input.latencyMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }
  const row = await prisma.synthesis.upsert({
    where: { runId },
    create: { runId, ...payload },
    update: payload,
  })
  return toSynthesis(row)
}

export async function completeRun(runId: string, totalLatencyMs: number): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: { status: "COMPLETE", totalLatencyMs, completedAt: new Date(), error: null },
  })
}

export async function failRun(runId: string, error: string): Promise<void> {
  await prisma.run.update({
    where: { id: runId },
    data: { status: "FAILED", error, completedAt: new Date() },
  })
}

export async function deleteRun(runId: string): Promise<boolean> {
  const { count } = await prisma.run.deleteMany({ where: { id: runId } })
  return count > 0
}

/* --------------------------------------------------------------- queries */

export async function getRun(runId: string): Promise<Run | null> {
  const row = await prisma.run.findUnique({ where: { id: runId }, include: runInclude })
  return row ? toRun(row) : null
}

export async function listRuns(options: {
  limit: number
  cursor?: string
}): Promise<{ items: RunSummary[]; nextCursor: string | null }> {
  const rows = await prisma.run.findMany({
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { candidates: true } }, synthesis: { select: { id: true } } },
  })

  const page = rows.slice(0, options.limit)
  const nextCursor = rows.length > options.limit ? (page.at(-1)?.id ?? null) : null

  return {
    items: page.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      status: row.status as RunStatus,
      error: row.error,
      totalLatencyMs: row.totalLatencyMs,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      candidateCount: row._count.candidates,
      hasSynthesis: row.synthesis !== null,
    })),
    nextCursor,
  }
}

export async function countRuns(): Promise<number> {
  return prisma.run.count()
}
