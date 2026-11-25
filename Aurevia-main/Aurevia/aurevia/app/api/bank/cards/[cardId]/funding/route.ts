import {AccountMode,BankAccountStatus,EntryType,NotificationType,Prisma,SimulatedCardStatus,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,ensureUserLedger,postDoubleEntry,roundUsdAmount} from '@/lib/ledger';
import {ensureBankAccount} from '@/lib/platform-bank';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {createNotification} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';
import {rateLimit} from '@/lib/rate-limit';

type Params={params:Promise<{cardId:string}>};
const schema=z.object({
	amount:z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/),
	idempotencyKey:z.string().uuid(),
});

export async function POST(request:Request,{params}:Params){
	try{
		const user=await requireUser();
		const {cardId}=await params;
		const input=schema.parse(await request.json());
		const amount=roundUsdAmount(input.amount);
		if(amount.lt(1))return NextResponse.json({error:'Enter at least 1.00 USD.'},{status:400});
		rateLimit(`bank-card-funding:${user.id}`,10,60*60_000);
		const result=await db.$transaction(async tx=>{
			const profile=await tx.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true,accountRestricted:true}});
			if(!profile||profile.status!==UserStatus.ACTIVE||profile.role!=='USER')throw new Error('ACCOUNT_UNAVAILABLE');
			if(profile.accountMode!==AccountMode.REAL)throw new Error('REAL_MODE_REQUIRED');
			if(profile.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
			const card=await tx.simulatedCard.findFirst({where:{id:cardId,userId:user.id},select:{id:true,referenceNumber:true,status:true}});
			if(!card)throw new Error('CARD_NOT_FOUND');
			if(card.status!==SimulatedCardStatus.ACTIVE)throw new Error('CARD_NOT_ACTIVE');
			const bankAccount=await ensureBankAccount(tx,user.id);
			if(bankAccount.status!==BankAccountStatus.ACTIVE)throw new Error(bankAccount.status===BankAccountStatus.FROZEN?'BANK_ACCOUNT_FROZEN':'BANK_ACCOUNT_CLOSED');
			const wallet=await ensureUserLedger(tx,user.id,AccountMode.REAL,'USD');
			const cardLedger=await tx.ledgerAccount.upsert({
				where:{code:`CARD:${card.id}:REAL:USD`},
				update:{},
				create:{userId:user.id,accountMode:AccountMode.REAL,code:`CARD:${card.id}:REAL:USD`,name:`Aurevia internal card ${card.referenceNumber}`,currency:'USD'},
			});
			const reference=`CARD:TOPUP:${card.id}:${input.idempotencyKey}`;
			const prior=await tx.ledgerTransaction.findUnique({where:{reference},include:{entries:true}});
			if(prior){
				if(prior.accountMode!==AccountMode.REAL||prior.entries.length!==2||!prior.entries.some(entry=>entry.accountId===wallet.id&&entry.type===EntryType.DEBIT&&entry.amount.eq(amount))||!prior.entries.some(entry=>entry.accountId===cardLedger.id&&entry.type===EntryType.CREDIT&&entry.amount.eq(amount)))throw new Error('IDEMPOTENCY_KEY_REUSED');
				return {reference,transactionId:prior.id,cardBalance:await balance(tx,cardLedger.id,'USD'),replayed:true};
			}
			const walletBalance=await balance(tx,wallet.id,'USD');
			const available=await getRealWithdrawableBalance(tx,user.id,walletBalance);
			if(available.lt(amount))throw new Error('INSUFFICIENT_WALLET_BALANCE');
			await postDoubleEntry(tx,{
				reference,
				description:`Internal card balance transfer · ${card.referenceNumber}`,
				debitAccountId:wallet.id,
				creditAccountId:cardLedger.id,
				amount,
			});
			const transaction=await tx.ledgerTransaction.findUniqueOrThrow({where:{reference},select:{id:true}});
			const cardBalance=await balance(tx,cardLedger.id,'USD');
			await tx.auditLog.create({data:{actorId:user.id,action:'BANK_CARD_BALANCE_TRANSFER',entity:'LEDGER_TRANSACTION',entityId:transaction.id,metadata:{cardId:card.id,cardReference:card.referenceNumber,amount:amount.toString(),currency:'USD',reference,feeAmount:'0.00',internalLedgerOnly:true,externalCardNetworkAvailable:false}}});
			await createNotification(tx,{
				userId:user.id,
				type:NotificationType.CARD,
				title:'Internal card balance updated',
				message:`${amount.toFixed(2)} USD was transferred from your REAL wallet to your Aurevia card balance. This balance is internal-only and cannot be spent on external card networks. Reference: ${reference}.`,
				dedupeKey:`${reference}:notification`,
				relatedEntity:'LEDGER_TRANSACTION',
				relatedId:transaction.id,
				actionUrl:'/bank',
			});
			return {reference,transactionId:transaction.id,cardBalance,replayed:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
		return NextResponse.json(jsonSafe(result),{status:result.replayed?200:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid card funding amount and request key.'},{status:400});
		if(error instanceof Error&&error.message==='REAL_MODE_REQUIRED')return NextResponse.json({error:'Card balances are available in REAL mode only.'},{status:403});
		if(error instanceof Error&&['ACCOUNT_UNAVAILABLE','ACCOUNT_RESTRICTED','BANK_ACCOUNT_FROZEN','BANK_ACCOUNT_CLOSED'].includes(error.message))return NextResponse.json({error:'This account is not eligible for card funding.'},{status:403});
		if(error instanceof Error&&error.message==='CARD_NOT_FOUND')return NextResponse.json({error:'Select a card belonging to your account.'},{status:404});
		if(error instanceof Error&&error.message==='CARD_NOT_ACTIVE')return NextResponse.json({error:'Only active cards can receive funds.'},{status:409});
		if(error instanceof Error&&error.message==='INSUFFICIENT_WALLET_BALANCE')return NextResponse.json({error:'Insufficient available REAL wallet funds.'},{status:409});
		if(error instanceof Error&&error.message==='IDEMPOTENCY_KEY_REUSED')return NextResponse.json({error:'This request key has already been used for a different card transfer.'},{status:409});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many card funding requests. Try again later.'},{status:429});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed during this transfer. Retry with the same request key.'},{status:409});
		console.error('Internal card balance transfer failed.',error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to complete the card balance transfer.'},{status:503});
	}
}
