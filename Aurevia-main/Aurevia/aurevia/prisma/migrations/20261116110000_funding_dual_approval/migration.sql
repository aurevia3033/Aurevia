ALTER TABLE "FundingRequest"
    ADD COLUMN "approvalInitiatedById" TEXT,
    ADD COLUMN "completionInitiatedById" TEXT,
    ADD COLUMN "completionProcessingReference" VARCHAR(180);

ALTER TABLE "FundingRequest"
    ADD CONSTRAINT "FundingRequest_approvalInitiatedById_fkey"
        FOREIGN KEY ("approvalInitiatedById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "FundingRequest_completionInitiatedById_fkey"
        FOREIGN KEY ("completionInitiatedById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "FundingRequest_approvalInitiatedById_idx"
    ON "FundingRequest"("approvalInitiatedById");
CREATE INDEX "FundingRequest_completionInitiatedById_idx"
    ON "FundingRequest"("completionInitiatedById");
