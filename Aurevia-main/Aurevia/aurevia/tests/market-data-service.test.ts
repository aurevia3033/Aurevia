import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getQuote:vi.fn(),
	getHistory:vi.fn(),
	getSearch:vi.fn(),
	getIndicator:vi.fn(),
	getFreeCryptoHistory:vi.fn(),
}));

vi.mock('@/lib/market-data/provider-manager',()=>({
	getConfiguredMarketQuote:mocks.getQuote,
	getConfiguredMarketHistory:mocks.getHistory,
	getConfiguredMarketSearch:mocks.getSearch,
	getConfiguredMarketIndicator:mocks.getIndicator,
}));
vi.mock('@/lib/free-market-quotes',()=>({
	getFreeMarketQuote:vi.fn().mockResolvedValue(null),
	getFreeMarketHistory:vi.fn().mockResolvedValue([]),
	getFreeMarketCryptoHistory:mocks.getFreeCryptoHistory,
}));

import {DEFAULT_WATCHLIST,getMarketAssetForTradingSymbol,isMarketExecutionQuoteSource} from '@/lib/live-market';
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
	mocks.getFreeCryptoHistory.mockResolvedValue([]);
});

describe('market-data service provider boundaries',()=>{
	it('marks an old provider quote stale and rejects invalid timestamps',async()=>{
		mocks.getQuote.mockResolvedValueOnce({
			asset,price:200,change:1,changePercent:0.5,updatedAt:new Date(Date.now()-6*60_000).toISOString(),source:'Twelve Data',
		});
		await expect(getMarketQuoteWithFallback(asset,providers)).resolves.toMatchObject({source:'Twelve Data',isStale:true});
		mocks.getQuote.mockResolvedValueOnce({asset,price:200,updatedAt:'not-a-timestamp',source:'Twelve Data'});
		await expect(getMarketQuoteWithFallback(asset,providers)).rejects.toMatchObject({status:503});
	});

	it('uses a fresh free quote when a configured provider only returns stale data',async()=>{
		mocks.getQuote.mockResolvedValueOnce({
			asset,price:200,change:1,changePercent:0.5,updatedAt:new Date(Date.now()-6*60_000).toISOString(),source:'Finnhub',
		});
		const freeQuotes=await import('@/lib/free-market-quotes');
		vi.mocked(freeQuotes.getFreeMarketQuote).mockResolvedValueOnce({
			symbol:'AAPL',price:203,previousClose:200,change:3,changePercent:1.5,
			updatedAt:new Date().toISOString(),source:'Yahoo Finance',isStale:false,
		});

		await expect(getMarketQuoteWithFallback(asset,providers)).resolves.toMatchObject({
			price:203,source:'Yahoo Finance',isStale:false,
		});
	});

	it('does not fabricate a quote when no provider returns data',async()=>{
		mocks.getQuote.mockResolvedValue(null);
		await expect(getMarketQuoteWithFallback(asset,providers)).rejects.toMatchObject({status:503});
	});

	it('maps enabled ETH and EUR/USD trading instruments into the shared market catalogue',()=>{
		expect(getMarketAssetForTradingSymbol('ETH/USD')).toMatchObject({id:'ETH',type:'CRYPTO'});
		expect(getMarketAssetForTradingSymbol('EUR/USD')).toMatchObject({id:'EURUSD',type:'FOREX'});
		expect(DEFAULT_WATCHLIST).toContain('ETH');
		expect(DEFAULT_WATCHLIST).toContain('EURUSD');
	});

	it('shares the accepted live and free quote sources between market display and execution',()=>{
		expect(isMarketExecutionQuoteSource('Finnhub')).toBe(true);
		expect(isMarketExecutionQuoteSource('CoinGecko')).toBe(true);
		expect(isMarketExecutionQuoteSource('Aurevia Internal')).toBe(false);
	});

	it('uses CoinGecko crypto candles when configured history and Yahoo history are unavailable',async()=>{
		mocks.getHistory.mockResolvedValue(null);
		mocks.getFreeCryptoHistory.mockResolvedValue([{time:1_800_000_000,open:100,high:110,low:90,close:105,volume:null}]);

		await expect(getMarketHistoryWithFallback({id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},'1m',providers))
			.resolves.toMatchObject({source:'CoinGecko',candles:[expect.objectContaining({close:105})]});
		expect(mocks.getFreeCryptoHistory).toHaveBeenCalledWith('BTC','5d');
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
