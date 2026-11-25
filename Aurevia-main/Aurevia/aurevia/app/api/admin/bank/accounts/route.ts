import {AccountMode,Prisma,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureBankAccount} from '@/lib/platform-bank';
import {ensureUserLedger} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';

const schema=z.object({userId:z.string().min(1)});

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		const input=schema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const customer=await tx.user.findUnique({where:{id:input.userId},select:{id:true,role:true,status:true}});
			if(!customer||customer.role!=='USER')throw new Error('CUSTOMER_ACCOUNT_REQUIRED');
			if(customer.status!==UserStatus.ACTIVE)throw new Error('ACCOUNT_NOT_ACTIVE');
			const [account]=await Promise.all([
				ensureBankAccount(tx,customer.id),
				ensureUserLedger(tx,customer.id,AccountMode.REAL,'USD'),
			]);
			await tx.auditLog.create({data:{actorId:admin.id,action:'BANK_ACCOUNT_PROVISIONED',entity:'BANK_ACCOUNT',entityId:account.id,metadata:{userId:customer.id,accountIdentifier:account.accountIdentifier,idempotent:true,accountMode:AccountMode.REAL}}});
			return account;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(jsonSafe(result),{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		if(error instanceof ZodError)return NextResponse.json({error:'Select an existing customer.'},{status:400});
		if(error instanceof Error&&error.message==='CUSTOMER_ACCOUNT_REQUIRED')return NextResponse.json({error:'Select an existing customer account.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_ACTIVE')return NextResponse.json({error:'Only active customer accounts can be opened.'},{status:409});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The account changed while it was being opened. Retry the request.'},{status:409});
		console.error('Bank account provisioning failed.',error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to open the REAL customer account.'},{status:503});
	}
}
