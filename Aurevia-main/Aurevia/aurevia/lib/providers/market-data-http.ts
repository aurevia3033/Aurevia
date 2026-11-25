import pRetry from 'p-retry';

const requestTimeoutMs=5_000;

export class MarketProviderHttpError extends Error{
	constructor(readonly provider:string,readonly status:number|undefined,readonly code:string,readonly retryAfterMs?:number){
		super(`${provider} market-data request failed.`);
		this.name='MarketProviderHttpError';
	}
}

function retryAfterMs(response:Response){
	const value=response.headers.get('retry-after')?.trim();
	if(!value)return undefined;
	const seconds=Number(value);
	const delay=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-Date.now();
	return Number.isFinite(delay)&&delay>=0?Math.min(delay,5*60_000):undefined;
}

export async function requestMarketProviderJson(
	provider:string,
	url:string,
	fetcher:typeof fetch=fetch,
	headers:Record<string,string>={},
){
	return pRetry(async()=>{
		let response:Response;
		try{
			response=await fetcher(url,{headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(requestTimeoutMs)});
		}catch{
			throw new MarketProviderHttpError(provider,undefined,'NETWORK_OR_TIMEOUT');
		}
		if(!response.ok){
			const code=response.status===429?'RATE_LIMITED':response.status===401?'AUTHENTICATION_FAILED':
				response.status===403?'SUBSCRIPTION_RESTRICTED':response.status>=500?'PROVIDER_SERVER_ERROR':'HTTP_ERROR';
			throw new MarketProviderHttpError(provider,response.status,code,retryAfterMs(response));
		}
		let payload:unknown;
		try{payload=await response.json()}catch{throw new MarketProviderHttpError(provider,response.status,'INVALID_JSON')}
		if(!payload||typeof payload!=='object')throw new MarketProviderHttpError(provider,response.status,'INVALID_RESPONSE');
		if(provider==='Twelve Data'&&!Array.isArray(payload)){
			const body=payload as Record<string,unknown>;
			const providerCode=Number(body.code);
			if(body.status==='error'||Number.isFinite(providerCode)&&providerCode>=400){
				const status=Number.isFinite(providerCode)&&providerCode>=400?providerCode:response.status;
				const code=status===429?'RATE_LIMITED':status===401?'AUTHENTICATION_FAILED':
					status===403?'SUBSCRIPTION_RESTRICTED':status>=500?'PROVIDER_SERVER_ERROR':'PROVIDER_REJECTED';
				throw new MarketProviderHttpError(provider,status,code,retryAfterMs(response));
			}
		}
		return payload as Record<string,unknown>;
	},{
		retries:1,
		minTimeout:250,
		maxTimeout:1_000,
		shouldRetry:({error})=>error instanceof MarketProviderHttpError&&error.status!==undefined&&error.status>=500,
	});
}

export function finiteNumber(value:unknown){
	if(typeof value==='number'&&Number.isFinite(value))return value;
	if(typeof value==='string'&&value.trim()!==''){
		const parsed=Number(value.replace(/%$/,''));
		if(Number.isFinite(parsed))return parsed;
	}
	return null;
}

export function normalizedTimestamp(value:unknown){
	if(typeof value==='number'&&Number.isFinite(value))return new Date(value>10_000_000_000?value:value*1000).toISOString();
	if(typeof value==='string'){
		const timestamp=Date.parse(value);
		if(Number.isFinite(timestamp))return new Date(timestamp).toISOString();
	}
	throw new Error('Market provider returned no valid data timestamp.');
}

export function candlesFromRows(rows:unknown,keys:{time:string;open:string;high:string;low:string;close:string;volume:string}){
	if(!Array.isArray(rows))return [];
	return rows.flatMap(row=>{
		if(!row||typeof row!=='object')return [];
		const values=row as Record<string,unknown>;
		const time=Date.parse(String(values[keys.time]??''));
		const open=finiteNumber(values[keys.open]),high=finiteNumber(values[keys.high]);
		const low=finiteNumber(values[keys.low]),close=finiteNumber(values[keys.close]);
		if(!Number.isFinite(time)||open===null||high===null||low===null||close===null||open<=0||high<=0||low<=0||close<=0)return [];
		return [{time:Math.floor(time/1000),open,high,low,close,volume:finiteNumber(values[keys.volume])}];
	});
}
