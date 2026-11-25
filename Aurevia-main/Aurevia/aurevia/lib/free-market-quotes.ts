/**
 * Free, keyless market quotes + candle helpers for 24/7 platform operation.
 * Used when configured paid providers are missing or fail. Server-side only.
 *
 * Fallback chain: Binance -> CoinGecko -> Frankfurter -> Yahoo Finance -> Stooq
 */

export type FreeQuote = {
	symbol: string;
	price: number;
	previousClose?: number | null;
	change?: number;
	changePercent?: number;
	updatedAt: string;
	source: 'Binance' | 'CoinGecko' | 'Frankfurter' | 'Yahoo Finance' | 'Stooq';
	isStale: boolean;
	sparkline?: number[];
};

export type FreeCandle = {
	time: number;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number | null;
};

const CRYPTO_BINANCE: Record<string, string> = {
	BTC: 'BTCUSDT', BTCUSD: 'BTCUSDT', 'BTC-USD': 'BTCUSDT',
	ETH: 'ETHUSDT', ETHUSD: 'ETHUSDT', 'ETH-USD': 'ETHUSDT',
	SOL: 'SOLUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', ADA: 'ADAUSDT',
	AVAX: 'AVAXUSDT', LINK: 'LINKUSDT', LTC: 'LTCUSDT', MATIC: 'MATICUSDT',
	DOT: 'DOTUSDT', BNB: 'BNBUSDT', SHIB: 'SHIBUSDT',
};

const CRYPTO_COINGECKO: Record<string, string> = {
	BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
	DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink',
	LTC: 'litecoin', MATIC: 'matic-network', DOT: 'polkadot', BNB: 'binancecoin', SHIB: 'shiba-inu',
};
const COINGECKO_HISTORY_DAYS:Record<string,string>={'5d':'7','1mo':'30','3mo':'90','1y':'365','5y':'max'};

const FX_BASES = new Set(['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD']);

const YAHOO_ALIASES: Record<string, string> = {
	DJI: '^DJI', SPX: '^GSPC', NASDAQ: '^IXIC', SP100: '^OEX', NDX: '^NDX',
	DAX: '^GDAXI', IBEX: '^IBEX', NIKKEI: '^N225', MERV: '^MERV',
	EURGBP: 'EURGBP=X', EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X',
	BTC: 'BTC-USD', ETH: 'ETH-USD',
	AAPL: 'AAPL', MSFT: 'MSFT', NVDA: 'NVDA', AMZN: 'AMZN', GOOGL: 'GOOGL', TSLA: 'TSLA',
	XAU: 'GC=F', XAG: 'SI=F', GOLD: 'GC=F', SILVER: 'SI=F',
};

const STOOQ_ALIASES: Record<string, string> = {
	DJI: '^dji', SPX: '^spx', NASDAQ: '^ndq',
	AAPL: 'aapl.us', MSFT: 'msft.us', NVDA: 'nvda.us', AMZN: 'amzn.us', GOOGL: 'googl.us', TSLA: 'tsla.us',
};

function normalizeSymbol(symbol: string) {
	return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: 'application/json,text/csv,*/*',
				'User-Agent': 'AureviaExchange/1.0 (platform free-market)',
			},
			cache: 'no-store',
		});
		if (!response.ok) return null;
		const type = response.headers.get('content-type') || '';
		if (type.includes('json')) return await response.json();
		const text = await response.text();
		try { return JSON.parse(text); } catch { return text; }
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function quoteBinance(symbol: string): Promise<FreeQuote | null> {
	const key = normalizeSymbol(symbol);
	const pair = CRYPTO_BINANCE[symbol] || CRYPTO_BINANCE[key] || CRYPTO_BINANCE[symbol.toUpperCase()];
	if (!pair) return null;
	const data = (await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`)) as
		| {lastPrice?: string; prevClosePrice?: string; priceChange?: string; priceChangePercent?: string} | null;
	const price = data?.lastPrice ? Number(data.lastPrice) : NaN;
	if (!Number.isFinite(price) || price <= 0) return null;
	const previousClose = data?.prevClosePrice ? Number(data.prevClosePrice) : null;
	const change = data?.priceChange ? Number(data.priceChange) : previousClose != null ? price - previousClose : 0;
	const changePercent = data?.priceChangePercent ? Number(data.priceChangePercent) : previousClose ? ((price - previousClose) / previousClose) * 100 : 0;
	return {
		symbol, price,
		previousClose: Number.isFinite(previousClose as number) ? previousClose : null,
		change: Number.isFinite(change) ? change : 0,
		changePercent: Number.isFinite(changePercent) ? changePercent : 0,
		updatedAt: new Date().toISOString(), source: 'Binance', isStale: false,
	};
}

async function quoteCoinGecko(symbol: string): Promise<FreeQuote | null> {
	const id = CRYPTO_COINGECKO[normalizeSymbol(symbol)] || CRYPTO_COINGECKO[symbol.toUpperCase()];
	if (!id) return null;
	const data = (await fetchJson(
		`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`,
	)) as Record<string, {usd?: number; usd_24h_change?: number}> | null;
	const price = data?.[id]?.usd;
	if (!Number.isFinite(price) || !price || price <= 0) return null;
	const changePercent = data?.[id]?.usd_24h_change ?? 0;
	const change = (price * changePercent) / 100;
	return {
		symbol, price, previousClose: price - change, change, changePercent,
		updatedAt: new Date().toISOString(), source: 'CoinGecko', isStale: false,
	};
}

async function quoteFrankfurter(symbol: string): Promise<FreeQuote | null> {
	const raw = symbol.toUpperCase().replace(/[^A-Z]/g, '');
	let base = '';
	let quote = 'USD';
	if (raw.length === 6 && FX_BASES.has(raw.slice(0, 3))) {
		base = raw.slice(0, 3); quote = raw.slice(3, 6);
	} else if (raw === 'EURGBP') {
		base = 'EUR'; quote = 'GBP';
	} else if (FX_BASES.has(raw) || raw.endsWith('USD')) {
		base = raw.replace('USD', ''); quote = 'USD';
	} else return null;
	if (!FX_BASES.has(base)) return null;
	const data = (await fetchJson(`https://api.frankfurter.app/latest?from=${base}&to=${quote}`)) as
		| {rates?: Record<string, number>; date?: string} | null;
	const rate = data?.rates?.[quote];
	if (!Number.isFinite(rate) || !rate || rate <= 0) return null;
	return {
		symbol, price: rate, previousClose: null, change: 0, changePercent: 0,
		updatedAt: data?.date ? new Date(`${data.date}T16:00:00.000Z`).toISOString() : new Date().toISOString(),
		source: 'Frankfurter', isStale: false,
	};
}

async function quoteYahoo(symbol: string): Promise<FreeQuote | null> {
	const key = normalizeSymbol(symbol);
	const yahoo = YAHOO_ALIASES[key] || YAHOO_ALIASES[symbol.toUpperCase()] ||
		(symbol.includes('^') || symbol.includes('=') ? symbol : symbol.toUpperCase());
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=5m&range=1d`;
	const data = (await fetchJson(url)) as {
		chart?: {result?: Array<{
			meta?: {regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number; previousClose?: number};
			indicators?: {quote?: Array<{close?: Array<number | null>}>};
		}>};
	} | null;
	const result = data?.chart?.result?.[0];
	const meta = result?.meta;
	const price = meta?.regularMarketPrice;
	if (!Number.isFinite(price) || !price || price <= 0) return null;
	const previousClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
	const change = previousClose != null ? price - previousClose : 0;
	const changePercent = previousClose ? (change / previousClose) * 100 : 0;
	const closes = (result?.indicators?.quote?.[0]?.close || []).filter((v): v is number => typeof v === 'number');
	const ts = meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date();
	const ageMs = Date.now() - ts.getTime();
	return {
		symbol, price,
		previousClose: Number.isFinite(previousClose as number) ? previousClose : null,
		change, changePercent, updatedAt: ts.toISOString(),
		source: 'Yahoo Finance', isStale: ageMs > 24 * 60 * 60 * 1000, sparkline: closes.slice(-24),
	};
}

async function quoteStooq(symbol: string): Promise<FreeQuote | null> {
	const key = normalizeSymbol(symbol);
	const stooq = STOOQ_ALIASES[key] || STOOQ_ALIASES[symbol.toUpperCase()];
	if (!stooq) return null;
	const text = (await fetchJson(`https://stooq.com/q/l/?s=${encodeURIComponent(stooq)}&f=sd2t2ohlcv&h&e=csv`)) as string | null;
	if (!text || typeof text !== 'string') return null;
	const lines = text.trim().split(/\r?\n/);
	if (lines.length < 2) return null;
	const cols = lines[1].split(',');
	const close = Number(cols[6]);
	if (!Number.isFinite(close) || close <= 0) return null;
	const open = Number(cols[3]);
	const change = Number.isFinite(open) ? close - open : 0;
	const changePercent = open ? (change / open) * 100 : 0;
	return {
		symbol, price: close, previousClose: Number.isFinite(open) ? open : null,
		change, changePercent, updatedAt: new Date().toISOString(), source: 'Stooq', isStale: false,
	};
}

export async function getFreeMarketQuote(symbol: string): Promise<FreeQuote | null> {
	for (const attempt of [quoteBinance, quoteCoinGecko, quoteFrankfurter, quoteYahoo, quoteStooq]) {
		try {
			const quote = await attempt(symbol);
			if (quote) return quote;
		} catch { /* next */ }
	}
	return null;
}

export async function getFreeMarketQuotes(symbols: string[]): Promise<Map<string, FreeQuote>> {
	const unique = [...new Set(symbols.map(s => s.trim()).filter(Boolean))];
	const result = new Map<string, FreeQuote>();
	const concurrency = 4;
	for (let i = 0; i < unique.length; i += concurrency) {
		const slice = unique.slice(i, i + concurrency);
		const quotes = await Promise.all(slice.map(symbol => getFreeMarketQuote(symbol)));
		slice.forEach((symbol, index) => {
			const quote = quotes[index];
			if (quote) result.set(symbol, quote);
		});
	}
	return result;
}

export async function getFreeMarketHistory(symbol: string, range = '1mo'): Promise<FreeCandle[]> {
	const key = normalizeSymbol(symbol);
	const yahoo = YAHOO_ALIASES[key] || YAHOO_ALIASES[symbol.toUpperCase()] || symbol;
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}?interval=1d&range=${encodeURIComponent(range)}`;
	const data = (await fetchJson(url, 12_000)) as {
		chart?: {result?: Array<{
			timestamp?: number[];
			indicators?: {quote?: Array<{open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null>}>};
		}>};
	} | null;
	const result = data?.chart?.result?.[0];
	const times = result?.timestamp || [];
	const q = result?.indicators?.quote?.[0];
	if (!times.length || !q) return [];
	const candles: FreeCandle[] = [];
	for (let i = 0; i < times.length; i++) {
		const open = q.open?.[i]; const high = q.high?.[i]; const low = q.low?.[i]; const close = q.close?.[i];
		if ([open, high, low, close].some(v => !Number.isFinite(v as number))) continue;
		candles.push({
			time: times[i], open: open as number, high: high as number, low: low as number, close: close as number,
			volume: Number.isFinite(q.volume?.[i] as number) ? (q.volume?.[i] as number) : null,
		});
	}
	return candles;
}

export async function getFreeMarketCryptoHistory(symbol:string,range='1mo'):Promise<FreeCandle[]>{
	const id=CRYPTO_COINGECKO[normalizeSymbol(symbol)]||CRYPTO_COINGECKO[symbol.toUpperCase()];
	const days=COINGECKO_HISTORY_DAYS[range];
	if(!id||!days)return [];
	const data=await fetchJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=${days}`,12_000);
	if(!Array.isArray(data))return [];
	return data.flatMap(row=>{
		if(!Array.isArray(row)||row.length<5)return [];
		const [timestamp,open,high,low,close]=row;
		if(![timestamp,open,high,low,close].every(value=>typeof value==='number'&&Number.isFinite(value))||timestamp<=0||open<=0||high<=0||low<=0||close<=0)return [];
		return [{time:Math.floor(timestamp/1000),open,high,low,close,volume:null}];
	}).sort((left,right)=>left.time-right.time);
}

export async function probeFreeMarketProviders(): Promise<
	Array<{source: string; ok: boolean; sampleSymbol: string; price?: number; error?: string}>
> {
	const probes: Array<{source: string; symbol: string; run: () => Promise<FreeQuote | null>}> = [
		{source: 'Binance', symbol: 'BTC', run: () => quoteBinance('BTC')},
		{source: 'CoinGecko', symbol: 'ETH', run: () => quoteCoinGecko('ETH')},
		{source: 'Frankfurter', symbol: 'EURUSD', run: () => quoteFrankfurter('EURUSD')},
		{source: 'Yahoo Finance', symbol: 'SPX', run: () => quoteYahoo('SPX')},
		{source: 'Stooq', symbol: 'AAPL', run: () => quoteStooq('AAPL')},
	];
	const results = [];
	for (const probe of probes) {
		try {
			const quote = await probe.run();
			results.push({source: probe.source, ok: !!quote, sampleSymbol: probe.symbol, ...(quote ? {price: quote.price} : {error: 'No quote'})});
		} catch (error) {
			results.push({source: probe.source, ok: false, sampleSymbol: probe.symbol, error: error instanceof Error ? error.message : 'Probe failed'});
		}
	}
	return results;
}
