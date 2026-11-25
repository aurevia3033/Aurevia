import {TIMEFRAMES,type MarketCandle,type MarketQuote,type TimeframeId} from '@/lib/live-market';

export type MarketHistoryResponse={
	quote:MarketQuote|null;
	candles:MarketCandle[];
	timeframe:TimeframeId;
	interval:string;
	source:string;
	isCached?:boolean;
	cachedAt?:string;
};

type CacheEntry={key:string;savedAt:number;data:MarketHistoryResponse};
type StorageLike=Pick<Storage,'getItem'|'setItem'>;

const storageKey='aurevia-market-history-cache';
const maximumEntries=8;
const maximumCandles=5_000;
const maximumAgeMs=7*24*60*60_000;

export function marketHistoryCacheKey(symbol:string,timeframe:TimeframeId){
	return `${symbol}:${timeframe}`;
}

function isMarketHistoryResponse(value:unknown):value is MarketHistoryResponse{
	if(!value||typeof value!=='object')return false;
	const response=value as Partial<MarketHistoryResponse>;
	return TIMEFRAMES.some(timeframe=>timeframe.id===response.timeframe)
		&&typeof response.interval==='string'
		&&typeof response.source==='string'
		&&response.quote===null
		&&Array.isArray(response.candles)
		&&response.candles.length<=maximumCandles
		&&response.candles.every(candle=>{
			if(!candle||typeof candle!=='object')return false;
			const item=candle as MarketCandle;
			return Number.isFinite(item.time)&&item.time>0
				&&[item.open,item.high,item.low,item.close].every(price=>Number.isFinite(price)&&price>0)
				&&(item.volume===null||Number.isFinite(item.volume));
		});
}

function readEntries(storage:StorageLike):CacheEntry[]{
	try{
		const parsed:unknown=JSON.parse(storage.getItem(storageKey)||'[]');
		if(!Array.isArray(parsed))return [];
		return parsed.filter((entry):entry is CacheEntry=>{
			if(!entry||typeof entry!=='object')return false;
			const value=entry as Partial<CacheEntry>;
			return typeof value.key==='string'&&typeof value.savedAt==='number'
				&&Number.isFinite(value.savedAt)&&isMarketHistoryResponse(value.data);
		});
	}catch{return []}
}

export function readMarketHistoryCache(
	storage:StorageLike,key:string,now=Date.now(),
):MarketHistoryResponse|undefined{
	const entry=readEntries(storage).find(item=>item.key===key);
	if(!entry||now-entry.savedAt>maximumAgeMs||entry.savedAt>now)return undefined;
	return {...entry.data,isCached:true,cachedAt:new Date(entry.savedAt).toISOString()};
}

export function writeMarketHistoryCache(
	storage:StorageLike,key:string,data:MarketHistoryResponse,now=Date.now(),
){
	if(!isMarketHistoryResponse(data))return;
	const entries=readEntries(storage).filter(entry=>entry.key!==key&&now-entry.savedAt<=maximumAgeMs);
	entries.push({key,savedAt:now,data});
	try{storage.setItem(storageKey,JSON.stringify(entries.slice(-maximumEntries)))}catch{}
}
