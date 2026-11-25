# Email verification, wallet funds, and Trade settlement

## Email verification

### Env (preferred)

```env
# Brevo API
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=

# SMTP fallback
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
VERIFICATION_EMAIL_FROM=
```

Brevo is the primary transactional email provider; configured SMTP is used as a fallback. Without a configured provider, the request fails and no email verification code is issued or returned to the browser. Provider acceptance is not a guarantee that a message reached the recipient's inbox.

## Wallet funds (DEMO and REAL)

Both modes use **simulated ledger balances** inside Aurevia:

| Mode | Ledger | Behaviour |
|------|--------|-----------|
| DEMO | `USER:{id}:DEMO:USD` | Practice balance; trades and investments stay in demo books |
| REAL | `USER:{id}:REAL:USD` (+ other assets) | Simulated "real" wallet still internal to the platform — not an external bank rail |

Deposits, withdrawals, cards, convert, and other wallet tasks continue to use the configured funding / bank / investment flows.

## Trade → wallet loop

1. Open Trade while account mode is **REAL** (or DEMO).
2. Available cash comes from the matching wallet ledger (after reserved withdrawals / collateral).
3. Buy orders **debit** the wallet (notional + fees) via double-entry ledger.
4. Sell / close orders **credit** proceeds; **realized PnL** increases or decreases wallet balance.
5. Insufficient simulated funds → order rejected with a clear wallet error (no silent overdraft).

Execution marks use Twelve Data when configured, otherwise free built-in providers (Binance, CoinGecko, Frankfurter, Yahoo, Stooq) so trading stays available.

## Related APIs

- `POST /api/settings/email-verification/send` — sends a code only through a configured email provider
- `POST /api/settings/email-verification/verify`
- `POST /api/orders` — spends/credits simulated wallet for the active account mode
- `GET /api/portfolio` — reflects ledger + positions
