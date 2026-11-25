import {AccountMode,OrderSide,OrderStatus,OrderType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	transaction:vi.fn(),
	priorOrder:vi.fn(),
	createOrder:vi.fn(),
	user:vi.fn(),
	instrument:vi.fn(),
	ledgerAccount:vi.fn(),
	auditLog:vi.fn(),
	balance:vi.fn(),
	lockCurrencies:vi.fn(),
	reservations:vi.fn(),
	notification:vi.fn(),
	getQuote:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	$transaction:mocks.transaction,
	order:{findUnique:mocks.priorOrder},
	instrument:{findUnique:mocks.instrument},
}}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance}));
vi.mock('@/lib/real-wallet-reservations',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/real-wallet-reservations')>();
	return {...original,getRealWalletReservations:mocks.reservations,lockRealWalletCurrencies:mocks.lockCurrencies};
});
vi.mock('@/lib/notifications',()=>({createNotification:mocks.notification}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({marketData:{twelveDataApiKey:'test',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:true}})}));
vi.mock('@/lib/live-market',()=>({
	getMarketAssetForTradingSymbol:vi.fn(()=>({id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'})),
	isMarketExecutionQuoteSource:vi.fn((source:string)=>['Twelve Data','Finnhub','Alpha Vantage','Financial Modeling Prep','Binance','CoinGecko','Frankfurter','Yahoo Finance','Stooq'].includes(source)),
}));
vi.mock('@/lib/market-data-service',()=>({
	getAdditionalMarketProviderKeys:vi.fn(()=>({twelveDataApiKey:'test',twelveDataBaseUrl:'https://api.twelvedata.com',productionLicenseConfirmed:true})),
	getMarketQuoteWithFallback:mocks.getQuote,
}));

import {placeRealOrder} from '@/lib/orders';

const Decimal=Prisma.Decimal;
const instrument=(overrides:Record<string,unknown>={})=>({
	id:'instrument-1',symbol:'BTC/USD',enabled:true,baseAsset:'BTC',quoteAsset:'USD',
	price:new Decimal(100),takerFee:new Decimal('0.01'),updatedAt:new Date(Date.now()-1_000),...overrides,
});
const input=(overrides:Record<string,unknown>={})=>({
	instrumentId:'instrument-1',side:OrderSide.BUY,type:OrderType.LIMIT,quantity:2,
	price:90,expectedPrice:100,observedAt:new Date(Date.now()-1_000).toISOString(),...overrides,
});

describe('REAL internal wallet-funded order placement',()=>{
	let selectedInstrument:ReturnType<typeof instrument>;
	let walletByCurrency:Record<string,Prisma.Decimal>;
	let tx:Record<string,Record<string,ReturnType<typeof vi.fn>>>;

	beforeEach(()=>{
		vi.clearAllMocks();
		selectedInstrument=instrument();
		walletByCurrency={USD:new Decimal(1_000),EUR:new Decimal(1_000),BTC:new Decimal(1)};
		mocks.priorOrder.mockResolvedValue(null);
		mocks.user.mockResolvedValue({
			id:'user-1',role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,accountRestricted:false,bankAccount:null,
		});
		mocks.instrument.mockImplementation(async()=>selectedInstrument);
		mocks.ledgerAccount.mockImplementation(async({where}:{where:{code:string}})=>({id:where.code,currency:where.code.split(':').at(-1)}));
		mocks.balance.mockImplementation(async(_tx:unknown,accountId:string)=>walletByCurrency[accountId.split(':').at(-1)||'']||new Decimal(0));
		mocks.lockCurrencies.mockResolvedValue(undefined);
		mocks.reservations.mockResolvedValue({buy:new Decimal(0),sell:new Decimal(0),withdrawals:new Decimal(0),unboundedBuyReservation:false});
		mocks.auditLog.mockResolvedValue({});
		mocks.notification.mockResolvedValue(undefined);
		mocks.getQuote.mockImplementation(async()=>({
			price:selectedInstrument.price.toNumber(),updatedAt:new Date(Date.now()-1_000).toISOString(),
			source:'Twelve Data',isStale:false,
		}));
		mocks.createOrder.mockImplementation(async({data}:{data:Record<string,unknown>})=>({
			id:'order-1',...data,quantity:new Decimal(String(data.quantity)),filledQuantity:new Decimal(0),
			status:OrderStatus.OPEN,instrument:selectedInstrument,executions:[],
		}));
		tx={
			order:{findUnique:mocks.priorOrder,create:mocks.createOrder},
			user:{findUnique:mocks.user},
			instrument:{findUnique:mocks.instrument},
			ledgerAccount:{findUniqueOrThrow:mocks.ledgerAccount},
			auditLog:{create:mocks.auditLog},
		};
		mocks.transaction.mockImplementation(async(callback:(transaction:unknown)=>Promise<unknown>)=>callback(tx));
	});

	it('reserves USD settlement funds plus fees for an open buy order',async()=>{
		const order=await placeRealOrder('user-1',input(), 'real-order-key-001',{requireExpectedPriceMatch:true});

		expect(order).toMatchObject({id:'order-1',status:OrderStatus.OPEN,settlementCurrency:'USD'});
		expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			settlementCurrency:'USD',providerReservedAmount:new Decimal('181.8'),
		})}));
		expect(mocks.lockCurrencies).toHaveBeenCalledWith(tx,'user-1',['USD','BTC']);
		expect(mocks.balance).toHaveBeenCalledWith(tx,'USER:user-1:REAL:USD');
	});

	it('rejects orders below $50 and accepts the exact minimum at the current quote',async()=>{
		await expect(placeRealOrder('user-1',input({quantity:0.499}),'below-minimum-order-001'))
			.rejects.toThrow('MINIMUM_ORDER_NOTIONAL');
		expect(mocks.createOrder).not.toHaveBeenCalled();

		await placeRealOrder('user-1',input({quantity:0.5}),'minimum-order-key-001');
		expect(mocks.createOrder).toHaveBeenCalledTimes(1);
	});

	it('allows a full wallet-asset close below $50 but rejects a smaller partial sell',async()=>{
		walletByCurrency.BTC=new Decimal('0.4');
		await expect(placeRealOrder('user-1',input({side:OrderSide.SELL,quantity:0.3,price:110}),'small-partial-sell-001'))
			.rejects.toThrow('MINIMUM_ORDER_NOTIONAL');

		await placeRealOrder('user-1',input({side:OrderSide.SELL,quantity:0.4,price:110}),'full-close-order-001');
		expect(mocks.createOrder).toHaveBeenCalledTimes(1);
	});

	it('requires the instrument settlement currency instead of silently using USD funds',async()=>{
		selectedInstrument=instrument({quoteAsset:'EUR',price:new Decimal(50)});
		walletByCurrency={USD:new Decimal(100_000),EUR:new Decimal(100),BTC:new Decimal(1)};
		const order=await placeRealOrder('user-1',input({expectedPrice:50,price:40,observedAt:selectedInstrument.updatedAt.toISOString()}),'eur-order-key-001');

		expect(order).toMatchObject({settlementCurrency:'EUR'});
		expect(mocks.balance).toHaveBeenCalledWith(tx,'USER:user-1:REAL:EUR');
		expect(mocks.createOrder).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			settlementCurrency:'EUR',providerReservedAmount:new Decimal('80.8'),
		})}));
	});

	it('rejects insufficient settlement funds even when another currency has a large balance',async()=>{
		selectedInstrument=instrument({quoteAsset:'EUR',price:new Decimal(50)});
		walletByCurrency={USD:new Decimal(100_000),EUR:new Decimal(10),BTC:new Decimal(1)};

		await expect(placeRealOrder('user-1',input({expectedPrice:50,price:40,observedAt:selectedInstrument.updatedAt.toISOString()}),'poor-eur-order-001'))
			.rejects.toThrow('INSUFFICIENT_REAL_WALLET_COLLATERAL');
		expect(mocks.createOrder).not.toHaveBeenCalled();
	});

	it('rejects sells that exceed available base assets after existing sell reservations',async()=>{
		mocks.reservations.mockResolvedValueOnce({
			buy:new Decimal(0),sell:new Decimal('0.5'),withdrawals:new Decimal(0),unboundedBuyReservation:false,
		});
		walletByCurrency.BTC=new Decimal(2);

		await expect(placeRealOrder('user-1',input({side:OrderSide.SELL,quantity:1.6,price:110}),'sell-btc-order-001'))
			.rejects.toThrow('INSUFFICIENT_POSITION');
		expect(mocks.createOrder).not.toHaveBeenCalled();
	});

	it('rejects a malformed instrument whose base and settlement currencies are identical',async()=>{
		selectedInstrument=instrument({quoteAsset:'BTC'});

		await expect(placeRealOrder('user-1',input(),'bad-currency-order-001'))
			.rejects.toThrow('INSTRUMENT_CURRENCY_UNAVAILABLE');
		expect(mocks.createOrder).not.toHaveBeenCalled();
	});

	it('enforces the server-observed internal simulated price',async()=>{
		selectedInstrument=instrument({price:new Decimal(101)});

		await expect(placeRealOrder('user-1',input(),'stale-price-order-001',{requireExpectedPriceMatch:true}))
			.rejects.toThrow('STALE_MARKET_QUOTE');
		expect(mocks.createOrder).not.toHaveBeenCalled();
	});

	it('rejects REAL placement when Twelve Data is unavailable',async()=>{
		mocks.getQuote.mockRejectedValueOnce(new Error('Twelve Data unavailable'));
		await expect(placeRealOrder('user-1',input(),'provider-unavailable-key-001',{requireExpectedPriceMatch:true}))
			.rejects.toThrow('MARKET_QUOTE_UNAVAILABLE');
		expect(mocks.createOrder).not.toHaveBeenCalled();
	});

	it('accepts a fresh configured fallback provider quote for REAL placement',async()=>{
		mocks.getQuote.mockResolvedValueOnce({
			price:100,updatedAt:new Date(Date.now()-1_000).toISOString(),source:'Finnhub',isStale:false,
		});

		await placeRealOrder('user-1',input(),'finnhub-order-key-001',{requireExpectedPriceMatch:true});

		expect(mocks.createOrder).toHaveBeenCalledOnce();
	});

	it('accepts a fresh free-provider quote for REAL placement',async()=>{
		mocks.getQuote.mockResolvedValueOnce({
			price:100,updatedAt:new Date(Date.now()-1_000).toISOString(),source:'CoinGecko',isStale:false,
		});

		await placeRealOrder('user-1',input(),'coingecko-order-key-001',{requireExpectedPriceMatch:true});

		expect(mocks.createOrder).toHaveBeenCalledOnce();
	});

	it('returns a matching idempotent order without placing it twice',async()=>{
		const existing={id:'order-existing',userId:'user-1',accountMode:AccountMode.REAL,instrumentId:'instrument-1',side:OrderSide.BUY,
			type:OrderType.LIMIT,quantity:new Decimal(2),price:new Decimal(90),stopPrice:null,providerName:null};
		mocks.priorOrder.mockResolvedValue(existing);

		const order=await placeRealOrder('user-1',input(),'real-order-key-001');

		expect(order).toBe(existing);
		expect(mocks.createOrder).not.toHaveBeenCalled();
		expect(mocks.user).not.toHaveBeenCalled();
	});
});
