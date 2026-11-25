import {AccountMode,FundingStatus,FundingType,OrderSide,OrderStatus,Prisma,PrismaClient} from '@prisma/client';
import {ensureUserLedger} from '@/lib/ledger';

type TransactionClient=PrismaClient|Prisma.TransactionClient;
const Decimal=Prisma.Decimal;
const reservingOrderStatuses=[OrderStatus.OPEN,OrderStatus.PARTIALLY_FILLED,OrderStatus.PENDING_CANCEL];
const reservingWithdrawalStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING];

export type WalletReservations={
	buy:Prisma.Decimal;
	sell:Prisma.Decimal;
	withdrawals:Prisma.Decimal;
	unboundedBuyReservation:boolean;
};

export async function lockRealWalletCurrencies(tx:Prisma.TransactionClient,userId:string,currencies:string[]){
	const normalized=[...new Set(currencies.map(currency=>currency.trim().toUpperCase()))].sort();
	const accounts=[];
	for(const currency of normalized)accounts.push(await ensureUserLedger(tx,userId,AccountMode.REAL,currency));
	for(const account of accounts){
		await tx.$queryRaw`SELECT "id" FROM "LedgerAccount" WHERE "id" = ${account.id} FOR UPDATE`;
	}
	return accounts;
}

export async function getRealWalletReservations(
	tx:TransactionClient,userId:string,currency:string,excludeOrderId?:string,excludeWithdrawalRequestId?:string,
):Promise<WalletReservations>{
	const normalized=currency.toUpperCase();
	const [orders,withdrawals]=await Promise.all([
		tx.order.findMany({
			where:{userId,accountMode:AccountMode.REAL,status:{in:reservingOrderStatuses},...(excludeOrderId?{id:{not:excludeOrderId}}:{})},
			select:{
				id:true,side:true,quantity:true,filledQuantity:true,providerReservedAmount:true,
				price:true,stopPrice:true,averageFillPrice:true,providerName:true,settlementCurrency:true,
				instrument:{select:{baseAsset:true,quoteAsset:true,price:true,takerFee:true}},
			},
		}),
		tx.fundingRequest.aggregate({
			where:{userId,accountMode:AccountMode.REAL,currency:normalized,type:FundingType.WITHDRAWAL,status:{in:reservingWithdrawalStatuses},...(excludeWithdrawalRequestId?{id:{not:excludeWithdrawalRequestId}}:{})},
			_sum:{amount:true},
		}),
	]);
	let buy=new Decimal(0);
	let sell=new Decimal(0);
	let unboundedBuyReservation=false;
	for(const order of orders){
		const remaining=Decimal.max(order.quantity.minus(order.filledQuantity),new Decimal(0));
		if(remaining.isZero())continue;
		const quoteCurrency=(order.settlementCurrency||order.instrument.quoteAsset).toUpperCase();
		const baseCurrency=order.instrument.baseAsset.toUpperCase();
		if(order.side===OrderSide.BUY&&quoteCurrency===normalized){
			if(order.providerReservedAmount&&order.quantity.gt(0)){
				buy=buy.plus(order.providerReservedAmount.mul(remaining).div(order.quantity));
			}else if(order.providerName){
				const referencePrice=order.price??order.stopPrice;
				if(!referencePrice?.isFinite()||referencePrice.lte(0))unboundedBuyReservation=true;
				else buy=buy.plus(remaining.mul(referencePrice).mul(new Decimal(1).plus(order.instrument.takerFee)));
			}
		}
		if(order.side===OrderSide.SELL&&baseCurrency===normalized)sell=sell.plus(remaining);
	}
	return {
		buy,
		sell,
		withdrawals:withdrawals._sum.amount??new Decimal(0),
		unboundedBuyReservation,
	};
}

export function availableWalletAmount(balance:Prisma.Decimal,reservations:WalletReservations){
	if(reservations.unboundedBuyReservation)return new Decimal(0);
	return Decimal.max(new Decimal(0),balance.minus(reservations.buy).minus(reservations.sell).minus(reservations.withdrawals));
}

export function roundWalletAmount(currency:string,amount:Prisma.Decimal){
	const normalized=currency.toUpperCase();
	const precision=normalized==='JPY'?0:
		['USD','EUR','GBP','NGN','CAD','AUD','CHF'].includes(normalized)?2:
		['BTC','ETH'].includes(normalized)?8:10;
	return amount.toDecimalPlaces(precision,Prisma.Decimal.ROUND_HALF_UP);
}
