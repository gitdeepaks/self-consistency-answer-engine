-- Phase 6 — the public API and SDK.
--
-- Additive only: three tables, two enums, three audit actions and seven
-- indexes. Nothing existing is altered or dropped, so the previous release runs
-- unchanged against this schema and a rollback needs no down-migration — the
-- old code simply never reads the new tables. That is the expand half of the
-- expand/contract discipline the deploy pipeline depends on.
--
-- The three tables are the storage behind the three promises `/v1` makes that
-- `/api` never did:
--
--   WebhookEndpoint    a customer can be told when a run finishes, instead of
--                      polling for it;
--   WebhookDispatch    and can find out afterwards what we tried to send, and
--                      what their server said back;
--   IdempotencyRecord  and can retry any POST without paying for it twice.

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_FLIGHT', 'COMPLETED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_ENDPOINT_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'WEBHOOK_REPLAYED';

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDispatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'IN_FLIGHT',
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_createdAt_idx" ON "WebhookEndpoint"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_createdByUserId_idx" ON "WebhookEndpoint"("createdByUserId");

-- CreateIndex
CREATE INDEX "WebhookDispatch_tenantId_createdAt_idx" ON "WebhookDispatch"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDispatch_endpointId_createdAt_idx" ON "WebhookDispatch"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDispatch_status_nextAttemptAt_idx" ON "WebhookDispatch"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDispatch_endpointId_eventId_key" ON "WebhookDispatch"("endpointId", "eventId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_endpoint_key_key" ON "IdempotencyRecord"("tenantId", "endpoint", "key");

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDispatch" ADD CONSTRAINT "WebhookDispatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDispatch" ADD CONSTRAINT "WebhookDispatch_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
