import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	rateLimit:vi.fn(),
	search:vi.fn(),
	indicator:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({marketData:{twelveDataApiKey:'server-only-key'}})}));
vi.mock('@/lib/market-data-service',()=>({
	getAdditionalMarketProviderKeys:()=>({twelveDataApiKey:'server-only-key'}),
	searchMarketSymbols:mocks.search,
	getMarketIndicator:mocks.indicator,
}));

import {GET as search} from '@/app/api/market/search/route';
import {GET as indicators} from '@/app/api/market/indicators/route';

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'user-1'});
	mocks.search.mockResolvedValue([{symbol:'AAPL',name:'Apple Inc.'}]);
	mocks.indicator.mockResolvedValue({values:[{datetime:'2026-11-05',rsi:'55.3'}]});
});

describe('Twelve Data market utility routes',()=>{
	it('returns normalized symbol-search results to authenticated users',async()=>{
		const response=await search(new Request('https://aurevia.test/api/market/search?q=Apple&limit=5'));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({provider:'Twelve Data',results:[{symbol:'AAPL'}]});
		expect(mocks.search).toHaveBeenCalledWith('Apple',5,expect.objectContaining({twelveDataApiKey:'server-only-key'}));
	});

	it('validates indicator inputs before requesting provider data',async()=>{
		const response=await indicators(new Request('https://aurevia.test/api/market/indicators?symbol=AAPL&indicator=unsupported'));
		expect(response.status).toBe(400);
		expect(mocks.indicator).not.toHaveBeenCalled();
	});

	it('returns provider indicator data and prevents unauthenticated access',async()=>{
		const response=await indicators(new Request('https://aurevia.test/api/market/indicators?symbol=AAPL&indicator=rsi&timeframe=1d&outputsize=50'));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({provider:'Twelve Data',result:{values:[{rsi:'55.3'}]}});
		mocks.requireUser.mockRejectedValueOnce(new Error('UNAUTHORIZED'));
		expect((await search(new Request('https://aurevia.test/api/market/search?q=Apple'))).status).toBe(401);
	});
});
