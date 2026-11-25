# Env configuration — market, trade, admin

These variables are read by `lib/config/env.ts` / `lib/market-env.ts`.  
Trade and market UIs must use app API routes; those routes use these keys.

## Market data providers

```bash
TWELVE_DATA_API_KEY=
TWELVE_DATA_BASE_URL=https://api.twelvedata.com
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
FMP_API_KEY=
MARKET_DATA_DISPLAY_LICENSES_CONFIRMED=false
MARKET_TICK_MS=1000
```

## Execution

```bash
# When true, real account execution paths are enabled server-side
REAL_EXECUTION_ENABLED=false
```

(Exact flag name is whatever `execution.realEnabled` already maps to in `env.ts` — keep your existing name.)

## Admin access

```bash
# Values already consumed by getServerConfiguration().auth
# Admin login form: "Configured admin username or email"
NEXTAUTH_SECRET=
NEXTAUTH_URL=
# Admin username / email / password as already defined in your env.ts auth block
```

## Support / complaints (existing)

```bash
# support.supportEmail, support.complaintsEmail, support.supportPhone
```

Do not put provider API keys in client bundles. Only `NEXT_PUBLIC_*` values are public.
