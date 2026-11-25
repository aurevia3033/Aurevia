import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {reviewBankOperation} from '@/lib/platform-bank';
import {jsonSafe} from '@/lib/serializers';

type Params={params:Promise<{id:string}>};
const schema=z.object({decision:z.enum(['APPROVE','REJECT'])});

export async function PATCH(request:Request,{params}:Params){
	try{
		const admin=await requireAdmin();
		const {id}=await params;
		const input=schema.parse(await request.json());
		const result=await db.$transaction(tx=>reviewBankOperation(tx,id,admin.id,input.decision),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
		return NextResponse.json(jsonSafe(result),{status:result.replayed?200:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const authStatus=authFailureStatus(error);
		if(authStatus)return NextResponse.json({error:authStatus===401?'Unauthorized':'Forbidden'},{status:authStatus});
		if(error instanceof ZodError)return NextResponse.json({error:'Choose an approval decision.'},{status:400});
		if(error instanceof Error&&error.message==='BANK_OPERATION_NOT_FOUND')return NextResponse.json({error:'Operation not found.'},{status:404});
		if(error instanceof Error&&error.message==='DISTINCT_ADMIN_REQUIRED')return NextResponse.json({error:'A different administrator must review this operation.'},{status:403});
		if(error instanceof Error&&error.message==='ADMIN_ACCOUNT_REQUIRED')return NextResponse.json({error:'An active administrator account is required.'},{status:403});
		if(error instanceof Error&&error.message==='BANK_OPERATION_NOT_PENDING')return NextResponse.json({error:'This operation is no longer awaiting review.'},{status:409});
		if(error instanceof Error&&error.message==='INSUFFICIENT_TREASURY_BALANCE')return NextResponse.json({error:'Treasury available funds are insufficient for this operation.'},{status:409});
		if(error instanceof Error&&error.message==='INSUFFICIENT_WALLET_BALANCE')return NextResponse.json({error:'The customer has insufficient available REAL funds.'},{status:409});
		if(error instanceof Error&&error.message==='CUSTOMER_ACCOUNT_REQUIRED')return NextResponse.json({error:'The operation target account is no longer available.'},{status:409});
		if(error instanceof Error&&error.message==='ACCOUNT_RESTRICTED')return NextResponse.json({error:'The customer account is restricted.'},{status:403});
		if(error instanceof Error&&error.message==='ACCOUNT_NOT_ACTIVE')return NextResponse.json({error:'The customer account is not active.'},{status:409});
		if(error instanceof Error&&['BANK_ACCOUNT_FROZEN','BANK_ACCOUNT_CLOSED'].includes(error.message))return NextResponse.json({error:'The customer bank account is not active.'},{status:409});
		if(error&&typeof error==='object'&&'code'in error&&String(error.code)==='P2034')return NextResponse.json({error:'The operation changed during review. Refresh and retry.'},{status:409});
		console.error('Bank operation review failed.',error&&typeof error==='object'&&'code'in error?String(error.code):error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to review this bank operation.'},{status:503});
	}
}
