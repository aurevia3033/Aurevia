/**
 * Market & trade data sources — always resolve from environment configuration.
 * Do not hard-code provider URLs or keys outside this module / lib/config/env.ts.
 *
 * Env keys (server):
 *   TWELVE_DATA_API_KEY, TWELVE_DATA_BASE_URL
 *   FINNHUB_API_KEY
 *   ALPHA_VANTAGE_API_KEY
 *   FMP_API_KEY
 *   MARKET_DATA_DISPLAY_LICENSES_CONFIRMED
 *   MARKET_TICK_MS
 *
 * App routes that must remain the client entry points:
 *   /api/live-markets
 *   /api/live-markets/[symbol]
 *   /api/market
 *   /api/market/search
 *   /api/market/activity
 *   /api/market/analysis
 *   /api/market/indicators
 *   /api/orderbook
 *   /api/orders
 *   /api/positions
 *   /api/cron/market-tick
 */

import {getServerConfiguration} from '@/lib/config/env';

export type MarketProviderId =
	| 'twelve-data'
	| 'finnhub'
	| 'alpha-vantage'
	| 'fmp'
	| 'none';

export type MarketProviderEndpoints = {
	twelveDataBaseUrl: string;
	twelveDataConfigured: boolean;
	finnhubConfigured: boolean;
	alphaVantageConfigured: boolean;
	fmpConfigured: boolean;
	anyConfigured: boolean;
	tickMs: number;
	productionLicenseConfirmed: boolean;
};

/** Server-only snapshot of market provider configuration from env. */
export function getMarketProviderConfig(): MarketProviderEndpoints {
	const config = getServerConfiguration();
	const md = config.marketData;
	return {
		twelveDataBaseUrl: md.twelveDataBaseUrl || 'https://api.twelvedata.com',
		twelveDataConfigured: Boolean(md.twelveDataApiKey) && md.twelveDataBaseUrlValid,
		finnhubConfigured: Boolean(md.finnhubApiKey),
		alphaVantageConfigured: Boolean(md.alphaVantageApiKey),
		fmpConfigured: Boolean(md.fmpApiKey),
		anyConfigured: md.configured,
		tickMs: config.app.marketTickMs,
		productionLicenseConfirmed: md.productionLicenseConfirmed,
	};
}

/** Preferred provider order when multiple keys are present in env. */
export function preferredMarketProviders(): MarketProviderId[] {
	const cfg = getMarketProviderConfig();
	const order: MarketProviderId[] = [];
	if (cfg.twelveDataConfigured) order.push('twelve-data');
	if (cfg.finnhubConfigured) order.push('finnhub');
	if (cfg.alphaVantageConfigured) order.push('alpha-vantage');
	if (cfg.fmpConfigured) order.push('fmp');
	if (order.length === 0) order.push('none');
	return order;
}

/** Client-facing API paths — trade & market UIs should call these, not external URLs. */
export const MARKET_APP_API = {
	liveMarkets: '/api/live-markets',
	liveMarketSymbol: (symbol: string) => `/api/live-markets/${encodeURIComponent(symbol)}`,
	market: '/api/market',
	marketSearch: '/api/market/search',
	marketActivity: '/api/market/activity',
	marketAnalysis: '/api/market/analysis',
	marketIndicators: '/api/market/indicators',
	orderbook: '/api/orderbook',
	orders: '/api/orders',
	positions: '/api/positions',
	portfolio: '/api/portfolio',
} as const;

/** Execution mode from env — REAL trading only when enabled. */
export function isRealExecutionEnabled(): boolean {
	return getServerConfiguration().execution.realEnabled;
}
