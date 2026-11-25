import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getQuote:vi.fn(),
	getHistory:vi.fn(),
	getSearch:vi.fn(),
	getIndicator:vi.fn(),
}));

vi.mock('@/lib/market-data/provider-manager',()=>({
	getConfiguredMarketQuote:mocks.getQuote,
	getConfiguredMarketHistory:mocks.getHistory,
	getConfiguredMarketSearch:mocks.getSearch,
	getConfiguredMarketIndicator:mocks.getIndicator,
}));

import {getMarketHistoryWithFallback,getMarketIndicator,getMarketQuoteWithFallback,searchMarketSymbols} from '@/lib/market-data-service';

const asset={id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK' as const,currency:'USD'};
const providers={twelveDataApiKey:'test-key',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:true};

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getQuote.mockResolvedValue({
		asset,price:200,change:1,changePercent:0.5,updatedAt:new Date().toISOString(),source:'Twelve Data',
	});
	mocks.getHistory.mockResolvedValue({
		source:'Twelve Data',candles:[{time:1_800_000_000,open:199,high:201,low:198,close:200,volume:10}],
	});
	mocks.getSearch.mockResolvedValue([{symbol:'AAPL',name:'Apple Inc.'}]);
	mocks.getIndicator.mockResolvedValue({values:[{datetime:'2026-11-05',rsi:'55.3'}]});
});

describe('market-data service provider boundaries',()=>{
	it('marks an old provider quote stale and rejects invalid timestamps',async()=>{
		mocks.getQuote.mockResolvedValueOnce({
			asset,price:200,change:1,changePercent:0.5,updatedAt:new Date(Date.now()-6*60_000).toISOString(),source:'Twelve Data',
		});
		await expect(getMarketQuoteWithFallback(asset,providers)).resolves.toMatchObject({source:'Twelve Data',isStale:true});
		mocks.getQuote.mockResolvedValueOnce({asset,price:200,updatedAt:'not-a-timestamp',source:'Twelve Data'});
		await expect(getMarketQuoteWithFallback(asset,providers)).rejects.toMatchObject({status:502});
	});

	it('does not fabricate a quote when no provider returns data',async()=>{
		mocks.getQuote.mockResolvedValue(null);
		await expect(getMarketQuoteWithFallback(asset,providers)).rejects.toMatchObject({status:503});
	});

	it('returns provider history, symbol search, and indicator data without local simulation fallback',async()=>{
		await expect(getMarketHistoryWithFallback(asset,'1d',providers)).resolves.toMatchObject({source:'Twelve Data',candles:[expect.objectContaining({close:200})]});
		await expect(searchMarketSymbols('Apple',10,providers)).resolves.toEqual([{symbol:'AAPL',name:'Apple Inc.'}]);
		await expect(getMarketIndicator('AAPL','rsi','1d',50,providers)).resolves.toMatchObject({values:[expect.objectContaining({rsi:'55.3'})]});
	});

	it('rejects missing provider history rather than returning synthetic candles',async()=>{
		mocks.getHistory.mockResolvedValue(null);
		await expect(getMarketHistoryWithFallback(asset,'1d',providers)).rejects.toMatchObject({status:503});
	});
});
