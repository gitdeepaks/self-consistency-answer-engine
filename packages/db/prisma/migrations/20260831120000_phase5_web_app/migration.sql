-- Phase 5 — the web application.
--
-- Additive only: two tables, two enums, one column, three audit actions and
-- four indexes. Nothing existing is altered or dropped, so the previous release
-- runs unchanged against this schema and a rollback needs no down-migration —
-- the old code simply never reads the new columns.
--
-- Expand/contract, as Phase 8's deploy pipeline requires: `Run.tags` arrives
-- with a default rather than as a column a later migration would have to
-- backfill and tighten. Adding a column with a non-volatile default is a
-- catalogue-only change in Postgres 11+, so this does not rewrite `Run` and
-- takes only a brief ACCESS EXCLUSIVE lock regardless of table size.
--
-- One prerequisite: `pg_trgm` at the bottom of this file needs the extension to
-- be installable by the migration role. It is available by default on every
-- managed Postgres this project targets (Fly, RDS, Neon, Supabase); on a
-- locked-down instance, have an operator run the CREATE EXTENSION once as
-- superuser and this migration becomes a no-op for that statement.

-- CreateEnum
CREATE TYPE "FeedbackRating" AS ENUM ('up', 'down');

-- CreateEnum
CREATE TYPE "FeedbackReason" AS ENUM ('incorrect', 'incomplete', 'off_topic', 'unsafe', 'formatting', 'other');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'RUN_SHARED';
ALTER TYPE "AuditAction" ADD VALUE 'RUN_SHARE_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE 'DLQ_REPLAYED';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "RunShare" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" "FeedbackRating" NOT NULL,
    "reason" "FeedbackReason",
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunShare_token_key" ON "RunShare"("token");

-- CreateIndex
CREATE INDEX "RunShare_tenantId_createdAt_idx" ON "RunShare"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RunShare_runId_idx" ON "RunShare"("runId");

-- CreateIndex
CREATE INDEX "RunFeedback_tenantId_createdAt_idx" ON "RunFeedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RunFeedback_tenantId_rating_createdAt_idx" ON "RunFeedback"("tenantId", "rating", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunFeedback_runId_userId_key" ON "RunFeedback"("runId", "userId");

-- CreateIndex
CREATE INDEX "Run_tags_idx" ON "Run" USING GIN ("tags");

-- AddForeignKey
ALTER TABLE "RunShare" ADD CONSTRAINT "RunShare_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunShare" ADD CONSTRAINT "RunShare_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunShare" ADD CONSTRAINT "RunShare_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunFeedback" ADD CONSTRAINT "RunFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text-ish search over prompts and answers.
--
-- `GET /api/runs?q=` matches case-insensitively against `Run.prompt` and the
-- inline `Synthesis.finalAnswer`, which Prisma compiles to `ILIKE '%…%'`. A
-- leading wildcard makes a B-tree index useless, so the trigram operator class
-- is what turns that predicate from a sequential scan into an index scan.
--
-- Chosen over a `tsvector` column deliberately: `to_tsvector` needs a stored,
-- trigger-maintained column plus a language choice per tenant, and it answers a
-- different question — stemmed word matching rather than substring. People
-- searching their own history look for fragments they half-remember ("kuber",
-- "postgres conn"), which is what trigram matching is actually good at.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Run_prompt_trgm_idx" ON "Run" USING GIN ("prompt" gin_trgm_ops);

CREATE INDEX "Synthesis_finalAnswer_trgm_idx" ON "Synthesis" USING GIN ("finalAnswer" gin_trgm_ops);
