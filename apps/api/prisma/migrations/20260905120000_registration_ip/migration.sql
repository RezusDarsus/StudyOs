ALTER TABLE "User" ADD COLUMN "registrationIp" TEXT;
CREATE INDEX "User_registrationIp_idx" ON "User"("registrationIp");
