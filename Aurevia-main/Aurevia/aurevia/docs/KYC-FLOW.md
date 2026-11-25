# KYC flow — capture → admin review → user approval

## User journey (`/kyc`)

1. REAL account only (DEMO uses practice mode without identity KYC).
2. Enter identity details and consent.
3. Capture evidence with **professional camera**:
   - Document front / back (environment camera, corner guides)
   - Selfie (user camera, face oval guide, mirrored preview)
   - Progressive resolution fallbacks if high-res fails
   - Efficient JPEG (detail preserved, size capped for upload)
4. Submit → case stored as `PENDING_REVIEW` with encrypted identity + documents.
5. User notified of status changes.

## Admin journey (`/admin/kyc`)

1. Queue: filter by status, country, risk, reviewer, dates.
2. Assign case to self.
3. Review documents (signed private URLs) + identity.
4. Decisions:
   - **APPROVE** — verification `APPROVED`, documents `APPROVED`, user `kycStatus=APPROVED`, `verifiedAt=now`, tier sync / Tier-3 promotion when eligible, notification + email outbox.
   - **REJECT** — reason required.
   - **RESUBMISSION_REQUIRED** — specific documents.
   - **ESCALATE** — internal note.

## Camera / efficiency

- `app/kyc-camera.css` — guides, scan line, mobile layout, reduced motion
- `KycVerificationCenter` — progressive `getUserMedia`, high-quality capture, blur/too-dark guard
- File validation via `lib/kyc-client-validation.ts`

## APIs

| Route | Role |
|-------|------|
| `POST /api/kyc/verification` | User submit |
| `GET/POST /api/kyc/documents` | Evidence |
| `GET /api/admin/kyc/verifications` | Admin queue |
| `PATCH /api/admin/kyc/verifications/[id]` | Admin decision |
