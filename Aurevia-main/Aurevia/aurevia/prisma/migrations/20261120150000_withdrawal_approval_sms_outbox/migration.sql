CREATE TYPE "WithdrawalApprovalSmsStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'SKIPPED');

CREATE TABLE "WithdrawalApprovalSmsOutbox" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "fundingRequestId" TEXT NOT NULL,
  "reference" VARCHAR(180) NOT NULL,
  "amount" DECIMAL(30,10),
  "feeAmount" DECIMAL(30,10),
  "netAmount" DECIMAL(30,10),
  "currency" VARCHAR(8),
  "netCurrency" VARCHAR(8),
  "dedupeKey" VARCHAR(200) NOT NULL,
  "status" "WithdrawalApprovalSmsStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "providerMessageId" VARCHAR(180),
  "lastErrorCode" VARCHAR(40),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WithdrawalApprovalSmsOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WithdrawalApprovalSmsOutbox_fundingRequestId_key"
  ON "WithdrawalApprovalSmsOutbox"("fundingRequestId");
CREATE UNIQUE INDEX "WithdrawalApprovalSmsOutbox_dedupeKey_key"
  ON "WithdrawalApprovalSmsOutbox"("dedupeKey");
CREATE INDEX "WithdrawalApprovalSmsOutbox_status_nextAttemptAt_createdAt_idx"
  ON "WithdrawalApprovalSmsOutbox"("status", "nextAttemptAt", "createdAt");

ALTER TABLE "WithdrawalApprovalSmsOutbox"
  ADD CONSTRAINT "WithdrawalApprovalSmsOutbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WithdrawalApprovalSmsOutbox"
  ADD CONSTRAINT "WithdrawalApprovalSmsOutbox_fundingRequestId_fkey"
  FOREIGN KEY ("fundingRequestId") REFERENCES "FundingRequest"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WithdrawalApprovalSmsOutbox" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "WithdrawalApprovalSmsOutbox" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE "WithdrawalApprovalSmsOutbox" FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE "WithdrawalApprovalSmsOutbox" FROM authenticated';
    END IF;
END
$$;
