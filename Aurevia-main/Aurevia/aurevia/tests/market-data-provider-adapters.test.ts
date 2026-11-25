import {describe,expect,it,vi} from 'vitest';
import {AlphaVantageMarketProvider,FinancialModelingPrepMarketProvider,FinnhubMarketProvider} from '@/lib/providers/fallback-market-data';
import {TwelveDataMarketProvider} from '@/lib/providers/twelve-data-market-data';

const asset={id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK' as const,currency:'USD'};

describe('market-data provider adapters',()=>{
	it('normalizes Twelve Data quote and history responses without returning credentials',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:1793893800,datetime:'2026-11-05 10:30:00',
				open:'191',high:'193',low:'190',volume:'1000',
			}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({values:[{
				datetime:'2026-11-04',open:'190',high:'193',low:'189',close:'192.5',volume:'1000',
			}]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({values:[{
				datetime:'2026-11-04',open:'190',high:'193',low:'189',close:'192.5',volume:'1000',
			}]}),{status:200}));
		const provider=new TwelveDataMarketProvider({apiKey:'twelve-test-secret',fetcher});

		await expect(provider.getQuote(asset)).resolves.toMatchObject({price:192.5,changePercent:1.3158,source:'Twelve Data'});
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05','1d')).resolves.toEqual([
			{time:expect.any(Number),open:190,high:193,low:189,close:192.5,volume:1000},
		]);
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05','4h')).resolves.toEqual([
			{time:expect.any(Number),open:190,high:193,low:189,close:192.5,volume:1000},
		]);
		expect(String(fetcher.mock.calls[0][0])).toContain('/quote?symbol=AAPL');
		expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('apikey twelve-test-secret');
		expect(String(fetcher.mock.calls[0][0])).not.toContain('twelve-test-secret');
	});

	it('supports Twelve Data crypto quotes, symbol search, technical indicators, and market state',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				close:'67000',previous_close:'66000',change:'1000',percent_change:'1.51',timestamp:1793893800,
			}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({data:[{
				symbol:'AAPL',instrument_name:'Apple Inc.',exchange:'NASDAQ',instrument_type:'Common Stock',country:'United States',currency:'USD',
			}]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({values:[{datetime:'2026-11-05',rsi:'55.3'}]}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({data:[{exchange:'NASDAQ',is_market_open:true}]}),{status:200}));
		const provider=new TwelveDataMarketProvider({apiKey:'twelve-test-secret',fetcher});
		const crypto={id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO' as const,currency:'USD'};

		await expect(provider.getQuote(crypto)).resolves.toMatchObject({price:67000,source:'Twelve Data'});
		await expect(provider.search('Apple',10)).resolves.toEqual([expect.objectContaining({symbol:'AAPL',name:'Apple Inc.',exchange:'NASDAQ'})]);
		await expect(provider.getIndicator('AAPL','rsi','1d',50)).resolves.toMatchObject({values:[expect.objectContaining({rsi:'55.3'})]});
		await expect(provider.getMarketState()).resolves.toEqual([{exchange:'NASDAQ',is_market_open:true}]);
		expect(String(fetcher.mock.calls[0][0])).toContain('symbol=BTC%2FUSD');
		expect(String(fetcher.mock.calls[1][0])).toContain('/symbol_search?');
		expect(String(fetcher.mock.calls[2][0])).toContain('/rsi?');
		expect(String(fetcher.mock.calls[3][0])).toContain('/market_state');
	});

	it('maps invalid credentials and rate limits to sanitized provider errors without retrying rate limits',async()=>{
		const unauthorized=new TwelveDataMarketProvider({
			apiKey:'never-log-this-key',
			fetcher:vi.fn().mockResolvedValue(new Response(JSON.stringify({code:401,status:'error',message:'invalid api key'}),{status:200})),
		});
		await expect(unauthorized.getQuote(asset)).rejects.toMatchObject({code:'AUTHENTICATION_FAILED',status:401});
		await expect(unauthorized.getQuote(asset)).rejects.toThrow('Twelve Data market-data request failed.');

		const rateLimitedFetcher=vi.fn(async()=>new Response(JSON.stringify({
			code:429,status:'error',message:'Rate limit exceeded',
		}),{status:200}));
		const rateLimited=new TwelveDataMarketProvider({apiKey:'rate-limit-test-key',fetcher:rateLimitedFetcher});
		await expect(rateLimited.getQuote(asset)).rejects.toMatchObject({code:'RATE_LIMITED',status:429});
		expect(rateLimitedFetcher).toHaveBeenCalledOnce();
	});

	it('rejects unavailable symbols without fabricating a quote',async()=>{
		const provider=new TwelveDataMarketProvider({
			apiKey:'unavailable-symbol-test-key',
			fetcher:vi.fn().mockResolvedValue(new Response(JSON.stringify({
				code:404,status:'error',message:'No data found for the symbol',
			}),{status:200})),
		});

		await expect(provider.getQuote(asset)).rejects.toMatchObject({code:'PROVIDER_REJECTED',status:404});
	});

	it('rejects non-positive Twelve Data quote prices',async()=>{
		const provider=new TwelveDataMarketProvider({
			apiKey:'invalid-price-test-key',
			fetcher:vi.fn().mockResolvedValue(new Response(JSON.stringify({
				close:'0',previous_close:'190',change:'-190',percent_change:'-100',timestamp:Math.floor(Date.now()/1000),
			}),{status:200})),
		});

		await expect(provider.getQuote(asset)).rejects.toThrow('Twelve Data quote has no valid price.');
	});

	it('rejects future-dated quotes and candles',async()=>{
		const futureQuote=new TwelveDataMarketProvider({
			apiKey:'twelve-test-secret',
			fetcher:vi.fn().mockResolvedValue(new Response(JSON.stringify({
				close:'192.5',previous_close:'190',change:'2.5',percent_change:'1.3158',timestamp:Math.floor(Date.now()/1000)+60,
			}),{status:200})),
		});
		await expect(futureQuote.getQuote(asset)).rejects.toThrow('future provider timestamp');

		const futureDate=new Date(Date.now()+60_000).toISOString();
		const futureHistory=new TwelveDataMarketProvider({
			apiKey:'twelve-test-secret',
			fetcher:vi.fn().mockResolvedValue(new Response(JSON.stringify({values:[{
				datetime:futureDate,open:'190',high:'193',low:'189',close:'192.5',volume:'1000',
			}]}),{status:200})),
		});
		await expect(futureHistory.getHistory(asset,'2026-11-01','2026-11-05','1d')).rejects.toThrow('future provider timestamps');
	});

	it('normalizes Finnhub quotes and candles while keeping its key out of the URL',async()=>{
		const key='finnhub-test-secret';
		const timestamp=Math.floor((Date.now()-60_000)/1000);
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				c:192.5,d:2.5,dp:1.3158,pc:190,o:191,h:193,l:190,t:1793893800,
			}),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				s:'ok',t:[timestamp],o:[190],h:[193],l:[189],c:[192.5],v:[1000],
			}),{status:200}));
		const provider=new FinnhubMarketProvider({apiKey:key,fetcher});

		await expect(provider.getQuote(asset)).resolves.toMatchObject({price:192.5,source:'Finnhub'});
		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05','1d')).resolves.toEqual([
			{time:timestamp,open:190,high:193,low:189,close:192.5,volume:1000},
		]);
		expect(String(fetcher.mock.calls[0][0])).not.toContain(key);
		expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({'X-Finnhub-Token':key});
	});

	it('normalizes Financial Modeling Prep index quotes and historical candles',async()=>{
		const fetcher=vi.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				symbol:'^GSPC',price:6000,change:10,changePercentage:0.17,previousClose:5990,
				open:5992,dayHigh:6001,dayLow:5990,volume:1000,timestamp:1793893800,
			}]),{status:200}))
			.mockResolvedValueOnce(new Response(JSON.stringify([{
				date:new Date(Date.now()-60_000).toISOString(),open:5990,high:6001,low:5989,close:6000,volume:1000,
			}]),{status:200}));
		const provider=new FinancialModelingPrepMarketProvider({apiKey:'fmp-test-secret',fetcher});
		const index={id:'SPX',ticker:'^GSPC',name:'S&P 500',type:'INDEX' as const,currency:'USD'};

		await expect(provider.getQuote(index)).resolves.toMatchObject({price:6000,changePercent:0.17,source:'Financial Modeling Prep'});
		await expect(provider.getHistory(index,'2026-11-01','2026-11-05','1d')).resolves.toMatchObject([
			{open:5990,high:6001,low:5989,close:6000},
		]);
		expect(String(fetcher.mock.calls[0][0])).toContain('/stable/quote?symbol=%5EGSPC');
		expect(String(fetcher.mock.calls[1][0])).toContain('/stable/historical-price-eod/full?symbol=%5EGSPC');
		expect(String(fetcher.mock.calls[0][0])).toContain('apikey=fmp-test-secret');
	});

	it('parses Alpha Vantage daily stock history',async()=>{
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({
			'Meta Data':{'2. Symbol':'AAPL'},
			'Time Series (Daily)':{
				'2026-11-04':{'1. open':'190','2. high':'193','3. low':'189','4. close':'192.5','5. volume':'1000'},
			},
		}),{status:200}));
		const provider=new AlphaVantageMarketProvider({apiKey:'alpha-test-secret',fetcher});

		await expect(provider.getHistory(asset,'2026-11-01','2026-11-05','1d')).resolves.toMatchObject([
			{open:190,high:193,low:189,close:192.5,volume:1000},
		]);
		expect(String(fetcher.mock.calls[0][0])).toContain('function=TIME_SERIES_DAILY');
		expect(String(fetcher.mock.calls[0][0])).toContain('apikey=alpha-test-secret');
	});

});
