import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getHistory:vi.fn(),
	getConfiguration:vi.fn(),
	getProviders:vi.fn(),
}));

vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getConfiguration}));
vi.mock('@/lib/market-data-service',()=>({
	getAdditionalMarketProviderKeys:mocks.getProviders,
	getMarketHistoryWithFallback:mocks.getHistory,
}));

import {GET} from '@/app/api/live-markets/[symbol]/route';
import {MarketDataError} from '@/lib/live-market';

const request=(symbol='AAPL',timeframe='1d')=>new Request(`https://aurevia.test/api/live-markets/${symbol}?timeframe=${timeframe}`);
const candles=[{time:1_800_000_000,open:190,high:192,low:188,close:191,volume:10}];

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getConfiguration.mockReturnValue({marketData:{twelveDataApiKey:'server-key',twelveDataBaseUrl:'https://api.twelvedata.com'}});
	mocks.getProviders.mockReturnValue({twelveDataApiKey:'server-key',twelveDataBaseUrl:'https://api.twelvedata.com'});
});

describe('market history route',()=>{
	it('returns provider history when available',async()=>{
		mocks.getHistory.mockResolvedValue({source:'Twelve Data',candles});
		const response=await GET(request(),{params:Promise.resolve({symbol:'AAPL'})});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({source:'Twelve Data',candles});
		expect(mocks.getHistory).toHaveBeenCalledWith(
			expect.objectContaining({id:'AAPL'}),'1d',expect.objectContaining({twelveDataApiKey:'server-key'}),
		);
	});

	it('reports unavailable provider history without fabricated candle fallback',async()=>{
		mocks.getHistory.mockRejectedValue(new MarketDataError('Historical market data is not configured or available.',503));
		const response=await GET(request(),{params:Promise.resolve({symbol:'AAPL'})});
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({code:'MARKET_HISTORY_UNAVAILABLE'});
	});

	it('rejects unsupported symbols and timeframes',async()=>{
		expect((await GET(request('UNKNOWN'),{params:Promise.resolve({symbol:'UNKNOWN'})})).status).toBe(404);
		expect((await GET(request('AAPL','invalid'),{params:Promise.resolve({symbol:'AAPL'})})).status).toBe(400);
		expect(mocks.getHistory).not.toHaveBeenCalled();
	});
});
