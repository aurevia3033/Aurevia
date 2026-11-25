import {AccountMode,BankOperationDirection,BankOperationStatus,BankOperationType,EntryType,FundingStatus,FundingType,Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {createBankOperationRequest,getTreasuryAvailable} from '@/lib/platform-bank';
import {calculateRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {LEGACY_EXTERNAL_PROVIDER,paperOrderCollateral} from '@/lib/bitcoin-funding';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';
import {jsonSafe} from '@/lib/serializers';

const requestSchema=z.object({
	type:z.nativeEnum(BankOperationType),
	direction:z.enum(['INCREASE','DECREASE']).optional(),
	userId:z.string().min(1).optional(),
	amount:z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/),
	currency:z.enum(SUPPORTED_CURRENCIES),
	sourceClassification:z.string().trim().regex(/^[A-Za-z0-9_]{2,64}$/),
	reason:z.string().trim().min(3).max(300),
	idempotencyKey:z.string().uuid(),
});
const operationTypeSchema=z.nativeEnum(BankOperationType);

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=new URL(request.url).searchParams;
		const search=params.get('search')?.trim().slice(0,120)||'';
		const activitySearch=params.get('activitySearch')?.trim().slice(0,120)||'';
		const parsedType=operationTypeSchema.safeParse(params.get('type'));
		if(params.has('type')&&!parsedType.success)return NextResponse.json({error:'Invalid operation type filter.'},{status:400});
		const parsedDirection=z.nativeEnum(BankOperationDirection).safeParse(params.get('direction'));
		if(params.has('direction')&&!parsedDirection.success)return NextResponse.json({error:'Invalid operation direction filter.'},{status:400});
		const fromValue=params.get('from');
		const toValue=params.get('to');
		const from=fromValue?new Date(fromValue):null;
		const to=toValue?new Date(toValue):null;
		if(to&&/^\d{4}-\d{2}-\d{2}$/.test(toValue||''))to.setUTCHours(23,59,59,999);
		if((from&&!Number.isFinite(from.getTime()))||(to&&!Number.isFinite(to.getTime()))||(from&&to&&from>to))return NextResponse.json({error:'Invalid operation date range.'},{status:400});
		const administratorId=params.get('administratorId')?.trim().slice(0,120)||'';
		const activityWhere:Prisma.BankOperationWhereInput={
			status:{in:[BankOperationStatus.POSTED,BankOperationStatus.REJECTED]},
			...(parsedType.success&&parsedType.data?{type:parsedType.data}:{}),
			...(parsedType.success&&parsedType.data===BankOperationType.TREASURY_ADJUSTMENT&&parsedDirection.success?{direction:parsedDirection.data}:{}),
			...(administratorId?{OR:[{initiatedById:administratorId},{reviewedById:administratorId}]}:{}),
			...(from||to?{createdAt:{...(from?{gte:from}:{}),...(to?{lte:to}:{})}}:{}),
			...(activitySearch?{AND:[{OR:[
				{reference:{contains:activitySearch,mode:'insensitive'}},
				{sourceClassification:{contains:activitySearch,mode:'insensitive'}},
				{reason:{contains:activitySearch,mode:'insensitive'}},
				{user:{is:{email:{contains:activitySearch,mode:'insensitive'}}}},
			]}]}:{}),
		};
		const where=search?{
			OR:[
				{accountIdentifier:{contains:search,mode:'insensitive' as const}},
				{user:{is:{id:{contains:search,mode:'insensitive' as const}}}},
				{user:{is:{email:{contains:search,mode:'insensitive' as const}}}},
				{user:{is:{name:{contains:search,mode:'insensitive' as const}}}},
			],
		}:{};
		const [accounts,pendingOperations,recentOperations,treasuryAvailable,postedOperationGroups]=await Promise.all([
			db.bankAccount.findMany({where,orderBy:{createdAt:'desc'},take:30,include:{user:{select:{id:true,name:true,email:true,status:true}}}}),
			db.bankOperation.findMany({where:{status:BankOperationStatus.PENDING,...(parsedType.success&&parsedType.data?{type:parsedType.data}:{})},orderBy:{createdAt:'asc'},take:50,include:{user:{select:{id:true,name:true,email:true}},initiatedBy:{select:{id:true,name:true,email:true}}}}),
			db.bankOperation.findMany({where:activityWhere,orderBy:{reviewedAt:'desc'},take:100,include:{user:{select:{id:true,name:true,email:true}},initiatedBy:{select:{name:true,email:true}},reviewedBy:{select:{name:true,email:true}}}}),
			getTreasuryAvailable(db,'USD'),
			db.bankOperation.groupBy({by:['type','direction'],where:{status:BankOperationStatus.POSTED,currency:'USD'},_sum:{amount:true}}),
		]);
		const operationTotal=(type:BankOperationType,direction?:'INCREASE'|'DECREASE')=>postedOperationGroups
			.filter(row=>row.type===type&&(direction===undefined||row.direction===direction))
			.reduce((sum,row)=>sum.plus(row._sum.amount??0),new Prisma.Decimal(0));
		const funding=operationTotal(BankOperationType.TREASURY_FUNDING);
		const adjustmentsIn=operationTotal(BankOperationType.TREASURY_ADJUSTMENT,'INCREASE');
		const adjustmentsOut=operationTotal(BankOperationType.TREASURY_ADJUSTMENT,'DECREASE');
		const walletCredits=operationTotal(BankOperationType.WALLET_CREDIT);
		const walletDebits=operationTotal(BankOperationType.WALLET_DEBIT);
		const calculatedTreasury=funding.plus(adjustmentsIn).minus(adjustmentsOut).minus(walletCredits).plus(walletDebits);
		const reconciliationDifference=treasuryAvailable.minus(calculatedTreasury);
		const userIds=accounts.map(account=>account.userId);
		const ledgerAccounts=userIds.length?await db.ledgerAccount.findMany({where:{userId:{in:userIds},code:{in:userIds.map(userId=>`USER:${userId}:${AccountMode.REAL}:USD`)},accountMode:AccountMode.REAL,currency:'USD'},select:{id:true,userId:true,startingBalance:true}}):[];
		const ledgerAccountIds=ledgerAccounts.map(account=>account.id);
		const [entries,withdrawals,paperOrders]=await Promise.all([
			ledgerAccountIds.length?db.ledgerEntry.groupBy({by:['accountId','type'],where:{accountId:{in:ledgerAccountIds}},_sum:{amount:true}}):Promise.resolve([]),
			userIds.length?db.fundingRequest.groupBy({by:['userId'],where:{userId:{in:userIds},accountMode:AccountMode.REAL,currency:'USD',type:FundingType.WITHDRAWAL,status:{in:[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.APPROVED,FundingStatus.PROCESSING]}},_sum:{amount:true}}):Promise.resolve([]),
			userIds.length?db.order.findMany({where:{userId:{in:userIds},accountMode:AccountMode.REAL,providerName:LEGACY_EXTERNAL_PROVIDER},select:{userId:true,instrumentId:true,side:true,quantity:true,filledQuantity:true,averageFillPrice:true,providerReservedAmount:true,status:true,createdAt:true},orderBy:{createdAt:'asc'}}):Promise.resolve([]),
		]);
		const accountByUser=new Map(ledgerAccounts.map(account=>[account.userId,account]));
		const withdrawalsByUser=new Map(withdrawals.map(row=>[row.userId,row._sum.amount??new Prisma.Decimal(0)]));
		const ordersByUser=new Map<string,typeof paperOrders>();
		for(const order of paperOrders){const grouped=ordersByUser.get(order.userId)||[];grouped.push(order);ordersByUser.set(order.userId,grouped)}
		const bankAccounts=accounts.map(account=>{
			const ledgerAccount=accountByUser.get(account.userId);
			const ledgerEntries=entries.filter(entry=>entry.accountId===ledgerAccount?.id);
			const credits=ledgerEntries.find(entry=>entry.type===EntryType.CREDIT)?._sum.amount??new Prisma.Decimal(0);
			const debits=ledgerEntries.find(entry=>entry.type===EntryType.DEBIT)?._sum.amount??new Prisma.Decimal(0);
			const ledgerBalance=(ledgerAccount?.startingBalance??new Prisma.Decimal(0)).plus(credits).minus(debits);
			const committed=paperOrderCollateral((ordersByUser.get(account.userId)||[]).map(order=>({...order,takerFee:new Prisma.Decimal(0)}))).committed;
			const available=calculateRealWithdrawableBalance({ledgerBalance:ledgerBalance.minus(committed),pendingWithdrawals:withdrawalsByUser.get(account.userId)??0});
			return {...account,ledgerBalance,available,reserved:ledgerBalance.minus(available)};
		});
		return NextResponse.json(jsonSafe({treasury:{currency:'USD',available:treasuryAvailable,allocatedFunds:walletCredits.minus(walletDebits),internalOnly:true,externalFundsVerified:false,reconciliation:{calculatedBalance:calculatedTreasury,difference:reconciliationDifference,balanced:reconciliationDifference.isZero()}},accounts:bankAccounts,pendingOperations,recentOperations}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		console.error('Admin bank data unavailable.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Bank administration data is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		const input=requestSchema.parse(await request.json());
		const result=await db.$transaction(tx=>createBankOperationRequest(tx,{...input,initiatedById:admin.id}),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		const terminal=result.operation.status!==BankOperationStatus.PENDING;
		return NextResponse.json(jsonSafe(result.operation),{status:result.replayed||terminal?200:202,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid operation, account, amount, source, reason, and unique request key.'},{status:400});
		if(error instanceof Error&&error.message==='IDEMPOTENCY_KEY_REUSED')return NextResponse.json({error:'This request key has already been used for a different operation.'},{status:409});
		if(error instanceof Error&&error.message==='ADMIN_ACCOUNT_REQUIRED')return NextResponse.json({error:'An active administrator account is required.'},{status:403});
		if(error instanceof Error&&error.message==='CUSTOMER_ACCOUNT_REQUIRED')return NextResponse.json({error:'Select an existing customer account.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_ACTIVE')return NextResponse.json({error:'Only active customer accounts can be adjusted.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_RESTRICTED')return NextResponse.json({error:'This customer account is restricted.'},{status:403});
		if(error instanceof Error&&['BANK_ACCOUNT_FROZEN','BANK_ACCOUNT_CLOSED'].includes(error.message))return NextResponse.json({error:'The customer bank account is not active.'},{status:409});
		if(error instanceof Error&&['INVALID_AMOUNT','INVALID_CURRENCY','INVALID_OPERATION_DIRECTION','INVALID_OPERATION_TARGET','INVALID_SOURCE_CLASSIFICATION','INVALID_REASON'].includes(error.message))return NextResponse.json({error:'The bank operation details are invalid.'},{status:400});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed while the request was recorded. Retry with the same request key.'},{status:409});
		console.error('Admin bank operation request failed.',error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to submit the bank operation for approval.'},{status:503});
	}
}
