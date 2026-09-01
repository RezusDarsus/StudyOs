-- Stage 4: capability execution audit + idempotency records.
-- Additive only: one new table, its foreign key and its indexes. No existing
-- table or column is touched.

-- CreateTable
CREATE TABLE "CapabilityExecution" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "targetRefs" TEXT NOT NULL DEFAULT '[]',
    "confirmation" TEXT NOT NULL DEFAULT 'none',
    "errorCode" TEXT,
    "resultSummary" TEXT NOT NULL DEFAULT '{}',
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapabilityExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityExecution_userId_capability_operationId_key" ON "CapabilityExecution"("userId", "capability", "operationId");
CREATE INDEX "CapabilityExecution_userId_capability_createdAt_idx" ON "CapabilityExecution"("userId", "capability", "createdAt");
CREATE INDEX "CapabilityExecution_createdAt_idx" ON "CapabilityExecution"("createdAt");

-- AddForeignKey
ALTER TABLE "CapabilityExecution" ADD CONSTRAINT "CapabilityExecution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
