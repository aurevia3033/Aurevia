# Aurevia environment readiness review

This review is based on the environment file supplied for this repair. Secret values are deliberately not reproduced.

## Provider and feature readiness

| Feature | Configuration finding | Runtime requirement / next action |
|---|---|---|
| Database | `DATABASE_URL` and `DIRECT_URL` are configured | Do not connect to or migrate production until staging verification is complete. |
| Supabase | Project URL, public key and service-role key are configured | Keep service-role credentials server-only. Verify storage bucket policy in staging. |
| Brevo email | API key and sender identity are configured | Verify sender authorization and perform a staging delivery test. |
| Termii SMS | API key, base URL and sender ID are configured; sender format is valid | Confirm approved sender status and transactional/DND route permissions, then test one staging SMS. |
| Twelve Data | API key and base URL are configured | Confirm plan entitlements and perform read-only quote/candle checks in staging. |
| TOTP | Key is present but is 48 decoded bytes, not 32 | Replace with a dedicated 32-byte Base64 AES-256 key. Existing encrypted TOTP records require a migration or preservation strategy. |
| Withdrawal destinations | Key is present but is 48 decoded bytes, not 32 | Replace only after planning existing ciphertext migration/decryption. |
| Push subscriptions | Key is present but is 48 decoded bytes, not 32 | Replace only after planning existing subscription ciphertext migration/decryption. |
| AI secrets | Key is present but is 48 decoded bytes, not 32 | Replace only after planning existing credential ciphertext migration/decryption. |
| Browser push | VAPID public key, private key and subject are absent | Generate one matching VAPID pair and set all three variables. |
| OpenAI | API key and model variables are configured | The configured model is not in the OpenAI allowlist. Align `OPENAI_MODEL` with `OPENAI_MODEL_ALLOWLIST` using `openai:<model>` entries. |
| First-party KYC | KYC key is a valid 32-byte Base64 key and dedicated storage settings are configured | Verify private bucket, upload, administrator review and retention in staging. |
| External payments | No payment provider credentials or webhook settings are configured | Remain disabled; no external payment provider is implied by unrelated credentials. |
| Staging database | No staging database or direct URL is configured | Provision a separate staging database before migration testing. |

## Key-handling behavior

The application requires AES-256-GCM keys to be valid 32-byte Base64 values. Three of the newly added 48-byte keys are therefore rejected at runtime where their helpers perform strict validation:

- `TOTP_ENCRYPTION_KEY`
- `WITHDRAWAL_DESTINATION_ENCRYPTION_KEY`
- `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`
- `AI_SECRETS_ENCRYPTION_KEY`

`KYC_ENCRYPTION_KEY` is valid at 32 bytes. Do not generate or log replacement production keys in application code.

## Safety boundaries

- No provider accepted a credential, delivered an email/SMS/push, or returned market data during this review.
- No production database, migration, wallet, ledger, account or user record was changed.
- No production deployment or Render environment change was made.
- No encrypted TOTP, push subscription, withdrawal destination or AI credential was migrated or decrypted with replacement values.
