# Portfolio free market APIs

Portfolio valuation uses configured providers first, then these **keyless** public APIs so marks stay available inside the website:

| Source | Use | Endpoint (server-side) |
|--------|-----|------------------------|
| Binance | Crypto USDT pairs | `api.binance.com/api/v3/ticker/price` |
| CoinGecko | Crypto USD | `api.coingecko.com/api/v3/simple/price` |
| Frankfurter | FX | `api.frankfurter.app/latest` |
| Yahoo Finance | Equities / indices / metals futures | `query1.finance.yahoo.com/v8/finance/chart` |
| Instrument book | Last platform price | Database `instrument.price` |

Fallback order per position: configured env providers → free APIs → instrument book price.

Internal route: `GET /api/market/free-quote?symbol=BTC` (authenticated).

No paid key is required for the free path to work.
