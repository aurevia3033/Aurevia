CREATE TABLE "InvestmentOpportunityRecipient" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestmentOpportunityRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvestmentOpportunityRecipient_opportunityId_userId_key"
ON "InvestmentOpportunityRecipient"("opportunityId", "userId");

CREATE INDEX "InvestmentOpportunityRecipient_userId_sentAt_idx"
ON "InvestmentOpportunityRecipient"("userId", "sentAt");

ALTER TABLE "InvestmentOpportunityRecipient"
ADD CONSTRAINT "InvestmentOpportunityRecipient_opportunityId_fkey"
FOREIGN KEY ("opportunityId") REFERENCES "InvestmentOpportunity"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvestmentOpportunityRecipient"
ADD CONSTRAINT "InvestmentOpportunityRecipient_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "InvestmentOpportunity_status_maturesAt_idx"
ON "InvestmentOpportunity"("status", "maturesAt");
