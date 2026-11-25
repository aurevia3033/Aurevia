import {Prisma,PrismaClient} from '@prisma/client';
import {getRealWalletReservations} from '@/lib/real-wallet-reservations';

type TransactionClient=PrismaClient|Prisma.TransactionClient;

export function calculateRealWithdrawableBalance(input:{ledgerBalance:Prisma.Decimal|string|number;pendingWithdrawals:Prisma.Decimal|string|number}){
	return Prisma.Decimal.max(0,new Prisma.Decimal(input.ledgerBalance).minus(input.pendingWithdrawals));
}

export async function getRealWithdrawableBalance(tx:TransactionClient,userId:string,ledgerBalance:Prisma.Decimal,excludePendingRequestId?:string){
	const reservations=await getRealWalletReservations(tx,userId,'USD',undefined,excludePendingRequestId);
	if(reservations.unboundedBuyReservation)return new Prisma.Decimal(0);
	return calculateRealWithdrawableBalance({
		ledgerBalance:new Prisma.Decimal(ledgerBalance).minus(reservations.buy).minus(reservations.sell),
		pendingWithdrawals:reservations.withdrawals,
	});
}
