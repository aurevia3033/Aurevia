import type {LiveMarketAsset,MarketCandle,MarketQuote} from '@/lib/live-market';
import {MarketProviderHttpError,candlesFromRows,finiteNumber,normalizedTimestamp,requestMarketProviderJson} from './market-data-http';

type ProviderOptions={apiKey:string;fetcher?:typeof fetch};
type QuoteFields={
	price:unknown;
	change?:unknown;
	changePercent?:unknown;
	previousClose?:unknown;
	open?:unknown;
	high?:unknown;
	low?:unknown;
	volume?:unknown;
	timestamp:unknown;
};

const fmpIndexSymbols:Record<string,string>={
	DJI:'^DJI',SPX:'^GSPC',NASDAQ:'^IXIC',SP100:'^OEX',NDX:'^NDX',
	DAX:'^GDAXI',IBEX:'^IBEX',NIKKEI:'^N225',MERV:'^MERV',
};

function quoteFromFields(asset:LiveMarketAsset,source:string,fields:QuoteFields):MarketQuote{
	const price=finiteNumber(fields.price);
	const previousClose=finiteNumber(fields.previousClose);
	const change=finiteNumber(fields.change)??(price!==null&&previousClose!==null?price-previousClose:null);
	const changePercent=finiteNumber(fields.changePercent)??(change!==null&&previousClose?change/previousClose*100:null);
	if(price===null||price<=0||change===null||changePercent===null){
		throw new Error(`${source} quote has incomplete price data.`);
	}
	return {
		asset,price,change,changePercent,previousClose,open:finiteNumber(fields.open),volume:finiteNumber(fields.volume),
		dayLow:finiteNumber(fields.low),dayHigh:finiteNumber(fields.high),fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,
		marketStatus:'UNKNOWN',updatedAt:normalizedTimestamp(fields.timestamp),isStale:false,sparkline:[],source,
	};
}

function dateOnly(value:string){return new Date(value).toISOString().slice(0,10)}

function alphaApiError(data:Record<string,unknown>){
	const message=typeof data.Note==='string'?data.Note:typeof data.Information==='string'?data.Information:typeof data['Error Message']==='string'?data['Error Message']:'';
	if(!message)return;
	const limited=/rate limit|call frequency|requests per minute|daily limit/i.test(message);
	throw new MarketProviderHttpError('Alpha Vantage',undefined,limited?'RATE_LIMITED':/premium|entitlement|subscription/i.test(message)?'SUBSCRIPTION_RESTRICTED':'PROVIDER_REJECTED');
}

function alphaSeries(data:Record<string,unknown>,asset:LiveMarketAsset):MarketCandle[]{
	const series=Object.entries(data).find(([key,value])=>/time series/i.test(key)&&!!value&&typeof value==='object')?.[1];
	if(!series||typeof series!=='object'||Array.isArray(series))return [];
	return Object.entries(series as Record<string,unknown>).flatMap(([date,row])=>{
		if(!row||typeof row!=='object'||Array.isArray(row))return [];
		const values=row as Record<string,unknown>;
		const byPrefix=(prefix:string)=>{
			const match=Object.entries(values).find(([key])=>key.startsWith(prefix)&&(!key.includes('(')||key.includes(`(${asset.currency})`)));
			return match?.[1];
		};
		const parsed=candlesFromRows([{
			datetime:date,
			open:byPrefix('1a.')??byPrefix('1.'),
			high:byPrefix('2a.')??byPrefix('2.'),
			low:byPrefix('3a.')??byPrefix('3.'),
			close:byPrefix('4a.')??byPrefix('4.'),
			volume:byPrefix('5.'),
		}],{time:'datetime',open:'open',high:'high',low:'low',close:'close',volume:'volume'});
		return parsed;
	});
}

function alphaHistoryRequest(asset:LiveMarketAsset,interval:string,apiKey:string){
	const parameters:Record<string,string>={apikey:apiKey,datatype:'json'};
	let functionName:string;
	let responsePrefix:string|undefined;
	const intradayIntervals:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'60min'};
	if(asset.type==='STOCK'){
		parameters.symbol=asset.ticker;
		if(intradayIntervals[interval]){
			functionName='TIME_SERIES_INTRADAY';
			parameters.interval=intradayIntervals[interval];
			parameters.outputsize='full';
			responsePrefix=`Time Series (${parameters.interval})`;
		}else if(interval==='1d'){functionName='TIME_SERIES_DAILY';parameters.outputsize='full';responsePrefix='Time Series (Daily)'}
		else if(interval==='1wk'){functionName='TIME_SERIES_WEEKLY';responsePrefix='Weekly Time Series'}
		else if(interval==='1mo'){functionName='TIME_SERIES_MONTHLY';responsePrefix='Monthly Time Series'}
		else throw new Error('Alpha Vantage does not support this stock interval.');
	}else if(asset.type==='FOREX'){
		const pair=asset.ticker.replace(/=X$/,'').replace(/^(.{3})(.{3})$/,'$1/$2').split('/');
		if(pair.length!==2)throw new Error('Alpha Vantage does not support this forex symbol.');
		parameters.from_symbol=pair[0];parameters.to_symbol=pair[1];
		if(intradayIntervals[interval]){
			functionName='FX_INTRADAY';parameters.interval=intradayIntervals[interval];parameters.outputsize='full';
			responsePrefix=`Time Series FX (${parameters.interval})`;
		}else if(interval==='1d'){functionName='FX_DAILY';responsePrefix='Time Series FX (Daily)'}
		else if(interval==='1wk'){functionName='FX_WEEKLY';responsePrefix='Time Series FX (Weekly)'}
		else if(interval==='1mo'){functionName='FX_MONTHLY';responsePrefix='Time Series FX (Monthly)'}
		else throw new Error('Alpha Vantage does not support this forex interval.');
	}else if(asset.type==='CRYPTO'){
		parameters.symbol=asset.ticker.split(/[-/]/)[0];parameters.market=asset.currency;
		if(interval==='1d'){functionName='DIGITAL_CURRENCY_DAILY';responsePrefix='Time Series (Digital Currency Daily)'}
		else if(interval==='1wk'){functionName='DIGITAL_CURRENCY_WEEKLY';responsePrefix='Time Series (Digital Currency Weekly)'}
		else if(interval==='1mo'){functionName='DIGITAL_CURRENCY_MONTHLY';responsePrefix='Time Series (Digital Currency Monthly)'}
		else throw new Error('Alpha Vantage does not support this cryptocurrency interval.');
	}else{
		throw new Error('Alpha Vantage does not support index history.');
	}
	parameters.function=functionName;
	return {parameters,responsePrefix};
}

export class FinnhubMarketProvider{
	readonly name='Finnhub';
	constructor(private readonly options:ProviderOptions){}
	private async request(path:string,parameters:Record<string,string>){
		const url=new URL(path,'https://finnhub.io/api/v1/');
		url.search=new URLSearchParams(parameters).toString();
		return requestMarketProviderJson(this.name,url.toString(),this.options.fetcher,{'X-Finnhub-Token':this.options.apiKey});
	}
	async getQuote(asset:LiveMarketAsset){
		const data=await this.request('quote',{symbol:asset.ticker});
		return quoteFromFields(asset,this.name,{
			price:data.c,change:data.d,changePercent:data.dp,previousClose:data.pc,
			open:data.o,high:data.h,low:data.l,timestamp:data.t,
		});
	}
	async getHistory(asset:LiveMarketAsset,from:string,to:string,interval:string):Promise<MarketCandle[]>{
		const resolution:Record<string,string>={'1m':'1','5m':'5','15m':'15','30m':'30','1h':'60','1d':'D','1wk':'W','1mo':'M'};
		const value=resolution[interval];
		if(!value)throw new Error('Finnhub does not support this stock interval.');
		const data=await this.request('stock/candle',{
			symbol:asset.ticker,resolution:value,from:String(Math.floor(Date.parse(from)/1000)),to:String(Math.floor(Date.parse(to)/1000)),
		});
		if(data.s==='no_data')return [];
		if(data.s!=='ok')throw new MarketProviderHttpError(this.name,undefined,'PROVIDER_REJECTED');
		const times=data.t,opens=data.o,highs=data.h,lows=data.l,closes=data.c,volumes=data.v;
		if(!Array.isArray(times)||!Array.isArray(opens)||!Array.isArray(highs)||!Array.isArray(lows)||!Array.isArray(closes)||!Array.isArray(volumes)){
			throw new MarketProviderHttpError(this.name,undefined,'INVALID_RESPONSE');
		}
		const rows=times.flatMap((time,index)=>{
			const timestamp=finiteNumber(time);
			if(timestamp===null||Math.abs(timestamp)>8_640_000_000)return [];
			return [{
				time:new Date(timestamp*1000).toISOString(),
				open:opens[index],high:highs[index],low:lows[index],close:closes[index],volume:volumes[index],
			}];
		});
		return candlesFromRows(rows,{time:'time',open:'open',high:'high',low:'low',close:'close',volume:'volume'});
	}
}

export class AlphaVantageMarketProvider{
	readonly name='Alpha Vantage';
	constructor(private readonly options:ProviderOptions){}
	private async request(parameters:Record<string,string>){
		const url=new URL('query','https://www.alphavantage.co/');
		url.search=new URLSearchParams({...parameters,apikey:this.options.apiKey}).toString();
		const data=await requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
		alphaApiError(data);
		return data;
	}
	async getQuote(asset:LiveMarketAsset){
		if(asset.type!=='STOCK')throw new Error('Alpha Vantage quote snapshots are available only for stocks.');
		const data=await this.request({function:'GLOBAL_QUOTE',symbol:asset.ticker});
		const quote=data['Global Quote'];
		if(!quote||typeof quote!=='object')throw new Error('Alpha Vantage returned no stock quote.');
		const values=quote as Record<string,unknown>;
		return quoteFromFields(asset,this.name,{
			price:values['05. price'],change:values['09. change'],changePercent:values['10. change percent'],
			previousClose:values['08. previous close'],open:values['02. open'],high:values['03. high'],
			low:values['04. low'],volume:values['06. volume'],timestamp:values['07. latest trading day'],
		});
	}
	async getHistory(asset:LiveMarketAsset,_from:string,_to:string,interval:string):Promise<MarketCandle[]>{
		const {parameters}=alphaHistoryRequest(asset,interval,this.options.apiKey);
		const data=await this.request(parameters);
		return alphaSeries(data,asset);
	}
}

export class FinancialModelingPrepMarketProvider{
	readonly name='Financial Modeling Prep';
	constructor(private readonly options:ProviderOptions){}
	private async request(path:string,parameters:Record<string,string>){
		const url=new URL(path,'https://financialmodelingprep.com/stable/');
		url.search=new URLSearchParams({...parameters,apikey:this.options.apiKey}).toString();
		return requestMarketProviderJson(this.name,url.toString(),this.options.fetcher);
	}
	private symbol(asset:LiveMarketAsset){return asset.type==='INDEX'?fmpIndexSymbols[asset.id]||asset.ticker:asset.ticker}
	async getQuote(asset:LiveMarketAsset){
		const path='quote';
		const data=await this.request(path,{symbol:this.symbol(asset)});
		const row=Array.isArray(data)?data[0]:data;
		if(!row||typeof row!=='object')throw new Error('Financial Modeling Prep returned no quote.');
		const values=row as Record<string,unknown>;
		return quoteFromFields(asset,this.name,{
			price:values.price,change:values.change,changePercent:values.changePercentage??values.changesPercentage,
			previousClose:values.previousClose,open:values.open,high:values.dayHigh,low:values.dayLow,
			volume:values.volume,timestamp:values.timestamp??values.date,
		});
	}
	async getHistory(asset:LiveMarketAsset,from:string,to:string,interval:string):Promise<MarketCandle[]>{
		const intervalPath:Record<string,string>={'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1hour','1d':'1day'};
		const path=interval==='1d'?'historical-price-eod/full':`historical-chart/${intervalPath[interval]||''}`;
		if(path.endsWith('/'))throw new Error('Financial Modeling Prep does not support this interval.');
		const data=await this.request(path,{
			symbol:this.symbol(asset),from:dateOnly(from),to:dateOnly(to),
		});
		if(!Array.isArray(data))return [];
		return candlesFromRows(data,{time:'date',open:'open',high:'high',low:'low',close:'close',volume:'volume'});
	}
}
