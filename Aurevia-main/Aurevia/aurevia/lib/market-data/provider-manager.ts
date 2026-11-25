import Bottleneck from 'bottleneck';
import {createHash} from 'node:crypto';
import {LRUCache} from 'lru-cache';
import type {LiveMarketAsset,MarketCandle,MarketQuote,TimeframeId} from '@/lib/live-market';
import {TIMEFRAMES} from '@/lib/live-market';
import {TwelveDataMarketProvider} from '@/lib/providers/twelve-data-market-data';
import type {TwelveDataIndicator} from '@/lib/providers/twelve-data-market-data';
import {AlphaVantageMarketProvider,FinancialModelingPrepMarketProvider,FinnhubMarketProvider} from '@/lib/providers/fallback-market-data';
import type {MarketProviderHttpError} from '@/lib/providers/market-data-http';
import {aggregateChartCandles,normalizeChartCandles} from '@/lib/chart-candles';

export type MarketProviderKeys={
	twelveDataApiKey:string;
	twelveDataBaseUrl:string;
	productionLicenseConfirmed:boolean;
	finnhubApiKey?:string;
	alphaVantageApiKey?:string;
	fmpApiKey?:string;
};

type ProviderId='twelveData'|'finnhub'|'alphaVantage'|'fmp';
type ProviderState={
	fingerprint:string;
	status:'CONNECTED'|'ERROR';
	checkedAt:string;
	responseTimeMs:number;
	lastSuccessfulRequestAt?:string;
	lastDataAt?:string;
	failureUntil?:number;
	errorCode?:string;
	rateLimitErrors:number;
	providerErrors:number;
};
type Adapter={
	id:ProviderId;
	name:string;
	key:string;
	baseUrl?:string;
	categories:readonly LiveMarketAsset['type'][];
	quoteCategories?:readonly LiveMarketAsset['type'][];
	historyIntervals?:readonly string[];
	getQuote?:(asset:LiveMarketAsset)=>Promise<MarketQuote>;
	getHistory?:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>Promise<MarketCandle[]>;
	search?:(query:string,limit:number)=>Promise<unknown[]>;
	getIndicator?:(symbol:string,indicator:TwelveDataIndicator,interval:string,outputsize:number)=>Promise<unknown>;
	getMarketState?:()=>Promise<unknown[]>;
};

const providerHealth=new LRUCache<ProviderId,ProviderState>({max:4,ttl:10*60_000});
const symbolFailures=new LRUCache<string,true>({max:2_000,ttl:10*60_000});
const quoteCache=new LRUCache<string,MarketQuote>({max:400,ttl:3_000});
const pendingQuoteRequests=new Map<string,Promise<MarketQuote>>();
// Historical candles are comparatively stable; retain them longer so chart refreshes
// and repeated page visits do not queue redundant Twelve Data requests. Live quote
// updates continue independently through the short-lived quote cache.
const historyCache=new LRUCache<string,Promise<MarketCandle[]>>({max:200,ttl:5*60_000});
const searchCache=new LRUCache<string,Promise<unknown[]>>({max:100,ttl:60*60_000});
const indicatorCache=new LRUCache<string,Promise<unknown>>({max:200,ttl:5*60_000});
const marketStateCache=new LRUCache<string,Promise<unknown[]>>({max:1,ttl:60_000});
const isolatedTwelveDataMock=(()=>{
	if(process.env.AUREVIA_E2E_TWELVE_DATA_MOCK!=='1'||!process.env.AUREVIA_E2E_DATABASE_URL)return false;
	try{
		const databaseUrl=new URL(process.env.AUREVIA_E2E_DATABASE_URL);
		const databaseName=decodeURIComponent(databaseUrl.pathname.replace(/^\/+/,''));
		return ['postgresql:','postgres:'].includes(databaseUrl.protocol)
			&&['localhost','127.0.0.1','::1'].includes(databaseUrl.hostname)
			&&/_e2e$/i.test(databaseName)
			&&process.env.TWELVE_DATA_API_KEY==='aurevia-e2e-only-not-a-real-key';
	}catch{return false}
})();
const limiters={
	twelveData:new Bottleneck({
		maxConcurrent:isolatedTwelveDataMock?20:1,
		minTime:isolatedTwelveDataMock?0:8_000,
		highWater:isolatedTwelveDataMock?100:8,
		strategy:Bottleneck.strategy.OVERFLOW,
	}),
	finnhub:new Bottleneck({maxConcurrent:1,minTime:1_000,highWater:8,strategy:Bottleneck.strategy.OVERFLOW}),
	alphaVantage:new Bottleneck({maxConcurrent:1,minTime:12_000,highWater:4,strategy:Bottleneck.strategy.OVERFLOW}),
	fmp:new Bottleneck({maxConcurrent:1,minTime:1_000,highWater:8,strategy:Bottleneck.strategy.OVERFLOW}),
};

function fingerprint(key:string){return createHash('sha256').update(key).digest('hex')}
function adapters(keys:MarketProviderKeys):Adapter[]{
	return [
		...(keys.twelveDataApiKey?[{
			id:'twelveData' as const,name:'Twelve Data',key:keys.twelveDataApiKey,baseUrl:keys.twelveDataBaseUrl,
			categories:['STOCK','FOREX','CRYPTO'] as const,historyIntervals:['1m','5m','15m','30m','1h','1wk','1mo','1d'],
			getQuote:(asset:LiveMarketAsset)=>provider().getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>provider().getHistory(asset,from,to,interval),
			search:(query:string,limit:number)=>provider().search(query,limit),
			getIndicator:(symbol:string,indicator:TwelveDataIndicator,interval:string,outputsize:number)=>provider().getIndicator(symbol,indicator,interval,outputsize),
			getMarketState:()=>provider().getMarketState(),
		}]:[]),
		...(keys.finnhubApiKey?[{
			id:'finnhub' as const,name:'Finnhub',key:keys.finnhubApiKey,categories:['STOCK'] as const,
			historyIntervals:['1m','5m','15m','30m','1h','1wk','1mo','1d'],
			getQuote:(asset:LiveMarketAsset)=>new FinnhubMarketProvider({apiKey:keys.finnhubApiKey!}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>new FinnhubMarketProvider({apiKey:keys.finnhubApiKey!}).getHistory(asset,from,to,interval),
		}]:[]),
		...(keys.fmpApiKey?[{
			id:'fmp' as const,name:'Financial Modeling Prep',key:keys.fmpApiKey,categories:['STOCK','INDEX'] as const,
			historyIntervals:['1m','5m','15m','30m','1h','1d'],
			getQuote:(asset:LiveMarketAsset)=>new FinancialModelingPrepMarketProvider({apiKey:keys.fmpApiKey!}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>new FinancialModelingPrepMarketProvider({apiKey:keys.fmpApiKey!}).getHistory(asset,from,to,interval),
		}]:[]),
		...(keys.alphaVantageApiKey?[{
			id:'alphaVantage' as const,name:'Alpha Vantage',key:keys.alphaVantageApiKey,categories:['STOCK','FOREX','CRYPTO'] as const,
			quoteCategories:['STOCK'] as const,
			historyIntervals:['1m','5m','15m','30m','1h','1wk','1mo','1d'],
			getQuote:(asset:LiveMarketAsset)=>new AlphaVantageMarketProvider({apiKey:keys.alphaVantageApiKey!}).getQuote(asset),
			getHistory:(asset:LiveMarketAsset,from:string,to:string,interval:string)=>new AlphaVantageMarketProvider({apiKey:keys.alphaVantageApiKey!}).getHistory(asset,from,to,interval),
		}]:[]),
	];
	function provider(){
		return new TwelveDataMarketProvider({apiKey:keys.twelveDataApiKey,baseUrl:keys.twelveDataBaseUrl});
	}
}

function recordFailure(adapter:Adapter,error:unknown,responseTimeMs:number){
	const now=Date.now();
	const errorCode=providerErrorCode(error);
	const current=providerHealth.get(adapter.id);
	const sameCredential=current?.fingerprint===fingerprint(adapter.key);
	const providerUnavailable=['AUTHENTICATION_FAILED','SUBSCRIPTION_RESTRICTED','RATE_LIMITED','NETWORK_OR_TIMEOUT','PROVIDER_SERVER_ERROR'].includes(errorCode);
	const retryAfter=(error instanceof Error&&'retryAfterMs'in error&&typeof error.retryAfterMs==='number')
		?error.retryAfterMs:undefined;
	const rateLimitErrors=(sameCredential?current.rateLimitErrors:0)+(errorCode==='RATE_LIMITED'?1:0);
	const rateLimitCooldown=Math.min(60_000*2**Math.min(rateLimitErrors-1,4),15*60_000);
	const cooldown=errorCode==='RATE_LIMITED'?Math.max(retryAfter??0,rateLimitCooldown):30_000;
	providerHealth.set(adapter.id,{
		fingerprint:fingerprint(adapter.key),status:'ERROR',checkedAt:new Date(now).toISOString(),
		responseTimeMs,
		...(sameCredential&&current.lastSuccessfulRequestAt?{lastSuccessfulRequestAt:current.lastSuccessfulRequestAt}:{}),
		...(sameCredential&&current.lastDataAt?{lastDataAt:current.lastDataAt}:{}),
		...(providerUnavailable?{failureUntil:now+cooldown}:{}),errorCode,
		rateLimitErrors,
		providerErrors:(sameCredential?current.providerErrors:0)+1,
	});
}

function recordSuccess(adapter:Adapter,result:unknown,responseTimeMs:number){
	const now=new Date().toISOString();
	const current=providerHealth.get(adapter.id);
	const sameCredential=current?.fingerprint===fingerprint(adapter.key);
	const dataAt=result&&typeof result==='object'&&'updatedAt'in result&&typeof result.updatedAt==='string'
		?result.updatedAt
		:undefined;
	providerHealth.set(adapter.id,{
		fingerprint:fingerprint(adapter.key),status:'CONNECTED',checkedAt:now,lastSuccessfulRequestAt:now,
		responseTimeMs,
		...(dataAt?{lastDataAt:dataAt}:sameCredential&&current.lastDataAt?{lastDataAt:current.lastDataAt}:{}),
		rateLimitErrors:sameCredential?current.rateLimitErrors:0,
		providerErrors:sameCredential?current.providerErrors:0,
	});
}

function isCircuitOpen(adapter:Adapter){
	const current=providerHealth.get(adapter.id);
	if(!current||current.fingerprint!==fingerprint(adapter.key)||current.status!=='ERROR')return false;
	return (current.failureUntil??0)>Date.now();
}

function symbolFailureKey(adapter:Adapter,operation:'quote'|'history',asset:LiveMarketAsset){
	return `${adapter.id}:${fingerprint(adapter.key)}:${operation}:${asset.id}`;
}

function isSymbolCircuitOpen(adapter:Adapter,operation:'quote'|'history',asset:LiveMarketAsset){
	return symbolFailures.has(symbolFailureKey(adapter,operation,asset));
}

function isSymbolSpecificFailure(error:unknown){
	const code=providerErrorCode(error);
	const status=error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'
		?error.status:undefined;
	return code==='INVALID_PROVIDER_RESPONSE'||code==='PROVIDER_REJECTED'||status===400||status===404;
}

class ProviderCircuitOpenError extends Error{
	readonly code='CIRCUIT_OPEN';
	constructor(){super('Market provider circuit is open.')}
}

class SymbolCircuitOpenError extends Error{
	readonly code='SYMBOL_CIRCUIT_OPEN';
	constructor(){super('Market provider symbol is temporarily unavailable.')}
}

async function attempt<T>(
	adapter:Adapter,
	operation:()=>Promise<T>,
	priority=5,
	shouldSkip?:()=>boolean,
):Promise<T>{
	const startedAt=performance.now();
	let operationStarted=false;
	try{
		const result=await limiters[adapter.id].schedule({priority},()=>{
			if(isCircuitOpen(adapter))throw new ProviderCircuitOpenError();
			if(shouldSkip?.())throw new SymbolCircuitOpenError();
			operationStarted=true;
			return operation().then(result=>{
				recordSuccess(adapter,result,Math.max(0,Math.round(performance.now()-startedAt)));
				return result;
			},error=>{
				recordFailure(adapter,error,Math.max(0,Math.round(performance.now()-startedAt)));
				throw error;
			});
		});
		return result;
	}catch(error){
		if(error instanceof ProviderCircuitOpenError||error instanceof SymbolCircuitOpenError)throw error;
		if(!operationStarted)recordFailure(adapter,error,Math.max(0,Math.round(performance.now()-startedAt)));
		throw error;
	}
}

export async function getConfiguredMarketQuote(asset:LiveMarketAsset,keys:MarketProviderKeys):Promise<MarketQuote|null>{
	const candidates=adapters(keys).filter(adapter=>(adapter.quoteCategories??adapter.categories).includes(asset.type)&&adapter.getQuote);
	if(!candidates.length)return null;
	if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed)return null;
	let timedOutProviderFallbackUsed=false;
	for(const adapter of candidates){
		if(isCircuitOpen(adapter)||isSymbolCircuitOpen(adapter,'quote',asset))continue;
		const cacheKey=`${adapter.id}:${fingerprint(adapter.key)}:${asset.id}`;
		const cached=quoteCache.get(cacheKey);
		if(cached)return cached;
		const pending=pendingQuoteRequests.get(cacheKey);
		if(pending){
			try{return await pending}catch{continue}
		}
		const request=attempt(adapter,()=>adapter.getQuote!(asset),5,()=>isSymbolCircuitOpen(adapter,'quote',asset));
		pendingQuoteRequests.set(cacheKey,request);
		try{
			const quote=await request;
			quoteCache.set(cacheKey,quote);
			return quote;
		}catch(error){
			if(errorCode(error)==='CIRCUIT_OPEN'||errorCode(error)==='SYMBOL_CIRCUIT_OPEN')continue;
			if(isSymbolSpecificFailure(error))symbolFailures.set(symbolFailureKey(adapter,'quote',asset),true);
			logProviderFailure(adapter,asset.id,error);
			if(providerErrorCode(error)==='NETWORK_OR_TIMEOUT'){
				if(timedOutProviderFallbackUsed)break;
				timedOutProviderFallbackUsed=true;
			}
		}finally{
			if(pendingQuoteRequests.get(cacheKey)===request)pendingQuoteRequests.delete(cacheKey);
		}
	}
	return null;
}

export async function getConfiguredMarketHistory(
	asset:LiveMarketAsset,timeframe:TimeframeId,keys:MarketProviderKeys,
):Promise<{candles:MarketCandle[];source:string}|null>{
	const selection=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
	const end=new Date();
	const daysByRange:Record<string,number>={'1d':1,'5d':5,'1mo':31,'3mo':92,'1y':366,'5y':1827};
	const start=selection.range==='ytd'
		?new Date(Date.UTC(end.getUTCFullYear(),0,1))
		:new Date(end.getTime()-(daysByRange[selection.range]??1)*86_400_000);
	const candidates=adapters(keys).filter(adapter=>adapter.categories.includes(asset.type)&&adapter.getHistory&&(
		!adapter.historyIntervals||adapter.historyIntervals.includes(selection.interval)||
		(['1wk','1mo'].includes(selection.interval)&&adapter.historyIntervals.includes('1d'))
	));
	if(!candidates.length)return null;
	if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed)return null;
	for(const adapter of candidates){
		if(isCircuitOpen(adapter)||isSymbolCircuitOpen(adapter,'history',asset))continue;
		const cacheKey=`${adapter.id}:${fingerprint(adapter.key)}:${asset.id}:${timeframe}`;
		const cached=historyCache.get(cacheKey);
		if(cached)return {candles:await cached,source:adapter.name};
		try{
			const pending=attempt(adapter,async()=>{
				const sourceInterval=selection.interval==='4h'?'1h':
					adapter.historyIntervals&&!adapter.historyIntervals.includes(selection.interval)&&(['1wk','1mo'].includes(selection.interval))
						?'1d':selection.interval;
				const candles=await adapter.getHistory!(asset,start.toISOString(),end.toISOString(),sourceInterval);
				if(selection.interval==='4h')return aggregateChartCandles(candles,'4h');
				if(sourceInterval!==selection.interval&&(['1wk','1mo'].includes(selection.interval))){
					return aggregateChartCandles(candles,selection.interval as '1wk'|'1mo');
				}
				return normalizeChartCandles(candles);
			},0,()=>isSymbolCircuitOpen(adapter,'history',asset));
			historyCache.set(cacheKey,pending);
			let candles:MarketCandle[];
			try{candles=await pending}catch(error){historyCache.delete(cacheKey);throw error}
			if(!candles.length){historyCache.delete(cacheKey);throw new Error('NO_HISTORICAL_DATA')}
			return {candles,source:adapter.name};
		}catch(error){
			if(errorCode(error)==='CIRCUIT_OPEN'||errorCode(error)==='SYMBOL_CIRCUIT_OPEN')continue;
			if(isSymbolSpecificFailure(error))symbolFailures.set(symbolFailureKey(adapter,'history',asset),true);
			logProviderFailure(adapter,asset.id,error);
		}
	}
	return null;
}

function providerErrorCode(error:unknown){
	return error&&typeof error==='object'&&'code'in error&&typeof (error as MarketProviderHttpError).code==='string'
		?(error as MarketProviderHttpError).code:
		error instanceof Error&&error.message==='NO_HISTORICAL_DATA'?'NO_HISTORICAL_DATA':
		error&&typeof error==='object'&&'name'in error&&(error as {name?:unknown}).name==='BottleneckError'?'QUEUE_FULL':'INVALID_PROVIDER_RESPONSE';
}

function logProviderFailure(adapter:Adapter,symbol:string,error:unknown){
	const errorCode=providerErrorCode(error);
	if(errorCode!=='QUEUE_FULL'&&errorCode!=='NO_HISTORICAL_DATA'){
		const httpStatus=error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'
			?error.status:undefined;
		console.warn('[market-data] Provider request failed.',{
			provider:adapter.name,symbol,errorCode,...(httpStatus===undefined?{}:{httpStatus}),
		});
	}
}

function errorCode(error:unknown){
	return providerErrorCode(error);
}

function getTwelveDataAdapter(keys:MarketProviderKeys){
	if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed)return null;
	return adapters(keys).find(adapter=>adapter.id==='twelveData')??null;
}

export async function getConfiguredMarketSearch(query:string,limit:number,keys:MarketProviderKeys){
	const adapter=getTwelveDataAdapter(keys);
	if(!adapter?.search)return null;
	const cacheKey=`${fingerprint(adapter.key)}:${query.toLowerCase()}:${limit}`;
	const cached=searchCache.get(cacheKey);
	if(cached)return cached;
	const pending=attempt(adapter,()=>adapter.search!(query,limit));
	searchCache.set(cacheKey,pending);
	try{return await pending}catch(error){searchCache.delete(cacheKey);throw error}
}

export async function getConfiguredMarketIndicator(
	symbol:string,indicator:TwelveDataIndicator,interval:string,outputsize:number,keys:MarketProviderKeys,
){
	const adapter=getTwelveDataAdapter(keys);
	if(!adapter?.getIndicator)return null;
	const cacheKey=`${fingerprint(adapter.key)}:${symbol}:${indicator}:${interval}:${outputsize}`;
	const cached=indicatorCache.get(cacheKey);
	if(cached)return cached;
	const pending=attempt(adapter,()=>adapter.getIndicator!(symbol,indicator,interval,outputsize));
	indicatorCache.set(cacheKey,pending);
	try{return await pending}catch(error){indicatorCache.delete(cacheKey);throw error}
}

export async function getConfiguredMarketState(keys:MarketProviderKeys){
	const adapter=getTwelveDataAdapter(keys);
	if(!adapter?.getMarketState)return null;
	const cacheKey=fingerprint(adapter.key);
	const cached=marketStateCache.get(cacheKey);
	if(cached)return cached;
	const pending=attempt(adapter,()=>adapter.getMarketState!());
	marketStateCache.set(cacheKey,pending);
	try{return await pending}catch(error){marketStateCache.delete(cacheKey);throw error}
}

export async function getMarketProviderReadiness(keys:MarketProviderKeys,options:{force?:boolean}={}){
	const configured=adapters(keys);
	const byId=new Map(configured.map(adapter=>[adapter.id,adapter]));
	const specs=[
		{id:'twelveData' as const,name:'Twelve Data',variable:'TWELVE_DATA_API_KEY',categories:['STOCK','FOREX','CRYPTO'],capabilities:['quotes','intraday_candles','daily_weekly_monthly_history','symbol_search','technical_indicators','market_state'],rateLimit:'Requests are paced to one every 8 seconds; plan quotas and symbol access vary.'},
		{id:'finnhub' as const,name:'Finnhub',variable:'FINNHUB_API_KEY',categories:['STOCK'],capabilities:['stock_quotes','stock_candles'],rateLimit:'Requests are paced to one per second; plan quotas and symbol access vary.'},
		{id:'fmp' as const,name:'Financial Modeling Prep',variable:'FMP_API_KEY',categories:['STOCK','INDEX'],capabilities:['stock_quotes','index_quotes','historical_candles'],rateLimit:'Requests are paced to one per second; plan quotas and symbol access vary.'},
		{id:'alphaVantage' as const,name:'Alpha Vantage',variable:'ALPHA_VANTAGE_API_KEY',categories:['STOCK','FOREX','CRYPTO'],capabilities:['stock_quotes','stock_forex_crypto_history'],rateLimit:'Requests are paced to one every 12 seconds; plan quotas and symbol access vary.'},
	];
	return Promise.all(specs.map(async spec=>{
		const adapter=byId.get(spec.id);
		if(!adapter)return {...spec,configured:false,status:'NOT_CONFIGURED' as const,checkedAt:null,responseTimeMs:null};
		if(process.env.NODE_ENV==='production'&&!keys.productionLicenseConfirmed){
			return {...spec,configured:true,status:'LICENSE_REVIEW_REQUIRED' as const,checkedAt:null,responseTimeMs:null};
		}
		const current=providerHealth.get(spec.id);
		if(!options.force&&current?.fingerprint===fingerprint(adapter.key)&&current.status==='CONNECTED'){
			return {...spec,configured:true,status:'CONNECTED' as const,checkedAt:current.checkedAt,
				responseTimeMs:current.responseTimeMs,
				lastSuccessfulRequestAt:current.lastSuccessfulRequestAt??null,lastDataAt:current.lastDataAt??null,
				rateLimitErrors:current.rateLimitErrors,providerErrors:current.providerErrors};
		}
		if(!options.force&&current?.fingerprint===fingerprint(adapter.key)&&current.status==='ERROR'&&(current.failureUntil??0)>Date.now()){
			return {...spec,configured:true,status:'ERROR' as const,checkedAt:current.checkedAt,errorCode:current.errorCode,
				responseTimeMs:current.responseTimeMs,
				lastSuccessfulRequestAt:current.lastSuccessfulRequestAt??null,lastDataAt:current.lastDataAt??null,
				rateLimitErrors:current.rateLimitErrors,providerErrors:current.providerErrors};
		}
		try{
			if(!adapter.getQuote)return {...spec,configured:true,status:'NOT_CHECKED' as const,checkedAt:null,responseTimeMs:null};
			await attempt(adapter,()=>adapter.getQuote!({
				id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD',
			}));
			const health=providerHealth.get(spec.id);
			return {...spec,configured:true,status:'CONNECTED' as const,checkedAt:health?.checkedAt??new Date().toISOString(),
				responseTimeMs:health?.responseTimeMs??null,
				lastSuccessfulRequestAt:health?.lastSuccessfulRequestAt??null,lastDataAt:health?.lastDataAt??null,
				rateLimitErrors:health?.rateLimitErrors??0,providerErrors:health?.providerErrors??0};
		}catch(error){
			const health=providerHealth.get(spec.id);
			return {...spec,configured:true,status:'ERROR' as const,checkedAt:health?.checkedAt??new Date().toISOString(),errorCode:errorCode(error),
				responseTimeMs:health?.responseTimeMs??null,
				lastSuccessfulRequestAt:health?.lastSuccessfulRequestAt??null,lastDataAt:health?.lastDataAt??null,
				rateLimitErrors:health?.rateLimitErrors??0,providerErrors:health?.providerErrors??0};
		}
	}));
}
