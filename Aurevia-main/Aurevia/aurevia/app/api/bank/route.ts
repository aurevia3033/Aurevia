import {AccountMode,Prisma,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {authFailureStatus,requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureUserLedger} from '@/lib/ledger';
import {ensureBankAccount} from '@/lib/platform-bank';
import {jsonSafe} from '@/lib/serializers';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';

export const dynamic='force-dynamic';

export async function GET(){
	try{
		const user=await requireUser();
		const profile=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true,accountRestricted:true}});
		if(!profile||profile.status!==UserStatus.ACTIVE||profile.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(profile.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Aurevia Bank is available in REAL mode only.'},{status:403});

		const result=await db.$transaction(async tx=>{
			const [account,ledgerAccount,cards]=await Promise.all([
				ensureBankAccount(tx,user.id),
				ensureUserLedger(tx,user.id,AccountMode.REAL,'USD'),
				tx.simulatedCard.findMany({where:{userId:user.id},orderBy:{issuedAt:'desc'},select:{id:true,displayName:true,cardholderName:true,referenceNumber:true,status:true,designTier:true}}),
			]);
			const ledgerBalance=await balance(tx,ledgerAccount.id,'USD');
			const [available,entries,cardBalances]=await Promise.all([
				getRealWithdrawableBalance(tx,user.id,ledgerBalance),
				tx.ledgerEntry.groupBy({by:['type'],where:{accountId:ledgerAccount.id},_sum:{amount:true}}),
				Promise.all(cards.map(async card=>{
					const cardLedger=await tx.ledgerAccount.upsert({
						where:{code:`CARD:${card.id}:REAL:USD`},
						update:{},
						create:{userId:user.id,accountMode:AccountMode.REAL,code:`CARD:${card.id}:REAL:USD`,name:`Aurevia internal card ${card.referenceNumber}`,currency:'USD'},
					});
					return {cardId:card.id,balance:await balance(tx,cardLedger.id,'USD')};
				})),
			]);
			const totalCredited=entries.find(entry=>entry.type==='CREDIT')?._sum.amount??new Prisma.Decimal(0);
			const totalDebited=entries.find(entry=>entry.type==='DEBIT')?._sum.amount??new Prisma.Decimal(0);
			const balancesByCard=new Map(cardBalances.map(item=>[item.cardId,item.balance]));
			return {
				account,
				accountStatus:account.status,
				currency:'USD',
				ledgerBalance,
				available,
				reserved:ledgerBalance.minus(available),
				totalCredited,
				totalDebited,
				accountRestricted:profile.accountRestricted,
				cards:cards.map(card=>({...card,balance:balancesByCard.get(card.id)??new Prisma.Decimal(0)})),
			};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(result),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		console.error('Aurevia Bank summary unavailable.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Aurevia Bank is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
