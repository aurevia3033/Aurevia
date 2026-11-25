import {beforeEach,describe,expect,it,vi} from 'vitest';
import {getMarketAsset} from '@/lib/live-market';

const scheduler=vi.hoisted(()=>({priorities:[] as number[]}));

vi.mock('bottleneck',()=>({
	default:class{
		static strategy={OVERFLOW:1};
		constructor(){}
		schedule<T>(optionsOrOperation:{priority:number}|(()=>Promise<T>),operation?:()=>Promise<T>){
			if(typeof optionsOrOperation==='function')return optionsOrOperation();
			scheduler.priorities.push(optionsOrOperation.priority);
			return operation!();
		}
	},
}));

import {getConfiguredMarketHistory,getConfiguredMarketQuote,getMarketProviderReadiness} from '@/lib/market-data/provider-manager';

beforeEach(()=>{
	vi.unstubAllEnvs();
	scheduler.priorities.length=0;
});

describe('market-data provider selection and readiness',()=>{
	it('uses Twelve Data first and returns its normalized stock quote',async()=>{
		const fetcher=vi.fn(async(_input:RequestInfo|URL)=>{
			return new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:1793893800,
			}),{status:200});
		});
		vi.stubGlobal('fetch',fetcher);
		const quote=await getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			twelveDataApiKey:'twelve-working-key',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false,
		});

		expect(quote).toMatchObject({price:192.5,source:'Twelve Data'});
		expect(fetcher).toHaveBeenCalledOnce();
		expect(String(fetcher.mock.calls[0][0])).toContain('api.twelvedata.com/quote?symbol=AAPL');
		expect(JSON.stringify(quote)).not.toContain('twelve-working-key');
	});

	it('keeps in-flight quote deduplication after the result-cache TTL elapses',async()=>{
		const key='twelve-inflight-quote-cache-key';
		let resolveFetch!:(response:Response)=>void;
		const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{resolveFetch=resolve}));
		vi.stubGlobal('fetch',fetcher);
		const providers={twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false};
		const asset=getMarketAsset('AAPL')!;

		try{
			vi.useFakeTimers();
			const first=getConfiguredMarketQuote(asset,providers);
			expect(fetcher).toHaveBeenCalledOnce();
			vi.setSystemTime(Date.now()+16_000);
			const second=getConfiguredMarketQuote(asset,providers);
			expect(fetcher).toHaveBeenCalledOnce();
			resolveFetch(new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:Math.floor(Date.now()/1000),
			}),{status:200}));

			const quotes=await Promise.all([first,second]);
			expect(quotes[0]).toEqual(quotes[1]);
			expect(quotes[0]).toMatchObject({price:192.5,source:'Twelve Data'});
		}finally{
			vi.useRealTimers();
		}
	});

	it('reuses chart history across normal chart refreshes to avoid redundant provider calls',async()=>{
		const key='history-cache-secret-unique';
		const pastDate=new Date(Date.now()-60_000).toISOString().replace('T',' ').slice(0,19);
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({values:[
			{datetime:pastDate,open:'190',high:'192',low:'189',close:'191',volume:'100'},
		]}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const asset=getMarketAsset('AAPL')!;
		const providers={twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:true};
		try{
			vi.useFakeTimers();
			const first=await getConfiguredMarketHistory(asset,'1m',providers);
			vi.advanceTimersByTime(90_000);
			const refreshed=await getConfiguredMarketHistory(asset,'1m',providers);
			expect(first?.candles).toHaveLength(1);
			expect(refreshed?.candles).toEqual(first?.candles);
			expect(fetcher).toHaveBeenCalledOnce();
		}finally{
			vi.useRealTimers();
		}
	});

	it('prioritizes chart history ahead of market quote requests',async()=>{
		const key='priority-test-key';
		const pastDate=new Date(Date.now()-60_000).toISOString().replace('T',' ').slice(0,19);
		vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
			const isQuote=String(input).includes('/quote?');
			return new Response(JSON.stringify(isQuote?{
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:1793893800,
			}:{values:[{datetime:pastDate,open:'190',high:'192',low:'189',close:'191',volume:'100'}]}),{status:200});
		}));
		const providers={twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:true};

		await getConfiguredMarketQuote(getMarketAsset('AAPL')!,providers);
		await getConfiguredMarketHistory(getMarketAsset('BTC')!,'1m',providers);

		expect(scheduler.priorities).toEqual([5,0]);
	});

	it('reports Twelve Data connected only after an authenticated request and redacts keys',async()=>{
		const key='twelve-readiness-secret';
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({
			close:'190',previous_close:'188',change:'2',percent_change:'1.06',timestamp:1793893800,
		}),{status:200})));
		const readiness=await getMarketProviderReadiness({
			twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false,
		});
		const twelveData=readiness.find(provider=>provider.id==='twelveData');

		expect(readiness).toHaveLength(4);
		expect(readiness.filter(provider=>provider.configured)).toHaveLength(1);
		expect(twelveData).toMatchObject({configured:true,status:'CONNECTED'});
		expect(twelveData?.responseTimeMs).toEqual(expect.any(Number));
		expect(JSON.stringify(readiness)).not.toContain(key);
	});

	it('keeps rate-limited providers in cooldown and reports measured latency',async()=>{
		const key='twelve-rate-limit-test-key';
		const fetcher=vi.fn().mockResolvedValue(new Response('rate limited',{status:429,headers:{'retry-after':'60'}}));
		vi.stubGlobal('fetch',fetcher);
		const providers={twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false};

		const first=await getMarketProviderReadiness(providers);
		const second=await getMarketProviderReadiness(providers);
		expect(first.find(provider=>provider.id==='twelveData')).toMatchObject({status:'ERROR',errorCode:'RATE_LIMITED'});
		const twelveData=second.find(provider=>provider.id==='twelveData');

		expect(twelveData).toMatchObject({configured:true,status:'ERROR',errorCode:'RATE_LIMITED'});
		expect(twelveData?.responseTimeMs).toEqual(expect.any(Number));
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('recovers after the provider circuit cooldown expires',async()=>{
		const key='twelve-recovery-test-key';
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({code:401,status:'error',message:'invalid api key'}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:Math.floor(Date.now()/1000),
			}),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const providers={twelveDataApiKey:key,twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false};

		try{
			vi.useFakeTimers();
			await expect(getConfiguredMarketQuote(getMarketAsset('AAPL')!,providers)).resolves.toBeNull();
			expect(fetcher).toHaveBeenCalledOnce();
			vi.setSystemTime(Date.now()+30_001);
			await expect(getConfiguredMarketQuote(getMarketAsset('AAPL')!,providers)).resolves.toMatchObject({
				price:192.5,source:'Twelve Data',
			});
			expect(fetcher).toHaveBeenCalledTimes(2);
		}finally{
			vi.useRealTimers();
		}
	});

	it('tries at most one fallback after consecutive provider timeouts',async()=>{
		const fetcher=vi.fn().mockRejectedValue(new DOMException('request timed out','TimeoutError'));
		vi.stubGlobal('fetch',fetcher);
		const quote=await getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			twelveDataApiKey:'twelve-timeout-key',twelveDataBaseUrl:'https://api.twelvedata.com',
			finnhubApiKey:'finnhub-timeout-key',fmpApiKey:'fmp-timeout-key',alphaVantageApiKey:'alpha-timeout-key',
			productionLicenseConfirmed:false,
		});

		expect(quote).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('requires the production license confirmation before provider requests',async()=>{
		vi.stubEnv('NODE_ENV','production');
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);

		await expect(getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			twelveDataApiKey:'',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false,
		})).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('does not fall back when no secondary provider is configured',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response('unauthorized',{status:401}));
		vi.stubGlobal('fetch',fetcher);
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
		try{
			await expect(getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
				twelveDataApiKey:'twelve-key',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false,
			})).resolves.toBeNull();
			expect(fetcher).toHaveBeenCalledOnce();
			expect(String(fetcher.mock.calls[0][0])).toContain('api.twelvedata.com/quote?symbol=AAPL');
			expect(warning).toHaveBeenCalledWith('[market-data] Provider request failed.',{
				provider:'Twelve Data',symbol:'AAPL',errorCode:'AUTHENTICATION_FAILED',httpStatus:401,
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain('twelve-key');
		}finally{
			warning.mockRestore();
		}
	});

	it('uses a configured Finnhub quote after Twelve Data fails',async()=>{
		const key='finnhub-fallback-secret';
		const fetcher=vi.fn(async(input:RequestInfo|URL,_init?:RequestInit)=>{
			if(String(input).includes('api.twelvedata.com')){
				return new Response('unauthorized',{status:401});
			}
			return new Response(JSON.stringify({
				c:192.5,d:2.5,dp:1.3158,pc:190,o:191,h:193,l:190,t:Math.floor(Date.now()/1000),
			}),{status:200});
		});
		vi.stubGlobal('fetch',fetcher);

		const quote=await getConfiguredMarketQuote(getMarketAsset('AAPL')!,{
			twelveDataApiKey:'twelve-fallback-test-key',twelveDataBaseUrl:'https://api.twelvedata.com',
			finnhubApiKey:key,productionLicenseConfirmed:false,
		});

		expect(quote).toMatchObject({price:192.5,source:'Finnhub'});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(String(fetcher.mock.calls[1][0])).not.toContain(key);
		expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({'X-Finnhub-Token':key});
		expect(JSON.stringify(quote)).not.toContain(key);
	});

	it('uses FMP for index quotes and history that Twelve Data does not support',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				symbol:'^GSPC',price:6000,change:10,changePercentage:0.17,previousClose:5990,
				open:5992,dayHigh:6001,dayLow:5990,volume:1000,timestamp:Math.floor(Date.now()/1000),
			}]),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				date:new Date(Date.now()-60_000).toISOString(),open:5990,high:6001,low:5989,close:6000,volume:1000,
			}]),{status:200}));
		vi.stubGlobal('fetch',fetcher);
		const providers={
			twelveDataApiKey:'',twelveDataBaseUrl:'https://api.twelvedata.com',
			fmpApiKey:'fmp-index-test-key',productionLicenseConfirmed:false,
		};

		await expect(getConfiguredMarketQuote(getMarketAsset('SPX')!,providers)).resolves.toMatchObject({
			price:6000,source:'Financial Modeling Prep',
		});
		await expect(getConfiguredMarketHistory(getMarketAsset('SPX')!,'1d',providers)).resolves.toMatchObject({
			source:'Financial Modeling Prep',candles:[expect.objectContaining({close:6000})],
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('does not make provider requests when Twelve Data is not configured',async()=>{
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);
		await expect(getConfiguredMarketQuote(getMarketAsset('SPX')!,{
			twelveDataApiKey:'',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:false,
		})).resolves.toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
