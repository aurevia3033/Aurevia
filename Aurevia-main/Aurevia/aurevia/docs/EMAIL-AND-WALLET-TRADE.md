# Email verification, wallet funds, and Trade settlement

## Email verification

### Env (preferred)

```env
# Brevo API
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=

# or SMTP
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
VERIFICATION_EMAIL_FROM=

# Free platform inbox (default on). Set to 0 to require real email only.
EMAIL_PLATFORM_LOCAL=1
```

When Brevo/SMTP is configured, codes are emailed normally.  
When not configured, **platform-local** delivery still issues a code: the API returns `platformCode` and Settings auto-fills it so verification works without a paid mail API.

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

- `POST /api/settings/email-verification/send` — may include `platformCode` when local
- `POST /api/settings/email-verification/verify`
- `POST /api/orders` — spends/credits simulated wallet for the active account mode
- `GET /api/portfolio` — reflects ledger + positions
