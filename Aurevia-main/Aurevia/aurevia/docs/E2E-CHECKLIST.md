# Aurevia E2E alignment checklist

## 1. Route health (no 404 on primary links)

```bash
# After npm run dev
curl -s http://localhost:3000/api/health/routes | jq
```

Manually or with Playwright, open each `userRoutes.path` and confirm HTTP 200 (auth pages may redirect to /login).

## 2. Free market providers (24/7 fallbacks)

```bash
curl -s http://localhost:3000/api/health/market | jq
# Expect status "ok" and at least one provider with ok:true
```

```bash
curl -s 'http://localhost:3000/api/live-markets?symbols=BTC,SPX,EURGBP' | jq '.marketDataStatus,.source'
```

## 3. Page-to-page journeys

| From | To | Expect |
|------|-----|--------|
| / | /login, /register, /markets | 200 |
| /login | /dashboard (after auth) | redirect |
| /dashboard | /trade, /portfolio, /wallet, /settings | 200 |
| /markets | /trade | 200 |
| /portfolio | /trade, /wallet | 200 |
| /settings | /kyc, /tier | 200 |
| /admin/login | /admin | after admin auth |

## 4. Not-found surface

Visit `/this-page-does-not-exist` — should show app `not-found` UI, not a blank crash.

## 5. Existing automated tests

```bash
npm test -- --run tests/portfolio-route.test.ts tests/market-data-service.test.ts tests/profile-lock.test.ts
```

## Free API fallback order

1. Env-configured (Twelve Data, Finnhub, Alpha Vantage, FMP)
2. Binance (crypto)
3. CoinGecko (crypto)
4. Frankfurter (FX)
5. Yahoo Finance (indices, stocks, FX, crypto)
6. Stooq (stocks / indices)

If one source has no data, the next runs automatically inside `getMarketQuoteWithFallback` and portfolio valuation.
