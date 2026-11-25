CREATE TABLE "AccountContactVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "contact" VARCHAR(254) NOT NULL,
    "accountContactAtRequest" VARCHAR(254),
    "codeHash" TEXT NOT NULL,
    "providerReference" VARCHAR(255),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAfter" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountContactVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountContactVerification_userId_channel_key" ON "AccountContactVerification"("userId", "channel");
CREATE INDEX "AccountContactVerification_expiresAt_idx" ON "AccountContactVerification"("expiresAt");
CREATE INDEX "AccountContactVerification_providerReference_idx" ON "AccountContactVerification"("providerReference");

ALTER TABLE "AccountContactVerification"
ADD CONSTRAINT "AccountContactVerification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AccountContactVerification" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "AccountContactVerification" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE "AccountContactVerification" FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE "AccountContactVerification" FROM authenticated';
    END IF;
END
$$;
