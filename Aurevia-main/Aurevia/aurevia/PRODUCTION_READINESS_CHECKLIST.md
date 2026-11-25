# Production Readiness Checklist

## Verified

- [x] Working tree inspected.
- [x] Required repository documentation inspected.
- [x] TypeScript passed.
- [x] ESLint passed.
- [x] Vitest passed.
- [x] Production build passed.
- [x] Prisma schema valid.
- [x] Migration history and configured database status checked.
- [x] Decimal ledger and serializable financial transaction paths retained.
- [x] DEMO/REAL separation retained.
- [x] Origin/request-size mutation boundary implemented.
- [x] Funding and order idempotency paths retained.

## Manual approval required

- [ ] Approve production migration deployment.
- [ ] Approve provider credential availability.
- [ ] Approve backup retention and restore ownership.
- [ ] Approve KYC review process and retention policy.
- [ ] Approve externally confirmed payout procedures.
- [ ] Approve real account and role administration.

## Deployment requirements

1. Back up production with `npm run db:backup`.
2. Deploy migrations with `npm run db:migrate` only after review.
3. Set `ALLOWED_APP_ORIGINS` to exact HTTPS origins.
4. Configure secrets from `.env.example`.
5. Verify health routes and provider status.
6. Run isolated smoke and accessibility checks.
7. Restore a backup into a separate database and reconcile counts before production use.
