# Upgrade Impact Map

## Authentication and sessions

Affected:

- `lib/auth-options.ts`
- `lib/auth.ts`
- `lib/auth-session.ts`
- `app/api/auth/[...nextauth]/route.ts`
- `app/login/page.tsx`
- `app/admin/login/page.tsx`
- `components/RegistrationExperience.tsx`
- `components/SecurityCenter.tsx`
- `components/WebAuthnLogin.tsx`
- `app/layout.tsx`

Database: `User`, `SecuritySession`, `TwoFactorEnrollment`, `SecurityRecoveryCode`, `PasswordResetToken`, `AuditLog`, `WebAuthn*`.

Risks: JWT compatibility, role separation, active-session validation, legal acceptance, existing password/TOTP/WebAuthn state.

Testing: login/logout, refresh, admin/user separation, session revocation, password reset, TOTP/WebAuthn and policy gate.

## Dashboard

Affected: `app/dashboard/page.tsx`, `components/UserDashboardExperience.tsx`, `components/DashboardCryptoTrade.tsx`, `lib/dashboard-data.ts`, `/api/dashboard*`, `/api/activity`.

Database: ledger, positions, instruments, investments, notifications and user fields.

Risks: mode isolation, stale values, P&L accuracy, unauthorized account data.

Testing: DEMO/REAL isolation, empty/loading/error states, refresh, mobile/desktop rendering.

## Trading and execution

Affected:

- `app/trade/page.tsx`
- `app/orders/page.tsx`
- `app/portfolio/page.tsx`
- market/trading components
- `lib/market.ts`
- `lib/trading-policy.ts`
- `lib/real-order-execution.ts`
- `lib/real-order-placement.ts`
- `app/api/orders/route.ts`
- `app/api/positions/route.ts`
- `app/api/orderbook/route.ts`
- `server.ts`

Database: `Instrument`, `Candle`, `Order`, `Execution`, `Position`, `LedgerAccount`, `LedgerTransaction`, `LedgerEntry`.

Risks: financial correctness, serializable transaction behavior, margin reservation, REAL/DEMO separation, quote freshness.

Testing: market/limit/stop triggers, cancellation, close, insufficient funds, partial failures, P&L and ledger invariant.

## Wallet and funding

Affected: `app/wallet/**/*`, wallet components, `lib/ledger.ts`, `lib/funding-evidence.ts`, wallet/funding API routes and admin funding routes.

Database: `Ledger*`, `FundingRequest`, `PaymentMethod`, `WithdrawalDestination*`.

Risks: double-entry imbalance, duplicate approval, pending-withdrawal reservations, exact approved amounts and account mode isolation.

Testing: deposits, cancellations, approval, settlement, rejection, receipt, balance, display currency and replay attempts.

## KYC and identity

Affected: `app/kyc/page.tsx`, `components/KycVerificationCenter.tsx`, `components/AdminKyc*.tsx`, `lib/kyc*.ts`, `/api/kyc/*`, `/api/admin/kyc/*`.

Database: `KycProfile`, `KycVerification*`, `KycDocument`, retention/archive models.

Risks: encrypted identity data, private storage, evidence lifecycle, retention, legal holds, tier promotion.

Testing: upload validation, resubmission, approval/rejection, evidence preview, retention, archive and legal hold.

## Admin user management

Affected: `app/admin/users/page.tsx`, `components/AdminUsersPanel.tsx`, `lib/account-deletion.ts`, `/api/admin/users*`, `/api/account/delete/route.ts`.

Database: `User`, `Ledger*`, `FundingRequest`, `Kyc*`, `Support*`, `AuditLog`.

Risks: permanent deletion, frozen accounts, forced deletion, storage cleanup and audit retention.

Testing: freeze, role changes, account deletion guards, force deletion and private-storage cleanup.

## Stories and content

Affected: `/stories`, `/client-stories`, `/admin/stories`, `/admin/content`, story/client components, story/client/lib modules and API routes.

Database: `Story*`, `ClientStory`, `StoryEngagement`, `StoryCategory`.

Risks: public visibility, publication timing, private signed media, visitor dedupe and delete/restore.

Testing: public/member-only access, expired/scheduled content, media signing, engagement and admin audit.

## Market data providers

Affected: `lib/market-data-service.ts`, provider adapters/manager, `server.ts`, `/api/live-markets/*`, `/api/market/*`, admin providers page.

Database: `Instrument` and cache/provider status is mostly external/process state.

Risks: licensing, stale data, quota pacing, unsupported assets, provider fallback and cross-instance cache.

Testing: unavailable provider, quota failure, stale quote, REAL quote rejection, multi-provider fallback.

## Theme and localization

Affected: `app/layout.tsx`, `lib/theme*`, `lib/i18n*`, `components/AppearanceSettings.tsx`, theme/CSS files and preference API routes.

Database: user theme/locale/display-currency fields and preference records.

Risks: SSR hydration mismatch, RTL layout, persisted anonymous/account preferences and browser zoom.

Testing: both themes, all locales, RTL, refresh, account change, mobile/tablet/desktop.

## Deployment and runtime

Affected: `server.ts`, `next.config.mjs`, `Dockerfile`, `docker-compose.yml`, `vercel.json`, `.github/workflows/deploy-render.yml`, environment configuration and cron scripts.

Database: migration state and external database availability.

Risks: serverless versus persistent Socket.IO, HTTPS origin validation, Cron secrets, migration application, provider credentials and scaling.

Testing: build, health, isolated E2E, migration review, Render/Vercel mode, WebSocket and cron behavior.

## Substantial upgrade gate

Before implementation, document:

1. What changes and why.
2. Exact frontend, backend, API and database files.
3. New files required.
4. Dependencies/integrations.
5. Security and backward-compatibility risks.
6. Migration needs.
7. Focused tests and verification plan.
