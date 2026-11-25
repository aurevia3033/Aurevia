import {AccountMode,FundingStatus,FundingType,OrderSide,OrderStatus,Prisma} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';
import {availableWalletAmount,getRealWalletReservations} from '@/lib/real-wallet-reservations';

const Decimal=Prisma.Decimal;

function transaction(orderRows:Array<Record<string,unknown>>,withdrawalAmount='0'){
	return {
		order:{findMany:vi.fn().mockResolvedValue(orderRows)},
		fundingRequest:{aggregate:vi.fn(async(args:{where:{currency:string}})=>({
			_sum:{amount:new Decimal(args.where.currency==='EUR'?withdrawalAmount:'0')},
		}))},
	} as unknown as Prisma.TransactionClient;
}

function orderFixture(overrides:Record<string,unknown>={}){
	return {
		id:'order-1',side:OrderSide.BUY,status:OrderStatus.OPEN,quantity:new Decimal(2),filledQuantity:new Decimal('0.5'),
		providerReservedAmount:new Decimal(200),price:null,stopPrice:null,averageFillPrice:null,providerName:null,
		settlementCurrency:'USD',
		instrument:{baseAsset:'BTC',quoteAsset:'USD',price:new Decimal(100),takerFee:new Decimal('0.01')},
		...overrides,
	};
}

describe('REAL wallet currency reservations',()=>{
	it('reserves the unfilled buy amount only in its settlement currency',async()=>{
		const tx=transaction([orderFixture()]);

		const usd=await getRealWalletReservations(tx,'user-1','USD');
		const eur=await getRealWalletReservations(tx,'user-1','EUR');

		expect(usd.buy.toString()).toBe('150');
		expect(usd.sell.toString()).toBe('0');
		expect(eur.buy.toString()).toBe('0');
		expect(eur.sell.toString()).toBe('0');
	});

	it('reserves open sell assets and pending withdrawals in their own currencies',async()=>{
		const sell=orderFixture({
			id:'sell-1',side:OrderSide.SELL,quantity:new Decimal(1),filledQuantity:new Decimal('0.2'),
			providerReservedAmount:null,settlementCurrency:'EUR',
		});
		const tx=transaction([sell],'20');

		const btc=await getRealWalletReservations(tx,'user-1','BTC');
		const eur=await getRealWalletReservations(tx,'user-1','EUR');

		expect(btc.sell.toString()).toBe('0.8');
		expect(btc.withdrawals.toString()).toBe('0');
		expect(eur.sell.toString()).toBe('0');
		expect(eur.withdrawals.toString()).toBe('20');
		expect(tx.fundingRequest.aggregate).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({accountMode:AccountMode.REAL,currency:'EUR',type:FundingType.WITHDRAWAL,status:{in:[
				FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING,
			]}}),
		}));
	});

	it('subtracts open-order and withdrawal reservations from available wallet balance',()=>{
		const reservations={
			buy:new Decimal(150),sell:new Decimal(0),withdrawals:new Decimal(20),unboundedBuyReservation:false,
		};

		expect(availableWalletAmount(new Decimal(175),reservations).toString()).toBe('5');
		expect(availableWalletAmount(new Decimal(100),{...reservations,unboundedBuyReservation:true}).toString()).toBe('0');
	});

	it('fully blocks funds reserved by a legacy provider order without a trustworthy limit price',async()=>{
		const legacy=orderFixture({
			providerName:'alpaca-paper',providerReservedAmount:null,price:null,stopPrice:null,
			averageFillPrice:null,
			instrument:{baseAsset:'BTC',quoteAsset:'USD',price:new Decimal(0),takerFee:new Decimal('0.01')},
		});
		const reservations=await getRealWalletReservations(transaction([legacy]),'user-1','USD');

		expect(reservations.unboundedBuyReservation).toBe(true);
		expect(availableWalletAmount(new Decimal(10_000),reservations).toString()).toBe('0');
	});
});
