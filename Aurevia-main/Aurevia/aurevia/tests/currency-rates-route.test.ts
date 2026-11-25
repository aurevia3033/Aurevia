import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	upsert:vi.fn(),
	rateLimit:vi.fn(),
	getConfiguration:vi.fn(),
	getProviders:vi.fn(),
	getQuote:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{exchangeRate:{findUnique:mocks.findUnique,upsert:mocks.upsert}}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:mocks.getConfiguration}));
vi.mock('@/lib/market-data-service',()=>({
	getAdditionalMarketProviderKeys:mocks.getProviders,
	getMarketQuoteWithFallback:mocks.getQuote,
}));

import {GET} from '@/app/api/currency-rates/route';

const request=new Request('http://localhost/api/currency-rates?to=EUR');

beforeEach(()=>{
	mocks.requireUser.mockReset().mockResolvedValue({id:'user-1'});
	mocks.findUnique.mockReset().mockResolvedValue(null);
	mocks.upsert.mockReset().mockImplementation(({create})=>Promise.resolve({...create}));
	mocks.rateLimit.mockReset();
	mocks.getConfiguration.mockReset().mockReturnValue({marketData:{}});
	mocks.getProviders.mockReset().mockReturnValue({});
	mocks.getQuote.mockReset().mockRejectedValue(new Error('PROVIDER_UNAVAILABLE'));
	vi.spyOn(console,'warn').mockImplementation(()=>undefined);
});
afterEach(()=>vi.restoreAllMocks());

describe('currency rate provider handling',()=>{
	it('reports unavailable instead of inventing an exchange rate',async()=>{
		const response=await GET(request);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({error:'A verified exchange rate is currently unavailable.'});
		expect(mocks.upsert).not.toHaveBeenCalled();
	});

	it('continues using the last known rate and labels it stale when the provider is unavailable',async()=>{
		mocks.findUnique.mockResolvedValue({
			rate:'0.91',source:'Twelve Data',observedAt:new Date(Date.now()-48*60*60_000),
		});
		const response=await GET(request);
		expect(await response.json()).toMatchObject({rate:'0.91',source:'Twelve Data',status:'STALE'});
	});

	it('uses and stores a timestamped Twelve Data rate when available',async()=>{
		mocks.getQuote.mockResolvedValue({
			price:0.93,source:'Twelve Data',isStale:false,updatedAt:new Date().toISOString(),
		});
		const response=await GET(request);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({rate:0.93,source:'Twelve Data',status:'CURRENT'});
		expect(mocks.getQuote).toHaveBeenCalledWith(
			expect.objectContaining({ticker:'USD/EUR',type:'FOREX'}),{},
		);
		expect(mocks.upsert).toHaveBeenCalledOnce();
	});
});
