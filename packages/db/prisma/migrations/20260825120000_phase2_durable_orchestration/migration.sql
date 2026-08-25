-- Phase 2 — durable orchestration and scale-out.
--
-- Purely additive (expand half of expand/contract): every column is nullable or
-- defaulted and every enum change is an addition, so the previous release keeps
-- running against this schema and a rollback is a real option rather than a
-- hope. Nothing is dropped here; the contract half belongs to a later release
-- once no deployed build reads the old shape.

-- AlterEnum: QUEUED distinguishes "row written" from "job accepted by the
-- queue"; CANCELED gives cancellation a terminal state of its own instead of
-- overloading FAILED.
ALTER TYPE "RunStatus" ADD VALUE 'QUEUED';
ALTER TYPE "RunStatus" ADD VALUE 'CANCELED';

-- AlterEnum
ALTER TYPE "CandidateStatus" ADD VALUE 'CANCELED';

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "canceledAt" TIMESTAMP(3),
ADD COLUMN     "deadlineAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "maxCostMicroCents" BIGINT,
ADD COLUMN     "maxTotalTokens" INTEGER;

-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: the reaper scans for runs past their deadline that no worker
-- finished — a partial-ordered scan, not a table sweep.
CREATE INDEX "Run_status_deadlineAt_idx" ON "Run"("status", "deadlineAt");

-- CreateIndex: idempotency is enforced by the database, not by a read-then-write
-- race in application code. NULLs do not collide in Postgres, so runs created
-- without a key are unaffected.
CREATE UNIQUE INDEX "Run_tenantId_idempotencyKey_key" ON "Run"("tenantId", "idempotencyKey");
