-- AlterTable: interview revision counter for stale generate-request detection
ALTER TABLE "CopilotSession" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
