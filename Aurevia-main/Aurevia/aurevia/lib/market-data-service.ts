import {MarketDataError,TIMEFRAMES,type LiveMarketAsset,type MarketQuote,type TimeframeId} from '@/lib/live-market';
import type {ServerConfiguration} from '@/lib/config/env';
import {getConfiguredMarketHistory,getConfiguredMarketIndicator,getConfiguredMarketQuote,getConfiguredMarketSearch,type MarketProviderKeys} from '@/lib/market-data/provider-manager';
import type {TwelveDataIndicator} from '@/lib/providers/twelve-data-market-data';
import {getFreeMarketCryptoHistory,getFreeMarketHistory,getFreeMarketQuote} from '@/lib/free-market-quotes';

const maximumFreshQuoteAgeMs=5*60_000;

export function getAdditionalMarketProviderKeys(marketData:ServerConfiguration['marketData']):MarketProviderKeys{
	return {
		twelveDataApiKey:marketData.twelveDataApiKey,
		twelveDataBaseUrl:marketData.twelveDataBaseUrl,
		productionLicenseConfirmed:marketData.productionLicenseConfirmed,
		finnhubApiKey:marketData.finnhubApiKey,
		alphaVantageApiKey:marketData.alphaVantageApiKey,
		fmpApiKey:marketData.fmpApiKey,
	};
}

function freeSymbolCandidates(asset:LiveMarketAsset){
	return [asset.id, asset.ticker, asset.ticker.replace(/=X$/,''), asset.ticker.replace(/^\^/,''), asset.name.split(' ')[0]].filter(Boolean);
}

async function quoteFromFreeProviders(asset:LiveMarketAsset):Promise<MarketQuote|null>{
	for(const symbol of freeSymbolCandidates(asset)){
		const free=await getFreeMarketQuote(symbol);
		if(!free)continue;
		const previousClose=free.previousClose??null;
		const change=free.change??(previousClose!=null?free.price-previousClose:0);
		const changePercent=free.changePercent??(previousClose?((free.price-previousClose)/previousClose)*100:0);
		return {
			asset,
			price:free.price,
			bid:null,
			ask:null,
			change,
			changePercent,
			marketStatus:'UNKNOWN',
			previousClose,
			open:null,
			volume:null,
			dayLow:null,
			dayHigh:null,
			fiftyTwoWeekLow:null,
			fiftyTwoWeekHigh:null,
			updatedAt:free.updatedAt,
			isStale:free.isStale,
			...(free.isStale?{staleReason:'Free provider mark may be delayed.'}:{}),
			sparkline:free.sparkline||[],
			source:free.source,
		};
	}
	return null;
}

export async function getMarketQuoteWithFallback(asset:LiveMarketAsset,providers:MarketProviderKeys){
	if(process.env.AUREVIA_E2E_DISABLE_EXTERNAL_MARKET_DATA==='1'){
		throw new MarketDataError('Configured market-data providers could not return a usable quote.',503);
	}

	// 1) Configured paid/env providers
	let staleQuote:MarketQuote|null=null;
	try{
		const quote=await getConfiguredMarketQuote(asset,providers);
		if(quote){
			const timestamp=Date.parse(quote.updatedAt);
			if(Number.isFinite(timestamp)){
				const age=Date.now()-timestamp;
				if(age>=-5_000){
					const normalized={
						...quote,
						isStale:age>maximumFreshQuoteAgeMs,
						...(age>maximumFreshQuoteAgeMs?{staleReason:'Provider quote timestamp is older than five minutes.'}:{}),
					};
					if(!normalized.isStale)return normalized;
					staleQuote=normalized;
				}
			}
		}
	}catch{/* fall through to free */ }

	// 2) Free built-in providers (always on, no API keys)
	const free=await quoteFromFreeProviders(asset);
	if(free){
		const timestamp=Date.parse(free.updatedAt);
		const age=Date.now()-timestamp;
		const isStale=free.isStale||!Number.isFinite(timestamp)||age < -5_000||age>maximumFreshQuoteAgeMs;
		const normalized={
			...free,
			isStale,
			...(isStale?{staleReason:free.staleReason||'Free provider quote is older than five minutes or has an invalid timestamp.'}:{}),
		};
		if(!isStale)return normalized;
		if(!staleQuote||timestamp>Date.parse(staleQuote.updatedAt))staleQuote=normalized;
	}
	if(staleQuote)return staleQuote;

	throw new MarketDataError('Configured market-data providers and free fallbacks could not return a usable quote.',503);
}

export async function getMarketHistoryWithFallback(
	asset:LiveMarketAsset,timeframe:TimeframeId,providers:MarketProviderKeys,
){
	if(process.env.AUREVIA_E2E_DISABLE_EXTERNAL_MARKET_DATA==='1'){
		throw new MarketDataError('Configured market-data providers could not return historical candles.',503);
	}

	try{
		const history=await getConfiguredMarketHistory(asset,timeframe,providers);
		if(history&&history.candles.length){
			const selection=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
			return {
				quote:null,
				candles:history.candles,
				timeframe,
				interval:selection.interval,
				source:history.source,
			};
		}
	}catch{/* free history */ }

	const range=timeframe==='1m'||timeframe==='5m'||timeframe==='15m'?'5d':timeframe==='1y'?'1y':'1mo';
	if(asset.type==='CRYPTO'){
		const candles=await getFreeMarketCryptoHistory(asset.id,range);
		if(candles.length){
			const selection=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
			return {quote:null,candles,timeframe,interval:selection.interval,source:'CoinGecko'};
		}
	}
	for(const symbol of freeSymbolCandidates(asset)){
		const candles=await getFreeMarketHistory(symbol, range);
		if(candles.length){
			const selection=TIMEFRAMES.find(item=>item.id===timeframe)??TIMEFRAMES[0];
			return {
				quote:null,
				candles,
				timeframe,
				interval:selection.interval,
				source:'Yahoo Finance',
			};
		}
	}
	throw new MarketDataError('Configured market-data providers and free fallbacks could not return historical candles.',503);
}

export async function searchMarketSymbols(query:string,limit:number,providers:MarketProviderKeys){
	const results=await getConfiguredMarketSearch(query,limit,providers);
	if(!results)throw new MarketDataError('Twelve Data market search is not configured or available.',503);
	return results;
}

export async function getMarketIndicator(
	symbol:string,indicator:TwelveDataIndicator,timeframe:TimeframeId,outputsize:number,providers:MarketProviderKeys,
){
	const selection=TIMEFRAMES.find(item=>item.id===timeframe);
	if(!selection)throw new MarketDataError('Unsupported indicator timeframe.',400);
	const result=await getConfiguredMarketIndicator(symbol,indicator,selection.interval,outputsize,providers);
	if(!result)throw new MarketDataError('Twelve Data technical indicators are not configured or available.',503);
	return result;
}
