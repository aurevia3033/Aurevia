CREATE TABLE "KycVerificationDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentCountry" VARCHAR(2),
    "documentType" VARCHAR(32),
    "identityDataCiphertext" TEXT,
    "identityDataIv" VARCHAR(24),
    "identityDataAuthTag" VARCHAR(24),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycVerificationDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KycVerificationDraft_userId_key" ON "KycVerificationDraft"("userId");
CREATE INDEX "KycVerificationDraft_updatedAt_idx" ON "KycVerificationDraft"("updatedAt");

ALTER TABLE "KycVerificationDraft"
ADD CONSTRAINT "KycVerificationDraft_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
