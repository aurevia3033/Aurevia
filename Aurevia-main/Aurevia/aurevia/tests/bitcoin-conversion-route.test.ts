import {AccountMode,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	instrumentFindUnique:vi.fn(),
	placeRealOrder:vi.fn(),
	resolveTwelveDataExecutionQuote:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.userFindUnique},instrument:{findUnique:mocks.instrumentFindUnique}}}));
vi.mock('@/lib/orders',()=>({placeRealOrder:mocks.placeRealOrder,resolveTwelveDataExecutionQuote:mocks.resolveTwelveDataExecutionQuote}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/serializers',()=>({jsonSafe:(value:unknown)=>value}));

import {GET,POST} from '@/app/api/wallet/convert-bitcoin/route';

const quoteTime=new Date(Date.now()-1_000).toISOString();
const instrument=()=>({
	id:'btc-instrument',symbol:'BTC/USD',enabled:true,price:new Prisma.Decimal('100000'),
	takerFee:new Prisma.Decimal('0.0015'),baseAsset:'BTC',quoteAsset:'USD',updatedAt:new Date(quoteTime),
});
const idempotencyKey='conversion-key-001';
const request=(body:unknown)=>new Request('http://localhost/api/wallet/convert-bitcoin',{
	method:'POST',
	headers:{'content-type':'application/json','Idempotency-Key':idempotencyKey},
	body:JSON.stringify(body),
});
const confirm=(direction:'BUY'|'SELL',amount:string,referencePrice='100000',observedAt=quoteTime)=>({
	direction,amount,confirmed:true,referencePrice,observedAt,
});

describe('REAL simulated Bitcoin conversion route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({accountMode:AccountMode.REAL,status:'ACTIVE',role:'USER'});
		mocks.instrumentFindUnique.mockResolvedValue(instrument());
		mocks.resolveTwelveDataExecutionQuote.mockResolvedValue({price:100000,updatedAt:quoteTime});
		mocks.placeRealOrder.mockResolvedValue({
			id:'internal-order-1',status:'FILLED',side:'BUY',type:'MARKET',quantity:new Prisma.Decimal('0.0009985'),
			filledQuantity:new Prisma.Decimal('0.0009985'),averageFillPrice:new Prisma.Decimal('100000'),
			fee:new Prisma.Decimal('0.15'),settlementCurrency:'USD',
		});
	});

	it('shows source, simulated rate, fee, and final amount in the authenticated preview',async()=>{
		const response=await GET(new Request('http://localhost/api/wallet/convert-bitcoin?direction=BUY&amount=100.00'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result).toMatchObject({
			direction:'BUY',sourceAsset:'USD',destinationAsset:'BTC',rateCurrency:'USD/BTC',
			sourceAmount:'100',fee:'0.15',feeCurrency:'USD',finalAmount:'0.0009985',
			finalCurrency:'BTC',priceSource:'Twelve Data',simulated:true,
		});
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('submits a confirmed internal wallet-funded buy and never invokes an external provider',async()=>{
		const response=await POST(request(confirm('BUY','100.00')));
		const result=await response.json();

		expect(response.status).toBe(201);
		expect(mocks.placeRealOrder).toHaveBeenCalledWith('user-1',{
			instrumentId:'btc-instrument',side:'BUY',type:'MARKET',quantity:0.0009985,
			expectedPrice:100_000,observedAt:quoteTime,
		},idempotencyKey,{requireExpectedPriceMatch:true,validatedQuote:{price:100000,updatedAt:quoteTime}});
		expect(result).toMatchObject({
			direction:'BUY',sourceAsset:'USD',destinationAsset:'BTC',sourceAmount:'100',
			fee:'0.15',finalAmount:'0.0009985',executionProvider:'AUREVIA_INTERNAL_SIMULATION',simulated:true,
		});
		expect(JSON.stringify(result)).not.toContain('ALPACA');
	});

	it('uses the requested wallet BTC amount for a sell conversion',async()=>{
		mocks.placeRealOrder.mockResolvedValueOnce({
			id:'internal-order-2',status:'FILLED',side:'SELL',type:'MARKET',quantity:new Prisma.Decimal('0.0025'),
			filledQuantity:new Prisma.Decimal('0.0025'),averageFillPrice:new Prisma.Decimal('100000'),
			fee:new Prisma.Decimal('0.38'),settlementCurrency:'USD',
		});
		const response=await POST(request(confirm('SELL','0.0025')));
		const result=await response.json();

		expect(response.status).toBe(201);
		expect(mocks.placeRealOrder).toHaveBeenCalledWith('user-1',expect.objectContaining({side:'SELL',quantity:0.0025}),idempotencyKey,{requireExpectedPriceMatch:true,validatedQuote:{price:100000,updatedAt:quoteTime}});
		expect(result).toMatchObject({sourceAsset:'BTC',sourceAmount:'0.0025',destinationAsset:'USD',fee:'0.38',finalAmount:'249.62'});
	});

	it('requires the explicit confirmation flag and integer-cent USD input',async()=>{
		const missingConfirmation=await POST(request({direction:'BUY',amount:'100.00'}));
		const fractionalCent=await POST(request(confirm('BUY','10.001')));

		expect(missingConfirmation.status).toBe(400);
		expect(fractionalCent.status).toBe(400);
		expect(mocks.placeRealOrder).not.toHaveBeenCalled();
	});

	it('rejects a changed simulated price instead of silently converting at a new rate',async()=>{
		const response=await POST(request(confirm('BUY','100.00','99999')));

		expect(response.status).toBe(409);
		expect(mocks.placeRealOrder).not.toHaveBeenCalled();
	});

	it('rejects a stale quote and an unavailable account mode',async()=>{
		mocks.instrumentFindUnique.mockResolvedValueOnce({...instrument(),updatedAt:new Date(Date.now()-60_000)});
		mocks.resolveTwelveDataExecutionQuote.mockResolvedValueOnce({price:100000,updatedAt:new Date(Date.now()-60_000).toISOString()});
		const staleResponse=await POST(request(confirm('BUY','100.00')));
		mocks.userFindUnique.mockResolvedValueOnce({accountMode:AccountMode.DEMO,status:'ACTIVE',role:'USER'});
		const demoResponse=await POST(request(confirm('BUY','100.00')));

		expect(staleResponse.status).toBe(503);
		expect(demoResponse.status).toBe(403);
		expect(mocks.placeRealOrder).not.toHaveBeenCalled();
	});

	it('reports insufficient USD wallet funds without creating a successful-looking conversion',async()=>{
		mocks.placeRealOrder.mockRejectedValueOnce(new Error('INSUFFICIENT_REAL_WALLET_COLLATERAL'));
		const response=await POST(request(confirm('BUY','100.00')));

		expect(response.status).toBe(409);
		expect((await response.json()).error).toContain('available USD');
	});
});
