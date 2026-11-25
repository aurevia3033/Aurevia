ALTER TABLE "User"
ADD COLUMN "profileDetailsLastEditedAt" TIMESTAMP(3);

UPDATE "User"
SET "profileDetailsLastEditedAt" = COALESCE("verifiedAt", "createdAt")
WHERE length(btrim(COALESCE("name", ''))) >= 2
  AND length(btrim(COALESCE("country", ''))) >= 2;
