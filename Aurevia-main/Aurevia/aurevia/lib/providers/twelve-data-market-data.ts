import type {LiveMarketAsset,MarketCandle,MarketQuote} from '@/lib/live-market';
import {candlesFromRows,finiteNumber,requestMarketProviderJson} from './market-data-http';

export type TwelveDataIndicator='rsi'|'ema'|'macd';
export type TwelveDataOptions={apiKey:string;baseUrl?:string;fetcher?:typeof fetch};

const defaultBaseUrl='https://api.twelvedata.com';
const intervalMap:Record<string,string>={
	'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h',
	'1d':'1day','1wk':'1week','1mo':'1month',
};

function symbolFor(asset:LiveMarketAsset){
	if(asset.type==='FOREX')return asset.ticker.replace(/=X$/,'').replace(/^(.{3})(.{3})$/,'$1/$2');
	if(asset.type==='CRYPTO')return asset.ticker.replace('-','/');
	return asset.ticker;
}

function timestampFromQuote(data:Record<string,unknown>){
	const seconds=finiteNumber(data.timestamp);
	if(seconds!==null&&seconds>0){
		const timestamp=seconds>10_000_000_000?seconds:seconds*1000;
		if(timestamp>Date.now()+5_000)throw new Error('Twelve Data quote has a future provider timestamp.');
		return new Date(timestamp).toISOString();
	}
	const datetime=typeof data.datetime==='string'?data.datetime:'';
	if(!/[zZ]|[+-]\d\d:\d\d$/.test(datetime))throw new Error('Twelve Data quote has no valid provider timestamp.');
	const parsed=Date.parse(datetime);
	if(!Number.isFinite(parsed)||parsed>Date.now()+5_000)throw new Error('Twelve Data quote has no valid provider timestamp.');
	return new Date(parsed).toISOString();
}

export class TwelveDataMarketProvider{
	readonly name='Twelve Data';
	private readonly baseUrl:string;
	constructor(private readonly options:TwelveDataOptions){
		this.baseUrl=(options.baseUrl||defaultBaseUrl).replace(/\/+$/,'');
		const parsed=new URL(this.baseUrl);
		if(parsed.protocol!=='https:'||parsed.hostname!=='api.twelvedata.com'||parsed.username||parsed.password||parsed.port||parsed.search||parsed.hash){
			throw new Error('Twelve Data base URL must be https://api.twelvedata.com.');
		}
		if(!options.apiKey.trim())throw new Error('Twelve Data API key is not configured.');
	}

	private async request(path:string,parameters:Record<string,string>){
		const url=new URL(path,this.baseUrl+'/');
		url.search=new URLSearchParams(parameters).toString();
		return requestMarketProviderJson(this.name,url.toString(),this.options.fetcher, {
			Authorization:`apikey ${this.options.apiKey}`,
		});
	}

	async getQuote(asset:LiveMarketAsset):Promise<MarketQuote>{
		const data=await this.request('quote',{symbol:symbolFor(asset)});
		const price=finiteNumber(data.close);
		const previousClose=finiteNumber(data.previous_close);
		if(price===null||price<=0)throw new Error('Twelve Data quote has no valid price.');
		const change=finiteNumber(data.change)??(previousClose===null?null:price-previousClose);
		const changePercent=finiteNumber(data.percent_change)??(previousClose&&change!==null?change/previousClose*100:null);
		if(change===null||changePercent===null)throw new Error('Twelve Data quote is missing change data.');
		const isMarketOpen=data.is_market_open;
		return {
			asset,price,change,changePercent,previousClose,open:finiteNumber(data.open),volume:finiteNumber(data.volume),
			dayLow:finiteNumber(data.low),dayHigh:finiteNumber(data.high),fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,
			marketStatus:isMarketOpen===true?'OPEN':isMarketOpen===false?'CLOSED':'UNKNOWN',
			updatedAt:timestampFromQuote(data),isStale:false,sparkline:[],source:this.name,
		};
	}

	async getHistory(asset:LiveMarketAsset,from:string,to:string,interval:string):Promise<MarketCandle[]>{
		const urlInterval=intervalMap[interval];
		if(!urlInterval)throw new Error('Twelve Data does not support the requested candle interval.');
		const data=await this.request('time_series',{
			symbol:symbolFor(asset),interval:urlInterval,start_date:from,end_date:to,
			outputsize:'5000',order:'asc',timezone:'UTC',
		});
		const candles=candlesFromRows(data.values,{time:'datetime',open:'open',high:'high',low:'low',close:'close',volume:'volume'});
		if(candles.some(candle=>candle.time*1000>Date.now()+5_000))throw new Error('Twelve Data history contains future provider timestamps.');
		return candles;
	}

	async search(query:string,limit=20){
		const data=await this.request('symbol_search',{symbol:query,outputsize:String(limit)});
		if(!Array.isArray(data.data))throw new Error('Twelve Data symbol search returned an invalid response.');
		return data.data.flatMap(item=>{
			if(!item||typeof item!=='object')return [];
			const row=item as Record<string,unknown>;
			if(typeof row.symbol!=='string'||typeof row.instrument_name!=='string')return [];
			return [{
				symbol:row.symbol,name:row.instrument_name,
				exchange:typeof row.exchange==='string'?row.exchange:null,
				type:typeof row.instrument_type==='string'?row.instrument_type:null,
				country:typeof row.country==='string'?row.country:null,
				currency:typeof row.currency==='string'?row.currency:null,
			}];
		});
	}

	async getIndicator(symbol:string,indicator:TwelveDataIndicator,interval:string,outputsize:number){
		const urlInterval=intervalMap[interval];
		if(!urlInterval)throw new Error('Twelve Data does not support the requested indicator interval.');
		const data=await this.request(indicator,{
			symbol,interval:urlInterval,outputsize:String(outputsize),timezone:'UTC',
		});
		if(!Array.isArray(data.values))throw new Error('Twelve Data indicator returned an invalid response.');
		return data;
	}

	async getMarketState(){
		const data=await this.request('market_state',{});
		if(Array.isArray(data))return data;
		if(Array.isArray(data.data))return data.data;
		throw new Error('Twelve Data market-state response is invalid.');
	}
}
