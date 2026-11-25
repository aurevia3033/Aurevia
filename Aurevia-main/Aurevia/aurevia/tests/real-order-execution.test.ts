import {AccountMode,EntryType,OrderSide,OrderStatus,OrderType,Prisma} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	orderFindUnique:vi.fn(),
	orderUpdate:vi.fn(),
	ledgerAccount:vi.fn(),
	balance:vi.fn(),
	treasuryAvailable:vi.fn(),
	ensureSystemAccount:vi.fn(),
	reservations:vi.fn(),
	lockCurrencies:vi.fn(),
	ledgerTransactionCreate:vi.fn(),
	queryRaw:vi.fn(),
	executionCreate:vi.fn(),
	positionFindFirst:vi.fn(),
	positionFindMany:vi.fn(),
	positionCreate:vi.fn(),
	positionUpdate:vi.fn(),
	auditLogCreate:vi.fn(),
	notification:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{}}));
vi.mock('@/lib/ledger',()=>({
	balance:mocks.balance,
	ensureSystemAccount:mocks.ensureSystemAccount,
}));
vi.mock('@/lib/platform-bank',()=>({getTreasuryAvailable:mocks.treasuryAvailable}));
vi.mock('@/lib/real-wallet-reservations',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/real-wallet-reservations')>();
	return {...original,getRealWalletReservations:mocks.reservations,lockRealWalletCurrencies:mocks.lockCurrencies};
});
vi.mock('@/lib/notifications',()=>({createNotification:mocks.notification}));

import {executeRealOrderTx} from '@/lib/orders';

const Decimal=Prisma.Decimal;

function order(side:OrderSide,quantity='2'){
	return {
		id:`${side.toLowerCase()}-order`,userId:'user-1',instrumentId:'btc-usd',accountMode:AccountMode.REAL,
		side,type:OrderType.LIMIT,status:OrderStatus.OPEN,quantity:new Decimal(quantity),filledQuantity:new Decimal(0),
		price:new Decimal(90),stopPrice:null,averageFillPrice:null,fee:new Decimal(0),settlementCurrency:'USD',
		providerName:null,instrument:{
			id:'btc-usd',symbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD',price:new Decimal(100),
			takerFee:new Decimal('0.01'),updatedAt:new Date(),
		},
	};
}

describe('REAL internal simulated order settlement',()=>{
	let currentOrder:ReturnType<typeof order>;
	let currentPosition:Record<string,unknown>|null;
	let tx:Prisma.TransactionClient;

	beforeEach(()=>{
		vi.clearAllMocks();
		currentOrder=order(OrderSide.BUY);
		currentPosition=null;
		mocks.orderFindUnique.mockImplementation(async()=>currentOrder);
		mocks.orderUpdate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
			const fee=data.fee as {increment:Prisma.Decimal}|undefined;
			currentOrder={...currentOrder,...data,fee:fee?currentOrder.fee.plus(fee.increment):currentOrder.fee} as ReturnType<typeof order>;
			return {...currentOrder,executions:[],instrument:currentOrder.instrument};
		});
		mocks.ledgerAccount.mockImplementation(async({where}:{where:{code:string}})=>({id:where.code,currency:where.code.split(':').at(-1)}));
		mocks.balance.mockImplementation(async(_transaction:unknown,accountId:string)=>new Decimal(accountId.includes('TREASURY')?'1000':accountId.endsWith(':BTC')?'2':'1000'));
		mocks.treasuryAvailable.mockResolvedValue(new Decimal(1000));
		mocks.ensureSystemAccount.mockImplementation(async(_transaction:unknown,code:string,_name:string,currency:string)=>({id:code,currency}));
		mocks.reservations.mockResolvedValue({buy:new Decimal(0),sell:new Decimal(0),withdrawals:new Decimal(0),unboundedBuyReservation:false});
		mocks.lockCurrencies.mockResolvedValue(undefined);
		mocks.ledgerTransactionCreate.mockResolvedValue({});
		mocks.executionCreate.mockResolvedValue({});
		mocks.positionFindFirst.mockImplementation(async()=>currentPosition);
		mocks.positionFindMany.mockImplementation(async()=>currentPosition?[currentPosition]:[]);
		mocks.positionCreate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
			currentPosition={id:'position-1',...data,realizedPnl:new Decimal(0)};
			return currentPosition;
		});
		mocks.positionUpdate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
			if(!currentPosition)throw new Error('position missing');
			const previous=currentPosition;
			currentPosition={...previous,...data};
			if(data.quantity&&typeof data.quantity==='object'&&'increment'in data.quantity){
				currentPosition.quantity=(previous.quantity as Prisma.Decimal).plus((data.quantity as {increment:Prisma.Decimal}).increment);
			}
			if(data.realizedPnl&&typeof data.realizedPnl==='object'&&'increment'in data.realizedPnl){
				currentPosition.realizedPnl=(previous.realizedPnl as Prisma.Decimal).plus((data.realizedPnl as {increment:Prisma.Decimal}).increment);
			}
			return currentPosition;
		});
		mocks.auditLogCreate.mockResolvedValue({});
		mocks.notification.mockResolvedValue(undefined);
		tx={
			order:{findUnique:mocks.orderFindUnique,update:mocks.orderUpdate},
			ledgerAccount:{findUniqueOrThrow:mocks.ledgerAccount},
			ledgerTransaction:{create:mocks.ledgerTransactionCreate},
			$queryRaw:mocks.queryRaw,
			execution:{create:mocks.executionCreate},
			position:{
				findFirst:mocks.positionFindFirst,findMany:mocks.positionFindMany,
				create:mocks.positionCreate,update:mocks.positionUpdate,
			},
			auditLog:{create:mocks.auditLogCreate},
		} as unknown as Prisma.TransactionClient;
	});

	it('posts a partial buy fill, fee, and matching wallet-backed position',async()=>{
		await executeRealOrderTx(tx as unknown as Prisma.TransactionClient,currentOrder.id,80,new Decimal(1));

		expect(currentOrder.status).toBe(OrderStatus.PARTIALLY_FILLED);
		expect(currentOrder.filledQuantity.toString()).toBe('1');
		expect(currentOrder.fee.toString()).toBe('0.8');
		expect(currentPosition).toMatchObject({status:'OPEN',settlementCurrency:'USD'});
		expect((currentPosition?.quantity as Prisma.Decimal).toString()).toBe('1');
		expect((currentPosition?.margin as Prisma.Decimal).toString()).toBe('80.8');
		expect(mocks.ledgerTransactionCreate).toHaveBeenCalledTimes(1);
		const entries=mocks.ledgerTransactionCreate.mock.calls[0][0].data.entries.create as Array<{account:{connect:{id:string}};type:EntryType;amount:Prisma.Decimal}>;
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({account:{connect:{id:'USER:user-1:REAL:USD'}},type:EntryType.DEBIT,amount:new Decimal(80)}),
			expect.objectContaining({account:{connect:{id:'USER:user-1:REAL:USD'}},type:EntryType.DEBIT,amount:new Decimal('0.8')}),
			expect.objectContaining({account:{connect:{id:'USER:user-1:REAL:BTC'}},type:EntryType.CREDIT,amount:new Decimal(1)}),
		]));
	});

	it('credits net sell proceeds and records realized profit after fees',async()=>{
		currentOrder=order(OrderSide.SELL,'1');
		currentPosition={
			id:'position-1',userId:'user-1',instrumentId:'btc-usd',accountMode:AccountMode.REAL,side:OrderSide.BUY,
			status:'OPEN',quantity:new Decimal(1),entryPrice:new Decimal('100.5'),margin:new Decimal('100.5'),
			realizedPnl:new Decimal(0),settlementCurrency:'USD',
		};
		await executeRealOrderTx(tx as unknown as Prisma.TransactionClient,currentOrder.id,120,new Decimal(1));

		expect(currentOrder.status).toBe(OrderStatus.FILLED);
		expect(currentPosition?.status).toBe('CLOSED');
		expect((currentPosition?.realizedPnl as Prisma.Decimal).toString()).toBe('18.3');
		const entries=mocks.ledgerTransactionCreate.mock.calls[0][0].data.entries.create as Array<{account:{connect:{id:string}};type:EntryType;amount:Prisma.Decimal}>;
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({account:{connect:{id:'USER:user-1:REAL:USD'}},type:EntryType.CREDIT,amount:new Decimal('118.8')}),
			expect.objectContaining({account:{connect:{id:'SYSTEM:REAL:TRADING_FEES:USD'}},type:EntryType.CREDIT,amount:new Decimal('1.2')}),
			expect.objectContaining({account:{connect:{id:'SYSTEM:REAL:TREASURY:USD'}},type:EntryType.DEBIT,amount:new Decimal('18.3')}),
		]));
	});

	it('does not fill a profitable REAL sell when treasury cannot back the profit',async()=>{
		currentOrder=order(OrderSide.SELL,'1');
		currentPosition={
			id:'position-1',userId:'user-1',instrumentId:'btc-usd',accountMode:AccountMode.REAL,side:OrderSide.BUY,
			status:'OPEN',quantity:new Decimal(1),entryPrice:new Decimal('100.5'),margin:new Decimal('100.5'),
			realizedPnl:new Decimal(0),settlementCurrency:'USD',
		};
		mocks.balance.mockImplementation(async(_transaction:unknown,accountId:string)=>new Decimal(accountId.includes('TREASURY')?'0':accountId.endsWith(':BTC')?'2':'1000'));
		mocks.treasuryAvailable.mockResolvedValue(new Decimal(0));
		await expect(executeRealOrderTx(tx as unknown as Prisma.TransactionClient,currentOrder.id,120,new Decimal(1))).rejects.toThrow('INSUFFICIENT_TREASURY_BALANCE');
		expect(mocks.ledgerTransactionCreate).not.toHaveBeenCalled();
		expect(currentOrder.status).toBe(OrderStatus.OPEN);
		expect(currentPosition?.status).toBe('OPEN');
	});
});
