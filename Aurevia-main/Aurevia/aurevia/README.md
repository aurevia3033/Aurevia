# Aurevia Exchange

Aurevia Exchange is a Next.js application using TypeScript, PostgreSQL, Prisma, NextAuth, Socket.IO, Zustand, Tailwind CSS, Recharts and Lightweight Charts. Trading and market prices used by the trading engine remain internal simulations; the `/markets` dashboard separately displays live-provider quotes and history. This repository does not connect to a live broker, exchange, bank, or payment network.

## What is implemented

### User application
- Landing page, registration and credential login
- JWT sessions with USER/ADMIN role enforcement
- First-party Aurevia Verify identity submissions, encrypted identity details, private evidence storage, manual administrator review, and historical KYC compatibility
- Profile and account settings, including password-confirmed account deletion
- Optional authenticator settings, one-time recovery codes, and per-device session controls
- Live dashboard with cash equity and open positions
- Realtime market ticker
- Trading terminal with Market, Limit and Stop orders
- Simulated order book and realtime candles/price chart
- Open-order cancellation
- One-click position close
- Unrealized P&L display
- Wallet balance from the ledger
- Deposit and withdrawal requests
- Funding history
- Public Stories feed and fullscreen image/video viewer, available without signing in

### Aurevia Verify

The `/kyc` verification centre accepts legal name, date of birth, issuing country, enabled document type, expiry date where required, private front/back identity images, a camera-captured selfie, and recorded consent. The enabled document types are passport, national identity card, driving licence and residence permit; “other” remains disabled until its requirements are reviewed. Server-side checks verify file signatures, MIME/extension agreement, decodability, dimensions, expiry information and upload limits before storing new evidence in the private `kyc-evidence` bucket using dedicated KYC Storage credentials. Existing evidence in the private `kyc-documents` bucket remains accessible. Identity fields are encrypted with AES-256-GCM before database storage. New cases enter administrator review; the admin queue supports filters, assignment, private short-lived evidence previews, identity-detail access audit history, approval, rejection, resubmission and escalation.

OCR, MRZ, document-authenticity checks, cross-account duplicate matching, face matching and presentation-attack/liveness analysis are not configured. Their assessment outcomes are explicitly `NOT_AVAILABLE`, and cases require human review. Exact duplicate evidence sets from the same user are rejected, but this is not identity matching. Camera capture alone is not represented as liveness. An authorized approval updates identity status transactionally; Tier 3 is automatically granted only when the existing REAL-mode profile, residential-address and approved-proof-of-address conditions also pass. The approval flow never modifies wallet funds. Email notifications use the existing retryable KYC outbox.

The internal workflow is controlled by `AUREVIA_KYC_ENGINE=internal` and `AUREVIA_KYC_ENABLED=true`. Set `KYC_ENCRYPTION_KEY` to a stable, server-only 32-byte Base64 key before accepting new identity submissions; do not generate or log a production key in application code. `KYC_MAX_DOCUMENT_SIZE_MB` defaults to 15 and accepts integer values from 1 through 15. New evidence uses the private `kyc-evidence` bucket configured by `KYC_SUPABASE_URL` and `KYC_SUPABASE_SERVICE_ROLE_KEY`; the bucket must already exist and remain private. Existing `kyc-documents` evidence continues to use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. No external identity-verification provider is connected. No worker URL or provider signing secret is used: integrity checks run synchronously, and manual decisions require authenticated admin sessions.

First-party KYC evidence is eligible for automated deletion 90 days after an approval or rejection. Evidence from resubmission cases remains available until the final decision, then follows the same 90-day period. Open cases and cases with an administrator-recorded legal hold are not purged. The retention worker deletes private objects before removing document rows, records a pseudonymized decision/audit archive, retries cleanup failures, and removes that archive seven years after the final decision unless it is on legal hold. The admin KYC operations centre can search archived case IDs and place or release documented legal holds. A hold placed on an archived record prevents further metadata deletion but cannot restore evidence already purged. The scheduled endpoint is `GET /api/cron/kyc-evidence-retention` and requires the existing `CRON_SECRET` bearer token. The existing Render `scripts/push-delivery-cron.mjs` runner now calls it alongside push and KYC email delivery, using the existing every-minute schedule and secret; each retention invocation processes a bounded batch of up to three cases. The external Render cron job is not changed or activated here, and the KYC migration must be reviewed and applied before deploying this worker. Legal-hold changes are denied while deletion is already claimed, so an administrator must place a hold before a purge begins. Pseudonymous references use HMAC with `NEXTAUTH_SECRET`; rotating that secret changes future pseudonyms but does not expose archived identities. No identity images, extracted identity data, case decision reasons, or raw user identifiers are retained in the pseudonymized archive. Automated malware scanning is not configured.

The additive `20261115164000_aurevia_verify_cases` migration is not applied automatically by setup or build. Review and apply migrations only under the repository’s separately authorized database-change process; this implementation has not been applied to production.

### KYC evidence retention operations

The retention clock begins at the authoritative final `reviewedAt` timestamp, not upload or submission time. Only `APPROVED` and `REJECTED` cases become eligible, at or after `reviewedAt + 90 days`. Resubmission cases and their prior evidence remain open until the latest case receives its final approval or rejection. Pending, processing, escalated, resubmission-required, and held cases are excluded. The worker claims a case chain before deletion, refreshes its lease while processing objects, checks every document owner against the case, and deletes only `IDENTITY_DOCUMENT` and `SELFIE` objects from the private `kyc-documents` bucket. A 404 from Storage is treated as an already-completed deletion. Document rows are deleted only after all matching objects have been confirmed absent; a failed/partial attempt leaves the rows and schedules an exponential retry.

After evidence deletion, the worker retains a minimized decision archive for seven years from the final decision timestamp. The archive contains the case reference, decision status/category, HMAC-pseudonymized applicant/reviewer/actor references, submission/decision/purge timestamps, purge outcome, and status/audit event timestamps and categories. It excludes images, document rows and storage keys, extracted identity data, raw actor/user IDs, ordinary decision reasons, and raw audit metadata. Legal-hold reasons are retained as required hold documentation. HMAC references use the existing server-only `NEXTAUTH_SECRET`; rotating the secret changes newly generated references. The worker never logs document contents, URLs, credentials, names, emails, or case IDs.

Use the existing Render Cron service; do not add an in-process timer or a second service. Its command is `node scripts/push-delivery-cron.mjs`, scheduled every minute. The script calls the push-delivery, KYC email-delivery, withdrawal approval SMS-delivery, and evidence-retention endpoints; the retention endpoint processes at most three root cases per invocation. Withdrawal SMS delivery uses the configured Termii SMS API and retries provider failures through its database outbox. It requires no additional environment variables. The script requires the existing `NEXTAUTH_URL`, `PUSH_DELIVERY_WORKER_URL` (same-origin HTTPS URL ending in `/api/cron/push-delivery`), `PUSH_DELIVERY_CRON_SECRET`, and `CRON_SECRET`. The application also requires its existing server-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `NEXTAUTH_SECRET`. Do not add any of these values to tracked files or expose them to the browser. The retention and withdrawal SMS endpoints accept only `Authorization: Bearer <CRON_SECRET>`.

Before enabling withdrawal SMS delivery, review and apply the additive `20261120150000_withdrawal_approval_sms_outbox` migration through the authorized database-change process; this implementation does not apply migrations. Before enabling the KYC retention scheduler in staging, review and apply the additive `20261115172000_kyc_evidence_retention_and_legal_acceptance` migration after `20261115164000_aurevia_verify_cases` using the authorized staging database process and a verified backup. No migration, production purge, production configuration change, Render deployment, or Supabase production change is performed by this code change. Recovery is automatic: the next scheduled batch retries eligible records after the stored backoff deadline. Inspect the Render application logs for `KYC evidence retention attempt failed`, `KYC metadata retention attempt failed`, and the structured batch counts; alert on worker HTTP failures and any nonzero `retriesScheduled`. The application does not configure a third-party alert destination. An authorized administrator can review retry counts, last non-sensitive failure category, and retained decision metadata in Admin > KYC. Verify deletion only through the authorized archive and Storage object state; do not download or print identity evidence for verification.

Legal holds are managed by authorized administrators in the KYC operations panel. A hold requires a documented reason; administrators can place, update, or release a hold. Each change records the acting administrator and timestamp in the live KYC event/audit history or the pseudonymized retention-event history. A purge claim blocks concurrent hold changes, and a live hold blocks evidence and metadata purges. A hold on an archived record prevents metadata deletion but cannot restore evidence already removed. Legal-hold history and decisions are visible only through server-authorized administrator routes.

### Persistent legal acceptance

Acceptance is stored in `RegistrationLegalAcceptance` with the authenticated user ID, document key, immutable version, acceptance timestamp, and a minimal channel/document audit record. Terms acceptances are also mirrored to the legacy `TermsAcceptance` table for compatibility. Unique user/document/version constraints and `createMany(..., skipDuplicates)` make repeat submissions idempotent. Registration loads the current required versions from the server and submits the versions actually displayed; the server rejects stale or incomplete version sets. Subsequent login, browser refresh, and device changes do not reset acceptance: protected server routes check the database for each account.

The persistent gate requests only outstanding current versions. Publishing a new applicable version with `requiresReacceptance` enabled requires acceptance of that version; a published version with renewal disabled does not invalidate the user's existing acceptance, while new registrations record the current published version. Policy versions are immutable once published. Administrators publish a new version and set its visibility, renewal requirement, and effective dates in Admin > Notices & Conditions. Users can review current and historical published versions and their own acceptance timestamps in the Legal Centre and Settings. Authorized administrators can page through acceptance records and export the selected page from the same admin panel. Reading a policy or opening the Legal Centre does not alter acceptance records.

The migration adds policy enum values, acceptance audit metadata, KYC retention fields, archive/event tables, and indexes without dropping or rewriting user, wallet, authentication, or historical acceptance rows. Validate migrations against a disposable/staging database first. For an approved staging rollout, back up the database, review the SQL, deploy all pending migrations with `npx prisma migrate deploy` from the application root, then verify the schema and run the authorized retention worker only against staging evidence. Never point this process at production without separate approval.

### Administration
- Role-protected admin area
- User list and freeze/unfreeze
- Audited permanent deletion of user accounts, KYC submissions, funding requests, and support conversations
- Role-separated administrator and customer accounts; administrators cannot access customer account routes
- KYC profile and private document approval/rejection
- Per-user deposit and withdrawal enablement controls
- Deposit/withdrawal approval queue
- Deposit approval posts the exact approved amount to the user's ledger atomically
- Force-close open positions
- Instrument enable/disable and configuration API
- System settings
- Stories management with categories, private media uploads, previews, drafts, scheduling, visibility, archive/delete controls, engagement analytics, and per-story audit history
- Deleted Items recycle bin for waitlist entries, client stories, and broadcasts, with search, filtering, audited restore, and audited permanent deletion
- Audit log
- Realtime operational statistics

User account deletion permanently removes the user and related account records in a transaction, and then removes associated private uploads. Pending/approved/processing funding requests and non-zero ledger balances block self-service and ordinary administrator deletion; an administrator can explicitly force deletion. Audit entries are retained with actor/target references and metadata scrubbed where needed.

### Public Stories

The public `/stories` feed and homepage/dashboard story strips read only published, non-expired content; scheduled stories become visible when their publication time arrives. Administrators manage stories at `/admin/stories`. Default categories are installed by the additive Stories migration, and additional categories are administrator-created. Public and member-only visibility is enforced in the server-side listing and media routes. Story images and videos are stored in the private Supabase `stories` bucket and served through short-lived signed URLs only after the story's visibility and publication state are checked. Configure the existing server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never expose the service-role key to the browser. The migration creates the private bucket if absent and refuses to proceed if an existing bucket is public or too small; it does not change any other Storage bucket.

Anonymous views use a random, HTTP-only visitor cookie whose value is hashed before storage; view and external-link counts are deduplicated per story, action, and UTC day. No visitor IP address is stored for Stories analytics.

Administrators can publish external news links from `/admin/news-feed` and select the news category. These posts appear on the News page and dashboard news panels. YouTube, Vimeo, and direct MP4/WebM/OGG links display inline; other HTTPS links are presented as outbound cards because arbitrary websites may block framing or expose unsafe embedded content. Posts can be hidden from the public feeds without deleting their audit history.

### Financial engine
- PostgreSQL persistence
- Prisma transactions
- Double-entry ledger
- Ledger balance derived from entries
- Serializable transactions for financial mutations
- Atomic funding approval
- Atomic trade reservation
- Margin release and realized P&L settlement
- Trading fees
- Insufficient-funds protection
- No direct mutable customer cash balance

### Internal Platform Bank

The admin and customer Bank pages use the existing REAL-mode ledger; they do not create a second customer wallet. Treasury funding and adjustments, and administrator-requested REAL wallet credits/debits, are recorded as pending operations and require approval by a different active administrator before the balanced ledger transaction is posted. Treasury entries are internal accounting records and do not verify that external funds were received. Wallet and treasury balances remain derived from ledger entries. Bank-account freezes block supported REAL outflows but do not alter historical entries or prevent deposits.

The customer Bank statement and card-funding screens are ledger-backed. Card balances are separate internal ledger subaccounts and are not part of the REAL wallet balance. They cannot be spent at external merchants or ATMs: Aurevia has no licensed card issuer or processor integration. The existing card catalog and order flow remain; card-order funding/fee fulfillment is not added by this implementation.

The additive `20261116100000_aurevia_platform_bank` migration is not applied automatically and has not been applied to production. Review the migration and validate it against a disposable or authorized staging database before applying it through the approved database-change process. Do not treat internal treasury entries as external capital, and do not deploy the migration or change production configuration without separate authorization.

### Market engine
- Internal simulated instruments
- Random-walk price engine
- One-minute candles
- Automatic Limit/Stop order processing
- Socket.io market:update events
- Socket.io trade:update events
- REST market, candle and order-book endpoints

### Live market dashboard

The `/markets` page uses Twelve Data as its primary external market-data provider, with configured Finnhub, Financial Modeling Prep, and Alpha Vantage fallbacks for their supported asset types and endpoints. Credentials are server-only. If verified provider data is unavailable, the market view reports it unavailable rather than generating a replacement price or candle. Signed-in users can ask the centralized AI service to explain a quote or history source status; only the verified symbol, timeframe, source class, and provider label are sent, never prices, account records, credentials, or raw provider errors. This explanation does not create or estimate market data. Display freshness, quotas, exchange availability, and capabilities depend on each configured provider's plan and symbol access. The informational market view is separate from internal DEMO and REAL simulated execution.

REAL trade quotes and portfolio marks are provider-only: the internal fallback is not eligible for REAL order submission or REAL valuation. The trade screen displays the available best bid/ask as market quotes, not as Level 2 market depth; feeds without bid/ask data report those fields as unavailable. The quote timestamp and provider are shown, stale quotes cannot be used to submit orders, and provider-confirmed execution remains authoritative.

### AI assistance scope and controls

The centralized server-side AI gateway uses OpenRouter by default, checks that the selected model is free, and can use only explicitly allowlisted free backups. Nova provides multilingual platform help and deterministic, account-mode-scoped lookups; the account-tier page offers AI explanations of the authenticated user's locally determined onboarding checklist; the learning center has a general education assistant; the portfolio page can explain asset-class concentration from user-scoped open-position aggregates and offer a trading-journal reflection from aggregated closed-position outcomes; the markets page can explain the selected watchlist using fresh configured provider quotes only; the news page can analyze framing in configured publisher-sourced articles; administrator tools provide constrained dashboard configuration, draft assistance, normalized-signal ticket-classification suggestions, integration troubleshooting, and summaries from supplied application records. Onboarding prompts contain only account mode, tier, and locally derived checklist steps; identity documents and personal profile values are not sent. REAL portfolio analysis and market analysis use only fresh external provider data; unavailable or simulated marks are excluded. Trade reflections do not send symbols or dollar outcomes to the AI provider. News sentiment is based only on locally stored active articles from enabled sources and is not a verified market signal. Generated analysis is not investment advice or a trading instruction. AI never changes a ledger, approves KYC or funding, changes permissions, or submits an order.

Nova extends the existing support assistant and central AI gateway. Its market analysis uses only fresh external quotes and provider-sourced candles for configured symbols; RSI, MACD, EMA/SMA, ATR, and recent candle-range levels are calculated from those candles. Responses identify providers and timestamps and do not claim live-versus-delayed status unless a provider supplies it. Publisher-sourced news comes from enabled Aurevia feed records; no economic calendar or fundamental-data feed is connected, so unavailable events and company figures are not invented. Account details are loaded only for the authenticated user from existing Aurevia services and are excluded from AI conversation context. Conversation context is limited to the active chat session. DEMO remains simulated, REAL wallet balances remain ledger-authoritative, and new REAL orders use Aurevia's internal simulation rather than an external broker or exchange.

Administrators can enable or disable each registered AI service in `/admin/command-center`; changes are audited. Calls through the central service are limited to 60 requests per actor and service per process per minute, identical sanitized prompts are cached in memory for up to 30 seconds within the same actor/service scope, and request/token metadata is recorded without prompt text. These in-process limits and caches are not distributed across multiple Render instances. The gateway redacts common email, phone/account-number, payment-number, and credential patterns before sending user/assistant message content to a provider. Do not enter identity documents, secrets, or unnecessary personal information in AI prompts.

This expansion does not add voice processing, a document/OCR provider, external market-event feeds or event summaries, personalized trade recommendations, automated KYC decisions, free-form database querying, automatic ticket classification or replies, business-report scheduling, or autonomous operations. Ticket classification is a suggestion based only on locally derived keyword signals and must be applied manually by an administrator. The unimplemented capabilities require additional product workflows, verified sources, and—in some cases—separately approved external APIs. Existing Supabase, Prisma, historical provider-order metadata, Demo/Real separation, and financial authorization paths are preserved.

## Important scope boundary

DEMO and REAL are mutually exclusive active modes backed by separate Aurevia ledgers, balances, orders, funding requests, investments, and P/L. DEMO orders use Aurevia's internal simulator and retain the existing practice allocation and behavior. New REAL orders are funded only from the user's Aurevia Wallet in the instrument's settlement currency (buys) or base asset (sells), reserve available funds/asset quantities against concurrent orders, and use Aurevia's internal simulated execution. They are not sent to an external broker or exchange. Fees and currency-specific entries are posted to the existing ledger; no wallet currency is silently converted. REAL withdrawals continue to use the existing eligibility, limits, fee, KYC, reservation, and administrator-approval controls. Historical external-provider order and reconciliation metadata is retained for recordkeeping and is not used to route new REAL orders. The optional administrator-configured Bitcoin reference address on the deposit page is display-only: Aurevia cannot receive, custody, monitor, or verify Bitcoin. Do not send cryptocurrency based on this screen. BTC withdrawals use the user's saved, encrypted Bitcoin mainnet destination; optional TXID, sender, and date/time fields are user-submitted metadata, not evidence that a transfer occurred. REAL deposits and withdrawals require separate approval by a second active administrator before a ledger credit or debit is posted. Withdrawal evidence is administrator-attested and is not independently verified by a connected bank or blockchain provider. REAL BTC deposits remain subject to separate administrator review and an explicitly entered USD credit amount. Administrators can request audited wallet credits and debits; REAL operations and treasury changes require approval by a different active administrator before posting, while the existing DEMO adjustment behavior is unchanged. Live brokerage, payment processing, BTC custody, and automatic external money movement are not enabled. Internal card balances are not externally spendable. Identity eligibility remains subject to administrator review and existing per-user funding controls.

Authenticator settings are available when the server-only `TOTP_ENCRYPTION_KEY` is configured. Registration and all password-based sign-ins are code-free on both recognized and new devices, including when an authenticator is configured. Enabling the optional authenticator from Settings requires a password and one valid authenticator code to confirm enrollment; TOTP replay is rejected. Legacy `twoFactorEnabled` flags are not treated as protection and are cleared by the security migration so users can configure an authenticator through Settings > Security.

First-party Aurevia Verify submissions are reviewed manually by administrators. Historical verification-provider database records and migrations remain for data preservation, but there are no active hosted identity-provider routes, credentials, or UI. Old Akedly records cannot update new KYC decisions. Legacy Akedly session and webhook routes are retired. Tier 3 phone ownership checks use Termii only when its existing verification provider is configured; Twilio is not used by active verification code. KYC status emails use a durable outbox; email delivery never changes KYC status. Password reset remains email-only. Customer APIs reject administrator sessions, administrator APIs use a separate role guard, and authenticated administrators are redirected to the administration console. Verified personal profile fields become read-only for two calendar months after identity approval; profile photos remain independently changeable, and users can contact support for corrections to protected identity details.

## Requirements

- Linux, macOS, or Windows through WSL2. Native Windows setup is not supported by the project shell scripts.
- Node.js **24.22.2**, pinned in `.node-version`; `package.json` accepts Node.js `>=24.22.2 <25`.
- npm 11.x, bundled with the pinned Node.js runtime.
- Docker Engine with Docker Compose v2 is required only for isolated Playwright tests and optional Compose workflows.

## Development setup

The canonical tool inventory is [`tools/toolchain.json`](tools/toolchain.json). It records versions, purposes, installation and verification steps, and the environments where each tool is used. Project-local versions are locked by `package-lock.json`; no global JavaScript packages are needed.

From a fresh clone or extracted ZIP, open a terminal in `Aurevia/aurevia` (the directory containing `package.json`). Install and select Node.js 24.22.2 using your existing version manager; for nvm, for example:

```sh
git clone https://github.com/stevenken161-cloud/Aurevia.git
cd Aurevia/Aurevia/aurevia
nvm install 24.22.2
nvm use 24.22.2
node --version
npm --version
npm run setup
npm run tools:verify
```

The setup command checks the exact pinned runtime and npm 11.x, installs dependencies with `npm ci --include=dev`, generates Prisma Client, installs the Playwright-managed Chromium and available Linux system dependencies, validates the tool manifest and verifies a headless browser launch. Linux system libraries are installed only when root or passwordless sudo is available; otherwise setup prints the authorized manual command. To explicitly request Linux system dependencies, use `npm run setup -- --with-deps`. Firefox and WebKit are optional: `npm run browsers:install -- --all`.

The repository-root `.devcontainer/devcontainer.json` pins Node.js 24.22.2, provides Docker CLI access in Codespaces, and runs the same setup command after creation. Opening a fresh download in a compatible Dev Container automatically installs the locked npm dependencies, Prisma Client, and Playwright Chromium. Rebuild the container after configuration changes. A regular ZIP does not contain machine-specific `node_modules`, browser binaries, Docker, or PostgreSQL; run `npm run setup` after installing the pinned Node.js runtime to restore the project-local tools. Git is needed for cloning and contribution workflows but not for a ZIP download. The PostgreSQL test image provides `psql` and `pg_isready`; host-installed PostgreSQL client utilities are not required.

Copy `.env.example` to `.env` without overwriting an existing local file (`cp -n .env.example .env` on Linux/macOS/WSL2) and configure only local development values. Use a disposable local PostgreSQL database; never use production database URLs or credentials in local setup, tests, or builds. Setup does not read or require production credentials and does not run database migrations. Configure application integrations only when needed.

```sh
# Verify locked local tools and Chromium
npm run tools:verify

# Generate Prisma Client without connecting to a database
npm run db:generate

# Start the local application (requires suitable local environment configuration)
npm run dev

# Unit/API tests, type checking, and lint
npm test
npm run typecheck
npm run lint

# Full browser suite: Docker starts a disposable loopback-only PostgreSQL 16 database
npm run test:e2e:isolated

# Production build (does not apply migrations)
npm run build
```

If Chromium reports missing Linux shared libraries, run `npm run browsers:install -- --with-deps` from an authorized account. The browser cache under `tools/playwright/browsers/` is machine-specific, ignored by Git, and is recreated by setup; browser binaries are not included in production builds or Render deployment artifacts. Browser smoke testing requires an already-running Aurevia server with its isolated/test database available: `npm run test:browser:smoke -- http://127.0.0.1:4310`.

## Tool cleanup audit

- Removed `scripts/install-tools.sh`; its dependency/browser/verification orchestration is now the single `npm run setup` entry point.
- Removed `scripts/verify-tools.sh`; `npm run tools:verify` now validates the authoritative manifest and installed locked packages directly.
- Relocated the misplaced nested Codespaces config to repository-root `.devcontainer/devcontainer.json`, where Codespaces discovers it, and pinned its Node feature to `.node-version`.
- Retained `scripts/install-browsers.sh` because CI and optional Firefox/WebKit setup use it; retained Prisma, Playwright, Vitest, TypeScript, ESLint, Docker/Compose, Render, integrations, and deployment configuration.
- No application dependencies, provider integrations, database migrations, or production configuration were removed. The repository has no separate formatter tool.

## Isolated browser tests

Run `npm run test:e2e:isolated` with Docker available. The command starts a disposable PostgreSQL 16 container bound only to a dynamically selected loopback port, applies Prisma migrations only to that container, and removes it after the run. The container has no persistent volume; neither `DATABASE_URL` nor `DIRECT_URL` from `.env` is used for tests. `npm run test:e2e` requires explicit `AUREVIA_E2E_DATABASE_URL` and `AUREVIA_E2E_DIRECT_URL` values that point to the same local PostgreSQL database ending in `_e2e`; it refuses Supabase, Neon, and other remote hosts before fixture setup.

The isolated database bootstraps only the minimal Supabase Storage tables, private bucket metadata, and database roles required by the Storage-policy migration. The Playwright application process redirects Storage calls to a loopback mock using a test-only key; shared Supabase credentials are cleared. E2E setup also clears external email, SMS, Akedly, market-data, AI, brokerage, and payment credentials, and forces live and paper execution off. For REAL-mode trade settlement tests only, pass `--twelve-data-mock` to `npm run test:e2e:isolated`; this opts the isolated application into a deterministic Twelve Data HTTP fixture using a non-secret test key, and a Node preload prevents requests from reaching Twelve Data. The isolated runner reserves distinct free loopback ports for the app and mock provider to avoid collisions with unrelated services. `npm run test:e2e` by itself continues to reject non-local or mismatched database URLs.

Playwright runs with one worker because integration tests share mutable database fixtures and authentication sessions. Public-route and responsive-layout checks are kept in a separate spec from the shared-fixture application suite.

## One-time account cleanup

The manual `scripts/purge-accounts.ts` cleanup is never called by build, install, or migration commands. From `aurevia/`, first run a dry run with the exact account email:

```sh
npm exec tsx -- scripts/purge-accounts.ts --keep-email=<exact-email>
```

The dry run prints masked account identifiers and changes nothing. To execute, add `--execute` and enter `DELETE ALL NON-ADMIN ACCOUNTS` at the interactive prompt:

```sh
npm exec tsx -- scripts/purge-accounts.ts --keep-email=<exact-email> --execute
```

The script aborts unless that exact email matches one non-admin user, preserves every administrator, exports the selected users and related account records to a mode-restricted JSON file in the gitignored `backups/` directory, deletes in transactional batches, and verifies that exactly one non-admin user remains. Keep the backup securely; it contains private account data.

## Environment

Copy `.env.example` to `.env`.

`.env.example` lists variable names only. Configure the values in the ignored `.env` file or your deployment's secret manager. `DATABASE_URL` is the application connection (use the Supabase pooler URL when appropriate); Prisma uses `DIRECT_URL` for migrations and introspection. Both must point to the intended Supabase Postgres database. The application does not use a browser Supabase client; database access stays on the server through Prisma.

Only `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPABASE_URL` are public configuration. All other values, especially database URLs, `NEXTAUTH_SECRET`, administrator credentials, `BREVO_API_KEY`, `KYC_ENCRYPTION_KEY`, `KYC_SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`, are server-only. Never put a provider API key, webhook secret, Supabase service-role/secret key, or encryption key in a `NEXT_PUBLIC_` variable. The Data API roles `anon` and `authenticated` have no table or sequence privileges on the application's `public` schema, and row-level security is enabled for its tables; the application uses its server-side Prisma connection.

`ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` are server-only administrator credentials. On the dedicated admin login form, the first sign-in using the exact configured username or email and password provisions the configured ADMIN account. The password must be at least 12 characters. An existing customer account is never promoted to administrator; configure a separate administrator email. If the configured email is unused but an administrator already exists, that existing admin record adopts the configured email and username after the configured password is verified; a second admin is not created. The seed remains available for explicit provisioning. Restart the server after changing these values.

Signup is free and creates the user and account records transactionally through `/api/register`; it does not require phone OTP, email OTP, or an external verification token. Successful registration signs the user in. Email and phone verification are optional, independent Settings security features and are not registration or KYC requirements. All application email uses Brevo's transactional HTTPS API and the configured verified sender; SMTP and Resend are not active providers. Settings phone verification uses Termii transactional SMS; without valid Termii SMS configuration, the API reports that no code was sent. Twilio and Akedly are not active phone-verification providers. Requests are rate limited, and one-time codes expire after ten minutes. In-process IP and target quotas are not shared across multiple app instances; persistent per-account cooldowns and attempt counters are also enforced. KYC outbox delivery still requires its existing migration and authenticated cron worker; email failure does not alter KYC decisions. Password reset remains email-only. The production URL defaults to the current Render hostname; `PORT` and `MARKET_TICK_MS` have runtime defaults.

Signup failures return a reference ID for support; unexpected server errors are logged with a redacted cause. Never share credential values, OTPs, raw provider responses, or complete personal information.

To prepare an aggregate report of legacy, long-expired unverified accounts, run `npx tsx scripts/registration-cleanup-dry-run.ts --dry-run` in an intentionally configured environment. This report is read-only, returns counts only, and has no apply mode. Review candidate account and financial-history counts before separately authorizing any production cleanup; never use it as authorization to delete permanent users or financial/audit records.

The registration endpoint returns `Retry-After` seconds when either signup quota is exhausted. Client IPs are taken from the trusted proxy's forwarded address; the honeypot is checked server-side.

Active customer accounts receive a server-generated permanent ID in the form `AEX-YYYY-XXXX-XXXX`, using a cryptographic random suffix and a database unique index. New registrations create the ID in the same transaction as the account and ledger records. The authenticated profile, dashboard, account card, receipts, and admin user management display the ID, and profile/admin update APIs do not accept changes to it. For existing accounts, first run `npx tsx scripts/aurevia-id-backfill.ts --dry-run` against the explicitly intended database and review its aggregate counts. The additive migration adds a nullable unique column without rewriting user or financial records. The controlled rollout is: separately approve the initial report and migration, apply the additive migration, deploy the ID-aware application, rerun and review the dry run, then separately approve and run `AUREVIA_ID_BACKFILL_CONFIRM=APPLY_ACTIVE_USER_IDS npx tsx scripts/aurevia-id-backfill.ts --apply`. The backfill assigns IDs only to active customer accounts, preserves existing IDs, and retains the existing database check constraint for previously email-verified records. Never run the migration, deploy, or apply command against production without separate authorization and a reviewed dry run.

For production on Render, keep `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` set to `https://aurevia-et63.onrender.com` unless and until a separately verified custom domain is explicitly enabled. Render's `RENDER_EXTERNAL_URL` is used as the canonical auth/public origin unless `AUREVIA_CUSTOM_DOMAIN_VERIFIED=true` explicitly opts into the verified custom domain. Production startup fails closed if `NEXTAUTH_SECRET` is missing or no valid HTTPS app origin can be resolved; it never trusts an arbitrary Host header or a hard-coded fallback secret. Official support contact defaults to `aureviainvest@gmail.com` and can be overridden with `SUPPORT_EMAIL`; `COMPLAINTS_EMAIL` may be set separately. When Brevo is not fully configured or is unavailable, transactional email is not sent; in-app tickets and notifications remain recorded.

### Vercel deployment

This repository is configured as a Next.js application in `vercel.json`. Vercel runs the App Router routes as serverless functions; it does not run `server.ts`, persistent Socket.IO connections, or the local in-process market timer. Browser market views therefore refresh over HTTP, and the protected `/api/cron/market-tick` route advances the simulated DEMO market once per minute. Use a Vercel plan that supports one-minute Cron schedules. This market is simulated; the job does not connect to a broker or funding provider.

- Framework preset: Next.js
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: leave the Vercel default
- No custom start command

Configure production and preview environment variables in the Vercel project settings. Required server values are `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, and `CRON_SECRET`. Configure Supabase private-file variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) when those workflows are enabled. Add `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` before provisioning the administrator. Set the canonical HTTPS app origin explicitly in `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL`; use a separate staging database and secrets for Preview deployments. Keep credentials server-only except explicitly public site/URL keys.

Use Supabase's pooled connection string for `DATABASE_URL` where appropriate and its direct PostgreSQL connection for `DIRECT_URL`. Apply reviewed Prisma migrations to the target database before promoting the deployment; the Vercel build does not run migrations or seed an administrator. Do not point Preview deployments at production customer data. Configure the private Storage buckets and restrictive policies documented above before enabling uploads.

Generate a high-entropy `CRON_SECRET` and store it in Vercel project settings. Vercel Cron sends it as a Bearer token to the market-tick route; calls without that exact secret are rejected. Cron jobs run for production deployments. Local development and the Render Node service continue to use the custom server's ticker; Render remains the option when persistent Socket.IO/WebSocket delivery is required.

### Render deployment

Use a Render **Node web service** connected to the existing GitHub repository. Set its Root Directory to `Aurevia/aurevia` (the app and `package.json` are in that repository subdirectory). Render's persistent web service supports this custom Next.js/Socket.IO HTTP server and WebSocket upgrades; do not deploy it as a static site or serverless function. Keep the service on an always-on plan (the Blueprint uses `starter`); a sleeping/free instance cannot guarantee continuous market updates or WebSocket delivery. The in-process simulated-market ticker runs while the server is running, and the optional external quote broadcaster polls configured providers every 30 seconds. Selecting or upgrading the Render plan is a dashboard/billing action, not something a Git push or application environment variable can do. Signing out only ends the user's session and does not stop an always-on server. Use one instance while the in-process Socket.IO market engine is enabled; horizontal scaling requires a shared Socket.IO adapter and coordinated market worker, which are not currently configured.

#### Route production deployments through Render

The repository-root GitHub Actions workflow `.github/workflows/deploy-render.yml` triggers the Render deploy hook on every push to `main` and can also be run manually from the Actions tab on `main`. In **GitHub → Settings → Secrets and variables → Actions**, add the repository secret `RENDER_DEPLOY_HOOK_URL` with the full Render deploy-hook URL. Keep the URL out of source files and logs. Disable Render's native **Auto-Deploy** for the service to avoid deploying the same push twice. The Render service must remain connected to this repository and configured with the correct production branch and Root Directory.

The internal DEMO market tick defaults to once per second (`MARKET_TICK_MS=1000`, minimum 1000 ms) and streams each update to connected chart clients. DEMO/reference charts sample a new forming candle each second and load up to 500 historical candles where available. Provider-backed charts only change when provider quote or history data arrives; the app does not invent live-market price movements. Vercel's serverless deployment does not run the in-process timer or persistent WebSocket server; its scheduled DEMO tick runs at the configured Cron cadence.

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm start`
- If Render reports a build command of `yarn`, update the service's Build Command in **Settings → Build & Deploy** to the command above. Installing dependencies alone does not generate the `.next` production build required by the start command.
- Docker is not required for Render's native Node runtime. The checked-in multi-stage `Dockerfile` is an alternative if the Render service is explicitly configured as a Docker service.

Configure these variables in Render's environment settings (secrets stay in Render, never in source). A local `.env` file is not automatically uploaded to Render:

- Required: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Required for browser push: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (for example `mailto:aureviainvest@gmail.com`), `PUSH_SUBSCRIPTION_ENCRYPTION_KEY` (32 random bytes encoded as Base64), and `PUSH_DELIVERY_CRON_SECRET`. Generate a VAPID pair with `npx web-push generate-vapid-keys`; set its public and private values in the correspondingly named Render variables, and never commit the private key. Generate the encryption and cron secrets with `openssl rand -base64 32` and `openssl rand -hex 32`, respectively. Keep the VAPID private key, encryption key and cron secret server-only. Back up the encryption key securely and retain it: changing it makes existing stored subscriptions undecryptable.
- Required to enable authenticator-based two-factor authentication: `TOTP_ENCRYPTION_KEY`, a stable 32-byte Base64 key generated with `openssl rand -base64 32`. Store it only in the server's secret manager and back it up securely. Do not rotate or lose it without a planned re-enrollment process; enrolled TOTP secrets cannot be decrypted without the original key. Two-factor enrollment remains unavailable until this key is configured. Password changes, session revocation, and REAL withdrawal requests require the current password but do not require a separate verification code. Security sessions are persisted and individually revocable; location is not displayed because reliable location data is not collected.
- Required for administrator sign-in: `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Use the exact configured username or email and password at `/admin/login`; first sign-in provisions the admin or adopts the existing admin record when the configured email is unused. Email and phone verification are optional Settings actions; registration and KYC submission do not depend on them. Identity verification status is separate from email and phone verification.
- Phone OTP verification uses Termii transactional SMS with TERMII_API_KEY, TERMII_SENDER_ID, and TERMII_BASE_URL. OTP codes are generated and validated by Aurevia; codes are never logged or returned to the browser. Brevo is used for email delivery, not SMS. No Twilio or Akedly phone verification configuration is used.
- Optional external market data: set server-only provider keys: `TWELVE_DATA_API_KEY` (and `TWELVE_DATA_BASE_URL=https://api.twelvedata.com`), `FINNHUB_API_KEY`, `FMP_API_KEY`, and/or `ALPHA_VANTAGE_API_KEY`. Twelve Data is primary; Finnhub covers stock quotes and history, FMP covers stock/index quotes and history, and Alpha Vantage covers stock/forex/crypto history plus stock quotes. The configured providers are tried in that order where they support the requested asset and interval. Confirm the plan, quota, symbol access, licensing, and display rights for every configured provider before setting `MARKET_DATA_DISPLAY_LICENSES_CONFIRMED=true` in production. Provider quotes and candles are returned only when verified; unavailable data is not replaced with generated market values. Credentials must never use `NEXT_PUBLIC_*` names or be exposed to browser code.
- Trading execution is internal simulated execution for both DEMO and REAL account modes. REAL orders use Aurevia Wallet funds and ledger accounting; no external broker or exchange receives an order. Historical external-provider order references remain stored, but remote order status, cancellation, and reconciliation requests are disabled.
- Optional AI assistance: set server-only `OPENAI_API_KEY` with `AI_PROVIDER=openai`, `AI_MODEL=gpt-4o-mini`, and `OPENAI_MODEL_ALLOWLIST=openai:gpt-4o-mini` to enable OpenAI recommendations. OpenRouter remains the default provider when `AI_PROVIDER` is unset. OpenRouter models must report zero prompt and completion pricing; Gemini and Groq backups remain opt-in through `AI_BACKUP_PROVIDERS` and explicit free-model allowlists. Provider/model failures never route to an unapproved model. `DEMO_AI_ENABLED=true` enables DEMO recommendations. `DEMO_AI_AUTO_ENABLED=true` additionally permits opt-in automatic execution in DEMO mode only, using virtual wallet funds and the existing risk/cash limits. REAL account AI assistance is never automatic.
- The administrator-only **AI & API command center** at `/admin/command-center` runs read-only provider checks and records redacted health/usage metadata. To submit AI credentials through its approval queue, configure `AI_SECRETS_ENCRYPTION_KEY` as a stable 32-byte Base64 secret (`openssl rand -base64 32`). A second administrator must approve a submitted credential. Environment variables take precedence; Render deployment secrets remain managed in Render. If the encryption key is unavailable, configure credentials directly in Render rather than submitting them in-app.

Set both `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to the same canonical HTTPS origin assigned to the Render service (or its verified custom domain). The database URLs must be the existing Supabase PostgreSQL connections; use Supabase's pooler for application traffic where appropriate and its direct connection for Prisma schema management. Render injects these environment variables during the build. Keep production migrations out of the build command: first reconcile the target database's migration history with the checked-in migrations, review the migration plan for compatibility with the running release, and obtain explicit approval before applying migrations using `DIRECT_URL`. Confirm migration status and take appropriate database backups before any approved production migration; do not use `db:push` or reset commands in production.

The additive `prisma/migrations/20261116110000_funding_dual_approval/migration.sql` adds administrator-attribution fields for staged REAL funding and withdrawal approvals. It is not applied to production. Review it against the target database and reconcile migration history, back up the database, and obtain explicit authorization before applying it as a deliberate one-off migration. Do not apply it from a build or deployment command.

#### Account theme preference deployment

The two account themes are stored on the existing `User` record and are shared by that account across devices. The additive migration `prisma/migrations/20261105191504_account_theme_preference/migration.sql` adds the constrained `ApplicationTheme` enum and a non-null `preferredTheme` column defaulting existing accounts to `FOREST_GREEN`. Before deploying code that reads or writes this field, reconcile this migration with the target database's actual Prisma migration history (which has previously diverged), review and back up the target database, and obtain explicit approval. Apply it only as a deliberate, separately authorized one-off migration using the existing production migration process; do not run it during a build or deploy. Do not use `db:push`, reset, or destructive schema synchronization. The migration has not been applied to production by this change.

#### Browser push notification deployment

1. In **Render → Aurevia web service → Environment**, add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `PUSH_DELIVERY_CRON_SECRET`. Generate a fresh VAPID pair locally using `npx web-push generate-vapid-keys`; store its public output in `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and its private output in `VAPID_PRIVATE_KEY`. Set `VAPID_SUBJECT` to a valid contact URI such as `mailto:aureviainvest@gmail.com`. Generate separate values for the encryption and worker secrets using `openssl rand -base64 32` and `openssl rand -hex 32`; do not reuse the VAPID private key for encryption.
2. Review additive migrations `prisma/migrations/20261025153000_browser_push_notifications/migration.sql`, `prisma/migrations/20261102173000_kyc_email_outbox/migration.sql`, and `prisma/migrations/20261104110000_registration_phone_lookup/migration.sql` against the target database's actual Prisma migration history and data. The registration migration adds the phone lookup index used during signup. This checkout's production migration history has previously shown divergence; reconcile it with the database owner, take a backup, and approve the migration plan before applying it. Do not run `db:push`, reset, or an unreviewed migration on production. After reconciliation and approval, run `npm run db:migrate` against the production service's `DIRECT_URL` as a deliberate one-off operation, not in the build command.
   The KYC email worker also requires the additive `prisma/migrations/20261102173000_kyc_email_outbox/migration.sql` migration. Review and apply it under the same schema-reconciliation, backup, and authorization process before deploying code that enqueues KYC email events.
3. Deploy the existing Node web service over its canonical HTTPS origin. The service serves `/sw.js` at origin scope and must be reachable at `https://<your-domain>/sw.js`.
4. In **Render → New → Cron Job**, connect the same repository, set Root Directory to `Aurevia/aurevia`, Build Command to `npm ci --include=dev`, and Command to `node scripts/push-delivery-cron.mjs`. Add `PUSH_DELIVERY_WORKER_URL=https://<your-domain>/api/cron/push-delivery`, the same `NEXTAUTH_URL` as the web service, the web service's `PUSH_DELIVERY_CRON_SECRET`, and the web service's `CRON_SECRET`. Set the schedule to every minute (`* * * * *`) and save. The job calls the authenticated same-origin workers for push delivery, KYC email delivery, and KYC evidence retention; push and email events are persisted/retried, and retention batches are bounded and retryable. Review and apply the required KYC migration before deploying code that uses it.
5. After both services are deployed, sign in using a supported HTTPS browser, open **Settings → Preferences**, enable notifications, grant permission from that button, and send a test notification. The test targets that device and reports whether the push service accepted the send; check the device's notification centre to verify that it actually appeared, then confirm that clicking it opens the account page. Settings lists registered devices, lets you remove a device, shows its last successful push-service handoff, and provides account notification-category preferences. A successful handoff does not prove that the operating system displayed the notification. On iPhone and iPad, update to iOS/iPadOS 16.4 or newer, open Aurevia in Safari, use **Share → Add to Home Screen**, launch Aurevia from its Home Screen icon, and enable notifications inside the installed app. A normal iOS browser tab cannot receive Web Push. On Android and supported desktop browsers, installation is optional where browser Web Push is available. Verify background/offline delivery separately on real iPhone Safari-installed PWA, Android Chrome (installed and browser), desktop Chrome, and desktop Safari devices before claiming support; delivery is not guaranteed across unsupported browsers, disabled permissions, operating-system focus modes, or push-service outages.

Foreground notification sounds are configured separately in **Settings → Preferences** and saved locally per signed-in account on each device; no database migration is required. Audio must be enabled or previewed through a user interaction, and sounds play only for newly received notifications while the app is visible. iOS Safari and other browsers may impose additional audio restrictions, so validate on each supported device. When the app is closed or backgrounded, no custom sound is promised; browser push sounds remain controlled by the operating system and browser.

#### Android PWA cache boundary

The service worker may cache only the public manifest, Aurevia icons/logo, and versioned static `/_next/static/` assets with cacheable response headers. Navigations, API responses, authenticated page data, and private/no-store responses are not cached. Offline mode does not serve cached account pages or enable financial actions. Verify these exclusions when changing service-worker behavior.

The development command uses `.next-dev` so it does not collide with production builds in `.next`; `server.ts` loads the repository `.env` and honors the configured database URLs. The Docker build context excludes `.env*`; supply runtime configuration only through the hosting environment. The application has no production localhost URL dependency: its localhost URL fallback is for local development, and production startup requires `NEXTAUTH_URL`.

### Simulated account workflows and external provider readiness

DEMO customer orders remain on Aurevia's existing internal simulator. New REAL trade orders use Aurevia's internal simulated engine and are funded from the user's currency-specific Aurevia Wallet balance. Orders reserve available funds or assets, and execution entries, fees, positions, and realized results are posted to the existing Aurevia ledger. They are idempotent and do not call an external trading API. Historical external-provider order metadata remains stored; the application no longer queries, cancels, or reconciles those orders remotely. REAL BTC deposits still require user evidence and separate manual verification before an audited USD ledger credit. The application does not verify Bitcoin confirmations or provide a receiving address. REAL withdrawal eligibility excludes pending withdrawals and open-order reservations; administrator-confirmed external processing is still required to complete a withdrawal. Historical investment allocations and target returns remain subject to their existing simulated settlement behavior; they do not represent exchange funds or guaranteed profits. No live brokerage, custody, or automatic external payout is enabled.

DEMO customer actions include viewing supported markets, placing simulated orders, allocating virtual funds to admin-published DEMO-eligible investment opportunities, reviewing practice activity, and resetting the virtual account. DEMO funding, withdrawals, cards, and KYC submissions remain disabled in server-side routes as well as the interface. Investment allocations may be made across available opportunities, reserve only the user's separate DEMO ledger balance, and use simulated settlement terms; any target earnings are estimates, not guaranteed returns or external investments. New DEMO ledgers start at exactly USD 5,000; reset returns virtual cash to its recorded starting amount, closes open positions, cancels open orders and unsettled DEMO investments, audits the operation, and retains historical ledger entries. AI trade ideas are server-generated recommendations only: the user must review and submit an order, and the order service independently validates active mode, fresh prices, cash, exposure, fees, and slippage. AI recommendations are disabled by default; enable them with `DEMO_AI_ENABLED=true` only when the central server-side AI gateway has an approved free model configured. The `DEMO_AI_*` values in `.env.example` control strategy selection, supported symbols, risk sizing, thresholds, simulated costs, and the evaluation interval. No provider key belongs in a browser-visible variable.

### Activity visibility and retention

The account Activity page supports search, category/status/date filters, pagination, archive/restore, removal from the visible feed, and clear-history actions. These actions create mode-scoped visibility preferences and do not erase or alter orders, positions, investments, funding requests, ledger entries, balances, or audit history. Open orders and positions cannot be archived or removed from the feed. Read notifications can be permanently deleted only when they have no push-delivery record; notification deletion does not delete the related account record. The administrator Activity Management page is role-checked server-side, scopes every action to a selected user and account mode, and writes administrative outcomes to the protected audit log. Admin login history is excluded from the default activity results and is shown only when the Login history filter is explicitly selected; login and audit records remain immutable. Per-row removal icons hide eligible activity from that user's feed without confirmation because the action is reversible; bulk clear/remove and permanent deletion still require confirmation.

The additive `20261027083000_activity_visibility_management` migration adds notification archive timestamps and the activity visibility preference table. It does not reset or rewrite existing account data. Apply it through the normal reviewed deployment migration process before deploying the application version that uses these fields.

The admin-only `/api/admin/providers/status` endpoint reports internal execution and configured market-data-provider health without returning credentials. Provider statuses include authentication results, the most recent successful request, data timestamp/freshness, provider errors, rate-limit errors, and capability categories. New REAL orders persist Aurevia-internal simulated executions and wallet ledger entries; historical provider order and execution references remain intact but are not queried remotely. DEMO orders remain entirely internal. Existing additive migrations for historical provider-order metadata remain in the repository and must be reviewed through the existing migration process; this work does not apply or rewrite them.

Market-data credentials use server-only variables: `TWELVE_DATA_API_KEY` and optionally `TWELVE_DATA_BASE_URL`, `FINNHUB_API_KEY`, `FMP_API_KEY`, and `ALPHA_VANTAGE_API_KEY`. Provider keys are never returned to browsers or emitted in logs. Production market-data display remains disabled until `MARKET_DATA_DISPLAY_LICENSES_CONFIRMED=true` is set after verifying the plan, symbol access, licensing, and display rights for every configured provider. `REAL_EXECUTION_ENABLED` does not enable external brokerage or change the internal simulated execution service. Payment-provider names are `PAYMENT_PROVIDER`, `PAYMENT_API_URL`, `PAYMENT_API_KEY`, and `PAYMENT_WEBHOOK_SECRET`; external payment processing remains disabled. Select jurisdictions and obtain legal/compliance approval before evaluating broker, payment, market-data, and identity/AML providers. Administrators can grant simulated credits to configured REAL ledgers. A REAL BTC request is only a report of an asserted transfer: an administrator must independently inspect it and choose a USD credit amount; no blockchain verification or exchange-rate conversion is automated. The product does not provide a REAL BTC destination, so configure and operationally verify any actual receiving wallet and confirmation process outside this feature before soliciting transfers. Admin allocations update only the internal ledger; no payment, transfer, bank/card activity, or custody occurs. REAL withdrawal approval leaves funds reserved and incomplete; no external payout provider is configured, and the settlement endpoint refuses to mark REAL withdrawals complete. REAL investment requests can be reserved, reviewed, activated, completed, and settled only as simulated ledger activity; settlement returns reserved principal and does not credit configured target estimates as earnings. These actions do not create an external investment or return. Manual KYC status is explicitly an administrator review and is not external identity/AML or regulatory verification.

Private avatar, receipt, and support file workflows require server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. New KYC evidence uses the separate server-only `KYC_SUPABASE_URL` and `KYC_SUPABASE_SERVICE_ROLE_KEY` and the existing private `kyc-evidence` bucket; legacy KYC files remain in `kyc-documents`. Keys must never be placed in a `NEXT_PUBLIC_*` variable or imported into client components. Configure the required buckets as private; the application does not create buckets. Restrictive `storage.objects` RLS policies block client access to private buckets. Trusted server routes use service credentials only after session, record-ownership, or administrator checks. Upload routes verify signatures, MIME type, extension, size, and owning database record; file replacement is non-upserting and owner-scoped. File access uses signed URLs for at most five minutes. Users can retrieve their own KYC documents through the owner-filtered document route; administrator KYC review requires `requireAdmin`. New identity applications accept JPEG, PNG, and WebP images within the configured 1–15 MB per-image limit; administrators can review uploaded files from `/admin`. No external identity, AML, sanctions, or malware-scanning provider is connected.

### Provider status and unavailable-data handling

| Capability | Provider/configuration | Current behavior without provider |
| --- | --- | --- |
| Database | Supabase Postgres; `DATABASE_URL`, `DIRECT_URL` | Server operations fail explicitly; no in-memory financial fallback |
| Market information | Twelve Data primary; configured Finnhub, FMP, and Alpha Vantage fallbacks | Only provider-returned prices and candles are shown; unavailable data is reported as unavailable |
| Display currency | Timestamped provider exchange quote, then a previously stored rate when available | Approximate display conversion only; source and freshness are disclosed; ledger values are never converted |
| Broker/execution | Aurevia internal simulated execution for each mode, with ledger and position isolation | Customer orders do not reach an external broker; live execution disabled |
| Deposits and withdrawals | Funding-provider contract only; no bank, card, blockchain, or custody adapter | REAL BTC credits require separate manual verification and approval; withdrawals are capped to verified BTC-funded balance and remain incomplete without a payout provider |
| Investments | No investment execution/settlement provider | Allocations reserve internal funds; settlement returns reserved principal only and never converts an estimated target return into earnings |
| Identity/KYC | First-party Aurevia Verify with administrator manual review | `KYC_ENCRYPTION_KEY`, `KYC_SUPABASE_URL`, and `KYC_SUPABASE_SERVICE_ROLE_KEY` are required for new private evidence submissions |
| Email/OTP | Email/password registration is handled by `/api/register`; optional account email codes, password resets, security notifications, and KYC notices use Brevo's transactional HTTPS API. | KYC notices retry independently of the administrator decision. API acceptance does not prove inbox delivery. |
| Private files | Supabase Storage URL, private bucket, service-role key | Upload and signed access fail closed; no public-file fallback |
| Deployment | No deployment provider configuration is checked into this repository | Production secret injection, domains, TLS, backups, monitoring, and release controls must be configured in the hosting environment |
| SMS/OTP | Termii transactional SMS for phone verification and SMS alerts | OTPs are generated and validated by Aurevia. If Termii is not configured or rejects a request, SMS delivery is unavailable and no code is reported as sent. |

### First-party KYC configuration

Set `AUREVIA_KYC_ENGINE=internal`, `AUREVIA_KYC_ENABLED=true`, and `KYC_MAX_DOCUMENT_SIZE_MB=15` (or a lower whole-number limit) in the server environment. Generate `KYC_ENCRYPTION_KEY` once as a stable 32-byte Base64 secret through the deployment secret manager; preserve it in encrypted backups, never print it, and do not rotate it without a reviewed re-encryption plan. Configure `KYC_SUPABASE_URL` and `KYC_SUPABASE_SERVICE_ROLE_KEY` for the private `kyc-evidence` bucket. New KYC submissions fail closed if encryption, the database schema, or private evidence storage is unavailable. Existing evidence remains accessible through the original `kyc-documents` storage. Historical verification-provider database records and migrations are retained without active routes or credentials; this change adds no database migration.

#### Brevo email and phone verification

For Render email delivery and email verification, configure `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `BREVO_SENDER_NAME` in the server environment. Use the Brevo API key and a sender address verified in Brevo. App email is sent through Brevo's HTTPS API; SMTP and Resend are not configured fallbacks. Brevo is not used for SMS. Phone verification and withdrawal approval SMS use Termii with `TERMII_API_KEY`, a registered 3–11 character alphanumeric `TERMII_SENDER_ID`, and `TERMII_BASE_URL` (default `https://api.ng.termii.com`). Transactional messages use Termii's DND route, which must be enabled for the account. Keep all provider keys server-only. If a provider rejects or times out, delivery fails explicitly and does not change KYC or withdrawal state.

Phone OTP verification uses Termii transactional SMS. Configure the server-only `TERMII_API_KEY`, registered `TERMII_SENDER_ID`, and valid HTTPS `TERMII_BASE_URL` (default `https://api.ng.termii.com`). Aurevia generates each OTP, stores only an HMAC hash, and validates the code locally with expiry and attempt limits. Termii delivery acceptance is not itself proof of phone ownership. Brevo remains the email transport and is not used to send SMS. Twilio and Akedly are not active phone-verification providers. `VERIFICATION_CODE_SECRET` may be configured as a stable server-only HMAC secret; if omitted, the existing implementation uses `NEXTAUTH_SECRET`.

Previously stored external verification-provider records remain only for database compatibility and are not consulted by current application flows. KYC configuration diagnostics report names and readiness states only, never key values.

Password recovery tokens are random, single-use, expire after 30 minutes, and are stored only as SHA-256 hashes. Resetting a password revokes the active account session. Successful and failed credential attempts are written to the existing admin-only audit log with a validated IP when available, bounded user-agent text, and a hashed identifier for unknown accounts; no password or raw token is stored.

For a real deployment, use a unique high-entropy `NEXTAUTH_SECRET`, a strong administrator password, and managed secret storage.

## Local setup

```bash
npm run setup
cp -n .env.example .env
# For the local Postgres container, set DATABASE_URL and DIRECT_URL to its connection URL.
docker compose up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run build
npm run dev
```

Open `http://localhost:3000`.

The application server owns the HTTP server and Socket.io endpoint, so use `npm run dev` rather than `next dev` when realtime functionality is required.

## Administrator provisioning

```text
Username: configured with ADMIN_USERNAME
Email: configured with ADMIN_EMAIL
Password: configured with ADMIN_PASSWORD
```

Set `ADMIN_USERNAME`, `ADMIN_EMAIL`, and a unique, strong `ADMIN_PASSWORD` in the deployment secret manager or an ignored local `.env` file. No administrator password is included in the repository. On a fresh database, use those exact credentials at `/admin/login`; first sign-in provisions the ADMIN account. If an admin already exists and the configured email is unused, first sign-in updates that existing admin record to the configured identity rather than creating a second one. Alternatively, run `npm run db:seed` to provision explicitly.

The admin **Account sessions** page (`/admin/sessions`) displays recent registered-account sign-ins and allows an administrator to revoke an active session. It reuses the existing login audit records and current-session marker; it does not collect anonymous browsing activity, expose IP addresses or raw user-agent strings, resolve location, or issue arbitrary commands to a visitor's device. Passwords remain one-way hashed and can only be changed through the account recovery flow.

## Docker

```bash
docker compose up --build
```

The included compose file starts PostgreSQL and the app. It requires the database, NextAuth, and administrator values from `.env`; it contains no default credentials.

## Test workflow

### 1. Health

Open:

```text
GET /api/health
```

Expected response includes `ok: true` and `database: "ok"`.

### 2. Admin login

Open `/login` and use the configured administrator credentials. `/admin` must be accessible only to an ADMIN JWT.

### 3. User registration

Create a normal account from `/register`, sign in, and confirm `/dashboard`, `/trade`, `/wallet`, `/kyc` and `/settings` are protected routes.

### 4. Identity review

In REAL mode, submit your legal identity details, consent, document images, and selfie through Aurevia Verify. An authorized administrator reviews the application; file integrity checks and camera capture do not establish identity or liveness. After identity approval, provide a residential address and proof of address, then request Tier 3 review. Tier 3 is granted only when all existing eligibility checks are met and an authorized administrator approves the request. This workflow is not AML/sanctions screening or regulatory advice.

### 5. Simulated funding

From `/wallet`, deposit requests remain internal and pending administrator review; the optional configured Bitcoin address is display-only and does not receive or verify funds. Administrators can fund a selected user/mode directly; that action creates an audited ledger entry and printable receipt. DEMO withdrawals are simulated; an authorized administrator can complete a virtual debit. REAL BTC withdrawal requests use a saved, encrypted Bitcoin mainnet destination and may include optional user-reported TXID/sender/date-time details. Those details are not verified; actual outbound transaction confirmation and the processing TXID remain administrator responsibilities. REAL withdrawal requests are limited to the available eligible balance; admin approval reserves the request but does not complete it. No external payout provider is configured, so REAL withdrawals remain incomplete and no money is paid. Rejection or cancellation releases a reservation. No bank, card, custody wallet, or payout provider is connected.

New DEMO accounts start with a one-time $5,000 virtual USD balance; REAL accounts start at $0.00. Each opening amount is kept in its corresponding double-entry ledger, and no DEMO balance is transferred into REAL. Account-mode balances, orders, positions, transactions, and P&L remain isolated. Administrators may issue audited credits to either account mode. The `/admin/markets` page can generate bounded, audited price changes for supported paper instruments; it does not publish live quotes. Users can select a persistent display currency across wallet, dashboard, portfolio, activity, and USD transaction history; conversions are informational only and never change underlying ledger balances.

### 6. Trading

After initializing a DEMO account or approving a simulated deposit request:

1. Open `/trade`.
2. Select an instrument.
3. Place a Market order.
4. Confirm an execution and position appear.
5. Watch the price update through Socket.io.
6. Confirm unrealized P&L changes.
7. Close the position.
8. Confirm margin plus realized P&L is returned to the user ledger.

For Limit and Stop orders, place an order outside the current trigger price, then wait for the market simulator to reach its trigger. The server processes eligible open orders on market ticks.

### 7. Ledger invariant

Every posted monetary transaction contains exactly one debit and one credit for the same amount. The test suite also covers positive monetary quantities.

### 8. Admin controls

From `/admin`, test:

- Freeze/unfreeze a user
- Approve/reject KYC
- Change USER/ADMIN role
- Approve/reject funding
- Reject historical DEMO funding requests; release only stale DEMO withdrawal reservations
- Force-close positions
- Enable/disable instruments
- Generate audited SIMULATED price ticks from `/admin/markets`

Client stories are private drafts until an administrator links and verifies the client, records a completed REAL withdrawal with its settlement reference, records publication consent, and approves the story. The repository does not include the supplied story photos or a configured image-storage provider, so seeded drafts have no image reference. No story, financial amount, or verification badge is published by seeding.
- Change system settings
- Inspect audit logs

### 9. API checks

Useful endpoints:

```text
GET  /api/health
GET  /api/market
GET  /api/candles?instrumentId=<id>&limit=100
GET  /api/orderbook?instrumentId=<id>
GET  /api/orders
POST /api/orders
DELETE /api/orders
GET  /api/positions
POST /api/positions
GET  /api/wallet
POST /api/wallet
GET  /api/kyc
POST /api/kyc
```

## Production hardening checklist

Before any real-money use, add and independently verify:

- Managed PostgreSQL with backups and point-in-time recovery
- Distributed rate limiting for remaining process-local application limits (authentication verification uses atomic database-backed limits)
- Optional WebAuthn/passkey sign-in (the compatible packages are installed but passkeys are not enabled)
- Email/phone verification
- Independent KYC verification provider and document malware scanning
- AML and sanctions screening
- Real payment/custody integrations
- External market-data and execution integrations
- Reconciliation jobs
- Idempotency keys for every financial POST operation
- CSRF/origin controls appropriate to the deployment topology
- Structured security logging and alerting
- Secrets manager
- WAF/DDoS controls
- Database connection pooling
- Penetration testing
- Dependency/SBOM scanning
- Disaster recovery testing
- Regulatory review for every operating jurisdiction

## Project structure

```text
app/
  api/                 REST API routes
  admin/               admin control center
  dashboard/           portfolio dashboard
  trade/               trading terminal
  wallet/              funding interface
  kyc/                 KYC interface
  settings/            account settings
  login/               authentication UI
  register/            onboarding UI
components/            reusable React components
lib/                    authentication, ledger, market and order engines
prisma/                 schema and seed
server.ts               Next.js + Socket.io application server
tests/                  automated tests
Dockerfile              application image
docker-compose.yml      PostgreSQL + application orchestration
```

## Final implemented application surface

The current source includes:

- Dedicated `/admin/login` administrator entry point with role enforcement.
- Realtime Socket.io market ticks and execution broadcasts.
- Synthetic depth/order-book endpoint at `/api/orderbook`.
- Historical candle endpoint at `/api/candles`.
- User ledger transaction endpoint at `/api/ledger`.
- Full order retrieval and cancellation API.
- Market, limit and stop order triggering.
- Serializable order execution and leverage-aware margin reservation.
- Trading-fee ledger postings.
- Open-position unrealized P&L on the dashboard and trading terminal.
- Pending-withdrawal balance reservation checks.
- Admin instrument creation, enable/disable, price and leverage editing.
- Admin self-protection against freezing or demoting the currently logged-in administrator.
- Global loading, error and not-found UI states.
- Health endpoint suitable for container/load-balancer checks.

## Verification evidence

Run verification from the application directory with `npm run test:all`, `npm run tools:verify`, and `npm run build`. The E2E runner provisions and removes a disposable loopback-only PostgreSQL database; it clears shared database and external provider credentials before starting the application. Chromium binaries are restored by `npm run setup` and remain ignored by Git.

The automated suite uses Vitest for unit/API tests and Playwright for browser flows, route/theme/responsive checks, and axe accessibility scans. Playwright remains single-worker because its financial and authentication fixtures share mutable state. Chromium is the default browser; run `npm run browsers:install -- --all` to install Firefox/WebKit. `npm run test:e2e:all-browsers` runs Chromium, Firefox, and WebKit sequentially, each against a fresh disposable database so financial fixtures cannot leak state between browsers. CI uploads HTML reports, test results, and failure traces even when a test fails. Automatic Render deployment from `main` waits for the test workflow to succeed.

The source-level API route inventory is `tests/api-route-inventory.csv`. It lists every route and exported method, direct-handler test-import evidence, and static source hints for authentication, authorization, validation, response status/builders, data access, and sensitivity. `F`, `P`, and `U` mean full-method, partial-method, and no direct handler test import found; they are not test execution results. One route whose status conflicts with the report's test-file mapping is marked `UNRESOLVED`. The dedicated `npm run test:e2e:api-routes` command runs an isolated unauthenticated empty-request smoke check for all 227 inventoried methods. A passing smoke check does not establish valid-payload behavior, authenticated success, data isolation, duplicate handling, or complete authorization coverage. Static hints and the limitations column explicitly flag where per-method branch behavior still needs review.

```bash
npm test
npm run test:watch
npm run test:coverage
npm run typecheck
npm run test:e2e:isolated
npm run test:e2e:chromium
npm run test:e2e:all-browsers
npm run test:e2e:api-routes
npm run test:e2e:accessibility
npm run test:e2e:lighthouse
npm run test:e2e:headed
npm run test:e2e:ui
npm run test:e2e:debug
npm run test:e2e:report
```

For Lighthouse, start the application against an isolated/test database and pass its loopback URL explicitly. The audit refuses remote hosts and writes `playwright-report/lighthouse.html`; no default port is assumed:

```bash
AUREVIA_LIGHTHOUSE_URL=http://127.0.0.1:4310 npm run test:lighthouse
```

`npm run test:e2e:lighthouse` builds and starts the local production-mode application on the disposable E2E database, signs in only with temporary fixture accounts, and measures the landing, login, registration, dashboard, markets, trade, portfolio, wallet, and admin dashboard pages. It prints per-page Performance, Accessibility, Best Practices, and SEO scores plus actionable audit items; the sanitized score summary is saved under `test-results/`.

This audit uses the Playwright-installed Chromium binary. Run `npm run browsers:install -- --with-deps` first if browser binaries or Linux libraries are missing.

This verification does not clear production for release. The last read-only migration-status check found `20261019103000_alpaca_paper_order_account` and `20261019120000_btc_funding_and_paper_buying_power` unapplied in the configured database, while its history recorded `20261013110000_payment_method_network`, which is absent from this checkout and Git history. Reconcile that history with the database owner and review existing BTC transaction references for duplicates before considering the partial unique index; do not mark migrations applied or run SQL until the intended migration contents and production data are verified and an authorized migration plan is approved. The additive migration `20261027100000_alpaca_paper_execution_reconciliation` was also not applied. These migration names and any stored provider identifiers are retained only for historical compatibility; the application no longer makes Alpaca requests or uses Alpaca for order execution. New REAL orders use Aurevia's internal simulated execution, and live brokerage execution remains disabled.

For local development only, point `DATABASE_URL` and `DIRECT_URL` at a disposable local database before running database setup commands. Never run migrations or database reset/push commands against production without an explicitly reviewed migration plan and authorization.

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run build
npm run dev
```

This remains a simulated/internal trading and accounting platform. It is not, by itself, a licensed real-money brokerage, payment processor, custodian, KYC provider, or external execution venue.

## Aurevia stability and UX upgrade (2026-09)

This revision incorporates the recurring issues identified during the Aurevia deployment journey:

- Explicit client-side registration/login actions prevent the browser's native form GET from racing React hydration.
- Registration and login now expose network/API failures instead of silently stalling.
- Authentication keeps the existing NextAuth JWT session model; logout returns to `/login` without invalidating a valid session on ordinary refresh.
- A single startup shell provides an 8-second first-entry animation and a 3-second transition for subsequent route changes. It uses session storage to avoid an endless loading loop.
- The loading UI is finite and deterministic; there is no perpetual page reload or blinking redirect loop.
- Mobile navigation is full-width, touch-friendly, and avoids desktop side gutters/zoom-style layouts.
- The Aurevia metallic gold emblem supplied in the project assets is included at `public/aurevia-logo.png` and used in startup, navigation, login, registration, and the landing page.
- The interface uses a forest-green/black/gold visual system and broker-style trading cards, market views, order ticket, positions, notifications, KYC and account controls.
- The Stanbic IBTC E-Trade page was used only as a UX/functionality reference: mobile/web trading, live market data, account control, order workflows, portfolio visibility and trade notifications. Proprietary logos, copy, artwork and source code are not copied.

### Regression checklist

1. First visit: startup overlay completes once in 8 seconds.
2. Internal navigation: transition completes in 3 seconds.
3. Browser refresh: session is not deliberately cleared.
4. Logout: returns to login and does not trigger an infinite startup/redirect loop.
5. Registration: no native `/register?` submission; request goes to `/api/register` only after the user presses Continue.
6. Login: failed authentication shows an error and does not silently hang.
7. Mobile: navigation opens as an overlay and content remains within the viewport.
8. Branding: supplied Aurevia logo is loaded from the app's public assets.
# Optional market-data providers

Market-data adapters use documented HTTPS APIs through the application's server-side `fetch` pattern; no additional provider SDK is needed. Twelve Data is primary for stock, forex, and cryptocurrency assets. Finnhub is a stock quote/history fallback, FMP supports stock/index quotes and history, and Alpha Vantage supports stock/forex/crypto history plus stock quotes. Search, technical indicators, and market state remain Twelve Data-only. Provider quotas and symbol entitlements depend on each subscription. Unsupported instrument categories are not sent to a provider, and unavailable prices or candles are not synthesized.

Add provider API keys only as server environment variables: `TWELVE_DATA_API_KEY` (with optional `TWELVE_DATA_BASE_URL` restricted to the official API host), `FINNHUB_API_KEY`, `FMP_API_KEY`, and `ALPHA_VANTAGE_API_KEY`. In Render, open **Dashboard → your Aurevia web service → Environment → Environment Variables**, then save. Do not use `NEXT_PUBLIC_*` names, source files, GitHub variables, or browser code for credentials. After verifying the plan, market-data licensing, and display rights for every configured provider, set `MARKET_DATA_DISPLAY_LICENSES_CONFIRMED=true` to enable provider data in production. Leave it false until that review is complete. Saving Render environment settings triggers a service redeploy; no deployment is performed by this repository change.

The authenticated admin provider-status panel tests each configured provider with a server-side AAPL quote request. It reports `CONNECTED` only after a successful response, and never returns API key values. It reports `NOT_CONFIGURED`, `ERROR`, or `LICENSE_REVIEW_REQUIRED` otherwise. A successful test demonstrates authentication and response parsing, not subscription entitlement, licensing approval, or guaranteed ongoing availability.

Provider usage is cached and paced per process: Twelve Data at one request every 8 seconds, Finnhub and FMP at one per second, and Alpha Vantage at one every 12 seconds. These are not shared quota coordinators across multiple Render instances and do not supersede provider plan limits. The service tries configured providers in order and reports unavailable data rather than synthesizing market data. Provider plans may impose stricter quotas, symbol entitlements, attribution, delayed data, or licensing terms. Verify every plan before enabling production usage.
