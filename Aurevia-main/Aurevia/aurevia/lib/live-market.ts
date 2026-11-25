export type MarketAssetType='INDEX'|'STOCK'|'FOREX'|'CRYPTO';

export type LiveMarketAsset={
	id:string;
	ticker:string;
	name:string;
	type:MarketAssetType;
	currency:string;
};

export type MarketQuote={
	asset:LiveMarketAsset;
	price:number;
	bid?:number|null;
	ask?:number|null;
	change:number;
	changePercent:number;
	marketStatus?:'OPEN'|'CLOSED'|'PREMARKET'|'AFTER_HOURS'|'UNKNOWN';
	previousClose:number|null;
	open:number|null;
	volume:number|null;
	dayLow:number|null;
	dayHigh:number|null;
	fiftyTwoWeekLow:number|null;
	fiftyTwoWeekHigh:number|null;
	updatedAt:string;
	isStale?:boolean;
	staleReason?:string;
	sparkline:number[];
	source:string;
};

export type MarketCandle={
	time:number;
	open:number;
	high:number;
	low:number;
	close:number;
	volume:number|null;
};

export const MARKET_ASSETS:LiveMarketAsset[]=[
	{id:'DJI',ticker:'^DJI',name:'Dow Jones Industrial Average',type:'INDEX',currency:'USD'},
	{id:'SPX',ticker:'^GSPC',name:'S&P 500',type:'INDEX',currency:'USD'},
	{id:'NASDAQ',ticker:'^IXIC',name:'NASDAQ Composite',type:'INDEX',currency:'USD'},
	{id:'SP100',ticker:'^OEX',name:'S&P 100',type:'INDEX',currency:'USD'},
	{id:'NDX',ticker:'^NDX',name:'NASDAQ 100',type:'INDEX',currency:'USD'},
	{id:'DAX',ticker:'^GDAXI',name:'DAX Performance Index',type:'INDEX',currency:'EUR'},
	{id:'IBEX',ticker:'^IBEX',name:'IBEX 35',type:'INDEX',currency:'EUR'},
	{id:'NIKKEI',ticker:'^N225',name:'Nikkei 225',type:'INDEX',currency:'JPY'},
	{id:'MERV',ticker:'^MERV',name:'S&P Merval',type:'INDEX',currency:'ARS'},
	{id:'EURGBP',ticker:'EURGBP=X',name:'Euro / British Pound',type:'FOREX',currency:'GBP'},
	{id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},
	{id:'ETH',ticker:'ETH-USD',name:'Ethereum USD',type:'CRYPTO',currency:'USD'},
	{id:'EURUSD',ticker:'EURUSD=X',name:'Euro / US Dollar',type:'FOREX',currency:'USD'},
	{id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD'},
	{id:'MSFT',ticker:'MSFT',name:'Microsoft Corporation',type:'STOCK',currency:'USD'},
	{id:'NVDA',ticker:'NVDA',name:'NVIDIA Corporation',type:'STOCK',currency:'USD'},
	{id:'AMZN',ticker:'AMZN',name:'Amazon.com, Inc.',type:'STOCK',currency:'USD'},
	{id:'GOOGL',ticker:'GOOGL',name:'Alphabet Inc.',type:'STOCK',currency:'USD'},
	{id:'TSLA',ticker:'TSLA',name:'Tesla, Inc.',type:'STOCK',currency:'USD'},
];

export const DEFAULT_WATCHLIST=['DJI','SPX','NASDAQ','DAX','NIKKEI','BTC','ETH','EURGBP','EURUSD','IBEX','MERV'];
export const COMPARISON_SYMBOLS=['SPX','NASDAQ','SP100','NDX'];

export const TIMEFRAMES=[
	{id:'1m',label:'1m',range:'1d',interval:'1m'},
	{id:'5m',label:'5m',range:'5d',interval:'5m'},
	{id:'15m',label:'15m',range:'1mo',interval:'15m'},
	{id:'30m',label:'30m',range:'3mo',interval:'30m'},
	{id:'1h',label:'1h',range:'1y',interval:'1h'},
	{id:'4h',label:'4h',range:'1y',interval:'4h'},
	{id:'1d',label:'1D',range:'5y',interval:'1d'},
	{id:'1w',label:'1W',range:'5y',interval:'1wk'},
	{id:'1mo',label:'1M',range:'5y',interval:'1mo'},
	{id:'ytd',label:'YTD',range:'ytd',interval:'1d'},
	{id:'1y',label:'1Y',range:'1y',interval:'1d'},
	{id:'5y',label:'5Y',range:'5y',interval:'1wk'},
] as const;

export type TimeframeId=(typeof TIMEFRAMES)[number]['id'];
export const MARKET_UI_REFRESH_INTERVAL_MS=1_000;

export type MarketProviderDiagnostic={
	status:'succeeded'|'failed'|'not_configured'|'skipped';
	reason?:string;
	httpStatus?:number;
	providerCode?:string;
};
export type MarketHistoryDiagnostics={
	selectedProvider:'Twelve Data'|'Finnhub'|'Alpha Vantage'|'Financial Modeling Prep'|'none';
	providers:Record<string,MarketProviderDiagnostic>;
};

export class MarketDataError extends Error{
	constructor(message:string,readonly status=502,readonly diagnostics?:MarketHistoryDiagnostics){
		super(message);
		this.name='MarketDataError';
	}
}

export function getMarketAsset(id:string){
	return MARKET_ASSETS.find(asset=>asset.id===id.toUpperCase());
}

export function getMarketAssetForTradingSymbol(symbol:string){
	const normalized=symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');
	return MARKET_ASSETS.find(asset=>[asset.id,asset.ticker].some(value=>value.toUpperCase().replace(/[^A-Z0-9]/g,'')===normalized));
}

export function isExternalMarketDataSource(source:string){
	return source==='Twelve Data'||source==='Finnhub'||source==='Alpha Vantage'||source==='Financial Modeling Prep';
}

export function isMarketExecutionQuoteSource(source:string){
	return isExternalMarketDataSource(source)||['Binance','CoinGecko','Frankfurter','Yahoo Finance','Stooq'].includes(source);
}

export function filterSupportedMarketAssets<T extends {symbol:string}>(assets:T[]){
	return assets.filter(asset=>!!getMarketAsset(asset.symbol));
}
