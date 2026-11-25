import {BankAccountStatus,NotificationType,Prisma,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureBankAccount} from '@/lib/platform-bank';
import {createNotification} from '@/lib/notifications';
import {jsonSafe} from '@/lib/serializers';

type Params={params:Promise<{userId:string}>};
const schema=z.object({action:z.enum(['FREEZE','UNFREEZE']),reason:z.string().trim().min(3).max(300)});

export async function PATCH(request:Request,{params}:Params){
	try{
		const admin=await requireAdmin();
		const {userId}=await params;
		const input=schema.parse(await request.json());
		const account=await db.$transaction(async tx=>{
			const customer=await tx.user.findUnique({where:{id:userId},select:{id:true,role:true,status:true}});
			if(!customer||customer.role!=='USER')throw new Error('CUSTOMER_ACCOUNT_REQUIRED');
			if(customer.status!==UserStatus.ACTIVE)throw new Error('ACCOUNT_NOT_ACTIVE');
			const existing=await ensureBankAccount(tx,customer.id);
			if(existing.status===BankAccountStatus.CLOSED)throw new Error('BANK_ACCOUNT_CLOSED');
			const status=input.action==='FREEZE'?BankAccountStatus.FROZEN:BankAccountStatus.ACTIVE;
			if(existing.status===status)return existing;
			const updated=await tx.bankAccount.update({where:{id:existing.id},data:{
				status,
				frozenAt:status===BankAccountStatus.FROZEN?new Date():null,
				frozenById:status===BankAccountStatus.FROZEN?admin.id:null,
				statusReason:status===BankAccountStatus.FROZEN?input.reason:null,
			}});
			await tx.auditLog.create({data:{actorId:admin.id,action:status===BankAccountStatus.FROZEN?'BANK_ACCOUNT_FROZEN':'BANK_ACCOUNT_UNFROZEN',entity:'BANK_ACCOUNT',entityId:updated.id,metadata:{userId:customer.id,accountIdentifier:updated.accountIdentifier,reason:input.reason}}});
			await createNotification(tx,{userId:customer.id,type:NotificationType.ACCOUNT,title:status===BankAccountStatus.FROZEN?'REAL bank account frozen':'REAL bank account reactivated',message:status===BankAccountStatus.FROZEN?'Your Aurevia internal REAL account has been frozen. Contact support for assistance.':'Your Aurevia internal REAL account is active again.',dedupeKey:`bank-account:${updated.id}:${status.toLowerCase()}:${updated.updatedAt.toISOString()}`,relatedEntity:'BANK_ACCOUNT',relatedId:updated.id,actionUrl:'/bank'});
			return updated;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(account),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		if(error instanceof ZodError)return NextResponse.json({error:'Choose an account action and provide a reason.'},{status:400});
		if(error instanceof Error&&error.message==='CUSTOMER_ACCOUNT_REQUIRED')return NextResponse.json({error:'Select an existing customer account.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_ACTIVE')return NextResponse.json({error:'Only active customer accounts can be managed.'},{status:409});
		if(error instanceof Error&&error.message==='BANK_ACCOUNT_CLOSED')return NextResponse.json({error:'Closed bank accounts cannot be reactivated.'},{status:409});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed during this action. Refresh and try again.'},{status:409});
		console.error('Bank account status update failed.',error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to update the bank account.'},{status:503});
	}
}
