-- Stage 2: durable recommendation history.
-- Additive only: one new table, its foreign keys and its indexes. No existing
-- table or column is touched.

-- CreateTable
CREATE TABLE "RecommendationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT,
    "entityType" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "attribution" TEXT,
    "identityKey" TEXT NOT NULL,
    "eventKind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "requestId" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" SERIAL NOT NULL,
    "supersedesEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationEvent_seq_key" ON "RecommendationEvent"("seq");
CREATE UNIQUE INDEX "RecommendationEvent_userId_requestId_key" ON "RecommendationEvent"("userId", "requestId");
CREATE INDEX "RecommendationEvent_userId_identityKey_idx" ON "RecommendationEvent"("userId", "identityKey");
CREATE INDEX "RecommendationEvent_userId_seq_idx" ON "RecommendationEvent"("userId", "seq");
CREATE INDEX "RecommendationEvent_goalId_idx" ON "RecommendationEvent"("goalId");

-- AddForeignKey
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
