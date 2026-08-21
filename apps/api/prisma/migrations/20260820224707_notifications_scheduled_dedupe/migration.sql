-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "localDate" TEXT;

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "eveningTime" TEXT NOT NULL DEFAULT '20:30',
ADD COLUMN     "morningTime" TEXT NOT NULL DEFAULT '08:00',
ADD COLUMN     "notifyEveningCheck" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyMorningSummary" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

