# Remaining External Dependencies

## Configured integration boundaries

- Twelve Data/Finnhub/FMP/Alpha Vantage: market data credentials and licenses.
- Brevo/SMTP: email delivery.
- Termii: SMS delivery.
- Akedly: optional phone/identity callback integration.
- Supabase: private storage and PostgreSQL.
- Web Push/VAPID: browser push delivery.
- GNews: editorial news feeds.
- AI providers: optional OpenAI/OpenRouter/Gemini/Groq credentials.

## Explicitly unavailable

- Live bank, custody, payment, payout, brokerage, and exchange execution.
- Production credentials and commercial API access cannot be inferred from source.
- Independent KYC provider and independent sanctions/AML workflow.
- Isolated restore verification environment.

## Required before production

- Set a constrained `ALLOWED_APP_ORIGINS` value.
- Configure secrets through the deployment secret manager.
- Confirm Supabase bucket policies and encryption keys.
- Test backup and restore against an isolated PostgreSQL instance.
- Configure and validate provider callbacks/signatures, timeouts, and credential health.
