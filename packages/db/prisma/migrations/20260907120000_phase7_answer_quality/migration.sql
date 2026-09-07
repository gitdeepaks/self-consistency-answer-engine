-- Phase 7 — answer quality and evaluation.
--
-- Additive, with one exception that is called out below. Nothing is dropped and
-- no column changes type, so the previous release runs unchanged against this
-- schema: it simply never writes the new columns, and every one of them is
-- nullable or defaulted. That is the expand half of expand/contract, and it is
-- what makes a rollback of the application a rollback rather than an outage.
--
-- What the columns are for:
--
--   Run.promptSetId            which wording produced this answer
--   Run.panelId / experimentId / variantId
--                              which panel produced it, and which arm of which
--                              experiment chose that panel
--   Run.cacheKey / cacheScope / promptSimhash / cachedFromRunId
--                              the answer cache: exact match, near-duplicate
--                              scope, fingerprint, and attribution on a hit
--   Candidate.sample           which sample of a member this row is
--   Synthesis.calibratedConfidence / calibrationId
--                              the corrected confidence, beside the raw one
--   RunFeedback.triage*        the eval triage queue
--
-- The exception: `Candidate_runId_provider_key` is dropped. It made n-of-1
-- self-consistency — the same model asked the same question several times —
-- unrepresentable, and that configuration is precisely the single-model
-- baseline the product's central claim has to be measured against. Dropping a
-- unique constraint never invalidates existing rows, and `[runId, position]`
-- still orders the panel.

-- CreateEnum
CREATE TYPE "FeedbackTriageStatus" AS ENUM ('open', 'accepted', 'dismissed', 'promoted');

-- AlterTable
ALTER TABLE "Run"
    ADD COLUMN "promptSetId" TEXT,
    ADD COLUMN "panelId" TEXT,
    ADD COLUMN "experimentId" TEXT,
    ADD COLUMN "variantId" TEXT,
    ADD COLUMN "cacheKey" TEXT,
    ADD COLUMN "cacheScope" TEXT,
    ADD COLUMN "promptSimhash" TEXT,
    ADD COLUMN "cachedFromRunId" TEXT;

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "sample" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Synthesis"
    ADD COLUMN "calibratedConfidence" DOUBLE PRECISION,
    ADD COLUMN "calibrationId" TEXT;

-- AlterTable
ALTER TABLE "RunFeedback"
    ADD COLUMN "triageStatus" "FeedbackTriageStatus" NOT NULL DEFAULT 'open',
    ADD COLUMN "triagedAt" TIMESTAMP(3),
    ADD COLUMN "triagedByUserId" TEXT,
    ADD COLUMN "triageNote" TEXT;

-- DropIndex
-- One candidate per provider per run. See the note at the top of this file: the
-- constraint made the single-model baseline impossible to express.
DROP INDEX IF EXISTS "Candidate_runId_provider_key";

-- CreateIndex
-- The exact-match cache lookup. Tenant-leading like every other index in this
-- schema, so a cache hit cannot cross a workspace boundary even if the
-- application forgot the filter.
CREATE INDEX "Run_tenantId_cacheKey_createdAt_idx" ON "Run"("tenantId", "cacheKey", "createdAt");

-- CreateIndex
-- The near-duplicate search: recent runs of the same panel, whose 64-bit
-- fingerprints are then compared in the application.
CREATE INDEX "Run_tenantId_cacheScope_createdAt_idx" ON "Run"("tenantId", "cacheScope", "createdAt");

-- CreateIndex
-- Experiment reporting: every run in one arm, newest first.
CREATE INDEX "Run_tenantId_experimentId_variantId_createdAt_idx" ON "Run"("tenantId", "experimentId", "variantId", "createdAt");

-- CreateIndex
-- The triage queue somebody actually works through.
CREATE INDEX "RunFeedback_tenantId_triageStatus_createdAt_idx" ON "RunFeedback"("tenantId", "triageStatus", "createdAt");

-- AddForeignKey
-- The reviewer, who is deliberately not the reporter. `SET NULL` rather than
-- `CASCADE`: a reviewer leaving the company must not delete the triage
-- decisions they made, which are part of the eval set's provenance.
ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_triagedByUserId_fkey" FOREIGN KEY ("triagedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
