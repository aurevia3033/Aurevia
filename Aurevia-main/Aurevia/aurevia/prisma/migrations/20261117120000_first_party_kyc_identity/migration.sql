ALTER TABLE "KycVerification"
    ADD COLUMN "identityDataCiphertext" TEXT,
    ADD COLUMN "identityDataIv" VARCHAR(24),
    ADD COLUMN "identityDataAuthTag" VARCHAR(24);

DO $$
DECLARE
    configured_limit BIGINT;
BEGIN
    SELECT file_size_limit
      INTO configured_limit
      FROM storage.buckets
     WHERE id = 'kyc-documents'
       AND public = FALSE;

    IF configured_limit IS NULL THEN
        RAISE EXCEPTION 'The existing private kyc-documents bucket is required.';
    ELSIF configured_limit = 10485760 THEN
        UPDATE storage.buckets
           SET file_size_limit = 15728640
         WHERE id = 'kyc-documents'
           AND public = FALSE;
    ELSIF configured_limit <> 15728640 THEN
        RAISE EXCEPTION 'The private kyc-documents bucket has an unexpected size limit.';
    END IF;
END $$;
