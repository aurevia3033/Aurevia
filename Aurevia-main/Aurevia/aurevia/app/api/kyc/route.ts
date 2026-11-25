import {NextResponse} from 'next/server';
import {AccountMode} from '@prisma/client';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';

export async function GET(){
	try{
		const user=await requireUser();
		const active=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!active||active.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(active.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		const [profile,verification]=await Promise.all([
			db.kycProfile.findUnique({where:{userId:user.id}}),
			db.kycVerification.findFirst({where:{userId:user.id},orderBy:{createdAt:'desc'},select:{id:true,status:true,submittedAt:true,reviewedAt:true,decisionReason:true}}),
		]);
		return NextResponse.json({...(profile??{}),verification},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load identity verification details.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503});
	}
}

export async function POST(){
	try{
		await requireUser();
		return NextResponse.json({error:'Use the Aurevia Verify submission endpoint to submit identity evidence.'},{status:410});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('[kyc] Rejected legacy identity submission.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Use the Aurevia Verify submission endpoint to submit identity evidence.'},{status:410});
	}
}
