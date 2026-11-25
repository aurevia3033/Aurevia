# Project Knowledge Base

## 1. Project overview

Aurevia Exchange is an account-first simulated trading and financial-services application. It combines a Next.js App Router frontend and route-handler backend, PostgreSQL/Prisma persistence, NextAuth JWT authentication, a custom HTTP/Socket.IO server, a double-entry ledger, DEMO/REAL account modes, market display, wallet/funding workflows, KYC, support, administration, news/stories, cards, tax, community finance, and notifications.

The source explicitly states that it does not connect to a live broker, exchange, bank, payment network, or external payout provider. REAL mode in the source is simulated ledger execution unless a separately authorized external integration is later added.

## 2. Technology stack

- Frontend: Next.js 16.4.6 App Router, React 19.3.0, TypeScript
- Styling: Tailwind CSS 4/PostCSS, CSS modules within `app/**/*.css` and `styles/*.css`, a shared theme-token system
- State: React local state, TanStack React Query, Zustand dependency, NextAuth SessionProvider, custom locale/theme contexts
- Charts/visual: Recharts, Lightweight Charts, Three.js, React Three Fiber/Drei, GSAP
- Backend: Next.js route handlers, custom `server.ts` HTTP server
- Realtime: Socket.IO server and client
- Database: PostgreSQL 16 in Docker; Prisma 5.22
- Authentication: NextAuth 4 credentials provider, JWT sessions, optional TOTP, WebAuthn/passkeys, secure session records
- Validation: Zod, server-side manual validation
- Storage: Supabase private buckets and signed URLs
- Integrations: Twelve Data, Finnhub, FMP, Alpha Vantage, Brevo/SMTP, Termii, Akedly, AI providers, browser push, GNews
- Testing: Vitest, Playwright, axe-core, Lighthouse
- Deployment: Docker/Compose, Render Node service, Vercel serverless configuration
- PWA: manifest and service worker

## 3. Complete folder structure

```text
app/                  App Router pages, layouts, loading/error UI, API route handlers
app/api/              HTTP API endpoints grouped by feature
app/admin/            Role-protected administrator pages
components/           Feature, shared, navigation, visual and admin React components
lib/                  Server/client domain modules: auth, ledger, markets, AI, storage, security
prisma/               Prisma schema, migrations and seed
public/               Images, videos, icons, manifest and service worker
styles/               Shared appearance/device/platform CSS
tests/                Unit/API tests, E2E specifications, mocks and route inventory
scripts/              Setup, migrations, cleanup, Lighthouse and Playwright utilities
.github/workflows/    Automated testing and Render deployment workflows
server.ts             Custom Next.js/Socket.IO server and in-process market ticks
```

Important entry points:

- `app/layout.tsx`: root providers, startup shell, theme/locale/bootstrap metadata
- `app/page.tsx`: landing page
- `app/admin/layout.tsx`: admin scope wrapper
- `server.ts`: Next.js, HTTP, Socket.IO, market ticks, live quote polling
- `lib/auth-options.ts`: NextAuth credentials/WebAuthn and session creation
- `lib/auth.ts`: `requireUser` and `requireAdmin` guards
- `lib/db.ts`: shared Prisma client
- `prisma/schema.prisma`: data model
- `next.config.mjs`: CSP, media configuration and build settings

## 4. Page and route inventory

Verified route count: 78 `page.tsx` files, excluding API handlers and special files.

### Public and authentication

| Route | Purpose | Authentication |
|---|---|---|
| `/` | Landing/home experience | Public |
| `/login` | Credential/admin user login | Public |
| `/register` | Account registration | Public |
| `/forgot-password`, `/reset-password` | Password recovery | Public |
| `/auth/akedly/callback` | Akedly verification callback UI | Callback integration |
| `/about`, `/about-me`, `/education`, `/aml-kyc`, `/terms`, `/privacy`, `/risk-disclosure`, `/platform-usage`, `/deposit-withdrawal-policy`, `/legal-centre` | Informational/legal pages | Mostly public; legal centre is account-aware |
| `/waitlist` | Waitlist signup | Public |
| `/stories`, `/client-stories`, `/news`, `/broadcasts`, `/community` | Public content/community feeds | Public/member-aware |

### Customer application

| Route | Purpose | Authentication |
|---|---|---|
| `/dashboard` | Account dashboard, assets, activity and opportunities | USER |
| `/markets` | Live-provider market dashboard | Public/market-aware; AI portions sign-in |
| `/trade` | Trading terminal and order entry | USER |
| `/orders` | Open/history order management | USER |
| `/portfolio` | Positions, allocation and valuation | USER |
| `/wallet` | Wallet balances and funding | USER |
| `/wallet/convert` | BTC conversion experience | USER |
| `/wallet/transactions`, `/wallet/transactions/[id]` | Ledger transaction history/detail | USER |
| `/bank` | Internal bank and statements | USER |
| `/cards`, `/cards/apply`, `/cards/[id]` | Internal card catalog/applications/detail | USER/public catalog behavior varies |
| `/kyc`, `/aml-kyc` | Identity verification submission/status | USER |
| `/tier` | Tier upgrade request/status | USER |
| `/investments` | Investment opportunities/requests | USER |
| `/tax-services`, `/tax-services/request/[id]` | Tax service access and cases | USER |
| `/support` | Support ticket/chat | USER |
| `/notifications` | Notification centre | USER |
| `/activity` | Account activity view | USER |
| `/settings` | Profile, security, preferences and verification | USER |
| `/bank` | Ledger-backed bank experience | USER |

### Administrator

The `/admin` area contains `/admin/login` plus 34 role-protected control pages, including dashboard, users, sessions, audit logs, KYC, funding, settlements, withdrawals, bank, markets, instruments/providers, positions, investments, community, support, tax, cards, payments, stories, broadcasts, news, notices, waitlist, deleted items, and system settings.

Every major admin page imports `requireAdmin` and redirects failures to `/admin/login` at the page layer; mutations additionally use `requireAdmin` in API routes.

## 5. Component inventory

Total top-level component files: 109 plus `components/ui` primitives.

Major global/shared components:

- `Nav`, `AdminNav`, `NotificationBell`, `LanguageSelector`, `ThemeToggle`
- `ProfileAvatar`, `AccountTierBadge`, `AureviaExchangeId`
- `GlobalMarketTicker`, `FloatingSupportChat`, `PwaInstallPrompt`
- `PolicyConsentGate`, `AppearanceBootstrap`, `AppearanceSettings`
- `StatusNotice`, `AureviaLoading`, `StartupShell`, `AureviaStartup`
- `ui/button.tsx`, `ui/card.tsx`, `ui/input.tsx`

Major customer feature components:

- `HomePage`, `UserDashboardExperience`, `DashboardCryptoTrade`
- `LiveMarketDashboard`, `MarketExperience`, `LivePriceChart`, `MarketDepthScene`
- `PortfolioExperience`, `OrdersExperience`, `WalletExperience`
- `KycVerificationCenter`, `SecurityCenter`, `RegistrationExperience`
- `InvestmentExperience`, `SupportExperience`, `StoriesExperience`, `NotificationsExperience`
- `CommunityFinanceExperience`, `BroadcastsExperience`, `WaitlistExperience`
- `WithdrawalDestinationPanel`, `AccountContactVerification`, `BrowserPushSettings`

Major admin components:

- `AdminDashboard`, `AdminUsersPanel`, `AdminKycReviewPanel`, `AdminKycCasesPanel`
- `AdminFundingRecordsPanel`, `AdminOperationsPanel`, `AdminPositionsPanel`
- `AdminStoriesPanel`, `AdminBroadcastsPanel`, `AdminEditorialNewsPanel`
- `AdminSupport`, admin settings, sessions, audit, bank, community, tax, cards, payments

## 6. Feature inventory

Verified from source/test coverage:

- Authentication, password reset, TOTP, WebAuthn, session revocation
- Persistent policy acceptance and role separation
- KYC submission, manual review, encrypted identity fields, private evidence, retention
- DEMO/REAL modes, ledger-backed balances, trades and positions
- Market/limit/stop orders and internal execution
- Wallet, funding, withdrawals, receipts, BTC conversion
- Internal platform bank and simulated cards
- Investments and tier requests
- Stories, news, broadcasts, community finance
- Support, tax services, notifications, browser push
- User/admin appearance, locale and activity preferences
- Admin user, funding, KYC, instrument, audit, deletion and recovery controls

Unverified at runtime: external provider availability, active third-party credentials, migration state, browser UI behavior beyond existing reports, and production configuration.

## 7. Frontend-to-backend mapping

| Feature cluster | Frontend | API | Primary database |
|---|---|---|---|
| Authentication | login/register/reset/settings security | `/api/auth/*`, register/password/security/WebAuthn | User, SecuritySession, TwoFactor*, Recovery, PasswordReset |
| Dashboard | dashboard experience | `/api/dashboard`, `/api/dashboard/overview` | Ledger, Position, Instrument, Investment, Notification |
| Markets/trading | markets/trade/orders/portfolio | market, candles, live-markets, orders, positions | Instrument, Candle, Order, Execution, Position |
| Wallet/funding | wallet pages | wallet, funding, ledger, withdrawal destinations | Ledger*, FundingRequest, WithdrawalDestination |
| KYC | kyc/settings | kyc, verification, documents | KycProfile, KycVerification*, KycDocument |
| Admin | admin components/pages | `/api/admin/*` | Broad shared models and AuditLog |
| Stories/news/community | public/admin panels | stories, news-feed, community | Story*, NewsFeed*, Community* |
| Support/tax/cards | support/tax/cards pages | support, tax-services, cards | Support*, Tax*, Card* |

## 8. API endpoint documentation

There are 190 route-handler files and 268 exported HTTP methods. Method summary: 124 GET, 93 POST, 34 PATCH, 13 DELETE, 4 PUT.

Authoritative route inventory: `tests/api-route-inventory.csv`. It includes route, method, direct test mapping, auth/static hints, validation hints, sensitivity and smoke scope.

Endpoint clusters:

- Account/security: `/api/account/*`, `/api/security/*`, `/api/profile/*`, `/api/settings/*`
- Authentication: `/api/auth/*`, `/api/register`, `/api/password-reset/*`, `/api/webauthn/*`
- Dashboard/content: `/api/dashboard/*`, `/api/activity`, `/api/notifications`, `/api/stories/*`
- Markets: `/api/market/*`, `/api/live-markets/*`, `/api/candles`, `/api/orderbook`
- Trading: `/api/orders`, `/api/positions`, `/api/portfolio/*`
- Financial: `/api/wallet/*`, `/api/ledger`, `/api/funding/*`, `/api/withdrawal-destinations/*`
- Bank/cards: `/api/bank/*`, `/api/cards/*`, `/api/payment-methods`
- KYC: `/api/kyc/*`, `/api/admin/kyc/*`
- Administration: `/api/admin/*`
- Support: `/api/support/*`
- Cron/webhooks: `/api/cron/*`, `/api/webhooks/akedly`
- Preferences: currency, language, locale, theme, policy, push

## 9. Database relationship overview

There are 80 Prisma models. Major aggregates:

- `User` owns security sessions, devices, profile/KYC data, orders, positions, ledger accounts, funding, notifications and audit relations.
- `LedgerTransaction` connects debit/credit `LedgerEntry` records and ledger accounts.
- `Order` and `Execution` drive `Position` lifecycle.
- `FundingRequest` relates to users and dual-approval actor fields.
- `KycVerification` chains submissions, drafts, events, documents and legal-retention archives.
- `SupportConversation` owns messages and attachments.
- `Story` owns categories, media and engagement.
- `TaxCase` owns documents, messages and status events.
- `CommunityLoan` owns installment/payment records.
- `ManagedNotice` relates to versioned legal acceptances.
- `SecuritySession` and `WebAuthnCredential` support authentication controls.

Database access is centralized through `lib/db.ts` with Prisma. Many financial operations use serializable transactions.

## 10. Authentication and authorization architecture

- NextAuth JWT strategy with one configured max age
- Credentials and WebAuthn providers
- `Role.USER` versus `Role.ADMIN`
- `requireUser` and `requireAdmin` enforce session ID, role and current legal acceptance
- Customer routes and APIs reject admins and vice versa
- Security sessions are individually persisted and revocable
- Password/TOTP, recovery codes and reauthentication endpoints exist
- Persistent legal acceptance is checked server-side
- Admin actions use audit logging; some destructive actions are transactionally guarded
- Admin login can provision/adopt a separately configured admin record

## 11. Design system documentation

Themes:

- `forest-green`: dark forest/black/gold default
- `premium-dashboard`: light premium dashboard

Token sources:

- `app/globals.css`
- `app/theme.css`
- `styles/appearance-settings.css`
- `styles/platform-upgrade.css`
- `styles/device-fit.css`
- feature CSS files in `app/**`

Shared elements use `card`, `btn`, `input`, account panels, admin panels and navigation classes. Responsive breakpoints include desktop, tablet and mobile CSS. RTL support is implemented for Arabic and language-specific layouts. Reduced-motion styles and viewport zoom constraints exist.

## 12. User journey documentation

Registration: `/register` -> `/api/register` -> session -> policy gate -> `/dashboard`.

Login: `/login` -> NextAuth credentials/WebAuthn -> session/security record -> role redirect.

Trading: dashboard/trade -> instrument quote -> POST `/api/orders` -> ledger reservation/execution -> position/dashboard update.

Funding: `/wallet` -> funding API -> pending request -> admin approval -> ledger posting -> receipt/history.

KYC: `/kyc` -> draft/submission/document upload -> private storage -> admin review -> Tier promotion.

Support: `/support` -> ticket/message API -> admin support queue -> resolution.

Stories: public feed or member feed -> signed media route -> engagement actions.

## 13. Third-party integrations

- Supabase PostgreSQL/Storage
- Twelve Data/Finnhub/FMP/Alpha Vantage
- Brevo/SMTP
- Termii
- Akedly
- GNews
- OpenAI/OpenRouter/Gemini/Groq-compatible AI gateway
- Web Push/VAPID
- YouTube/Vimeo/MP4 media
- Socket.IO

No live brokerage, bank, custody, payment or payout integration is active in the source.

## 14. Known bugs and incomplete features

Documented source/release items:

- README notes partial migration history and explicitly says some additive migrations have not been applied to production.
- New ERC? No external real-money execution integration is implemented.
- README production hardening list remains unresolved (independent KYC provider, AML/sanctions, real payments, reconciliation, CSRF review, alerting).
- README says passkeys packages are installed but passkeys are not enabled. WebAuthn routes/components do exist, so this statement should be reclassified as deployment/feature verification needed rather than absent code.
- Provider process caches/quotas are not shared across multiple instances.
- Process-local in-memory rate limits are not horizontally distributed.
- Migration and real-credentials states are not known from source alone.

No TODO-style implementation markers were found in a broad source search, but many feature branches remain migration/config dependent.

## 15. Technical debt

- 190 route-handler files and 80 models make a monolithic App Router/Prisma architecture.
- Several broad admin components/pages duplicate navigation and API-fetch patterns.
- API route inventory identifies a large number of routes with static-only test mapping rather than direct valid-payload tests.
- Provider quota state is process-local.
- Custom CSS is split across a large number of global and feature stylesheets.
- Prisma schema and route modules are broad and highly coupled.
- README contains substantial historical migration/deployment status and must be reconciled with schema evolution.

## 16. Performance issues

Potential/verified concerns:

- Custom server runs in-process market and live quote work; horizontal scaling requires coordinated workers/shared Socket.IO adapter.
- 78 pages and 109 top-level components increase bundle/build surface.
- 80 Prisma models and broad route fetches may create N+1 or overfetch risks in untested branches.
- Provider calls are paced per process and may queue independently on multiple instances.
- Large Playwright and report artifacts are present locally/ignored; keep generated output out of source.

## 17. Security concerns

- High: migrate any server-only provider secrets only through deployment secret managers; source `.env.example` contains names only.
- High: retained migration and provider references must be reconciled before migration operations.
- Medium: distributed rate limiting and CSRF/origin hardening remain documented as open production-hardening work.
- Medium: private storage and KYC evidence rely on correct Supabase bucket policies and stable encryption keys.
- Medium: migration history must be verified before destructive or additive schema deployment.
- Medium: AI credential storage and provider calls should remain server-only and audited.
- Low: process-local quota/logging visibility makes multi-instance security operations less reliable.

No secret values were exposed during this audit.

## 18. Recommended improvements

1. Add route-level authorization/contract tests for all financial and KYC mutations.
2. Add an applied-migration reconciliation report.
3. Add distributed rate limiting and CSRF/origin policy.
4. Split broad admin components and route modules into feature services.
5. Add external provider fallback health dashboard and alerting.
6. Add KYC malware scanning and independent provider workflow if enabled for production.
7. Add idempotency keys to all financial POST/PATCH operations.
8. Add database backups/PITR and migration runbooks.
9. Establish API response/error schemas.
10. Add bundle and Lighthouse budgets to CI.

## 19. Important files

- `server.ts`: custom runtime and realtime market engine
- `app/layout.tsx`: global shell/providers
- `lib/auth-options.ts`: authentication
- `lib/auth.ts`: authorization guards
- `prisma/schema.prisma`: database model
- `lib/db.ts`: Prisma connection
- `next.config.mjs`: headers and build configuration
- `Dockerfile`, `docker-compose.yml`, `vercel.json`: deployment
- `tests/api-route-inventory.csv`: API source inventory
- `tests/e2e/`: browser workflows
- `README.md`: operational runbook and release caveats

## 20. Component dependency map

Root providers: `Providers` -> `ThemeProvider`, `LocaleProvider`, `PolicyConsentGate`, `SessionProvider`, `QueryClientProvider`, support/PWA overlays.

Customer navigation: `Nav` -> notification, language, theme, profile, tier, market ticker.

Dashboard: `UserDashboardExperience` -> dashboard APIs, portfolio, wallet, market, activity and investment components.

Trade: `LivePriceChart/MarketExperience/TradingJournalAssistant/DashboardCryptoTrade` -> markets, orders, positions, ledger and market APIs.

Wallet: `WalletExperience/WithdrawalDestinationPanel/BitcoinConversionExperience/ReceiptGenerator` -> wallet, funding, ledger and destination APIs.

KYC: `KycVerificationCenter/CountrySelector` -> KYC verification/document/phone APIs; private Supabase storage.

Admin: `AdminNav`/feature panel -> `/api/admin/*` -> Prisma/Supabase and audit log.
