import {randomBytes} from 'node:crypto';
import {VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {accountContactVerificationCodeMatches,accountContactVerificationConfig,auditContactVerificationFailure,createAccountContactVerificationHash,getContactVerificationDatabaseErrorCode} from '@/lib/account-contact-verification';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {rateLimit} from '@/lib/rate-limit';

const schema=z.object({code:z.string().regex(/^\d{6}$/)});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const {code}=schema.parse(await request.json());
		rateLimit(`account-email-verify-ip:${trustedProxyClientIp(request)||'unknown'}`,30,15*60_000);
		rateLimit(`account-email-verify-user:${user.id}`,20,60*60_000);
		const account=await db.user.findUnique({where:{id:user.id},select:{id:true,email:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const challenge=await db.accountContactVerification.findUnique({
			where:{userId_channel:{userId:user.id,channel:VerificationChannel.EMAIL}},
		});
		if(!challenge||challenge.contact!==account.email){
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'missing_or_stale_challenge');
			return NextResponse.json({error:'Request a new email verification code.'},{status:400});
		}
		if(challenge.verifiedAt){
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'replayed_code');
			return NextResponse.json({error:'This email address is already verified.'},{status:409});
		}
		const now=new Date();
		if(challenge.expiresAt<=now){
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'expired_code');
			return NextResponse.json({error:'This code has expired. Request a new code.'},{status:410});
		}
		if(challenge.attempts>=accountContactVerificationConfig.maxAttempts){
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'attempt_limit');
			return NextResponse.json({error:'Too many attempts. Request a new code.'},{status:429});
		}
		const attempt=await db.accountContactVerification.updateMany({
			where:{
				id:challenge.id,
				userId:user.id,
				channel:VerificationChannel.EMAIL,
				contact:account.email,
				codeHash:challenge.codeHash,
				verifiedAt:null,
				expiresAt:{gt:now},
				attempts:{lt:accountContactVerificationConfig.maxAttempts},
			},
			data:{attempts:{increment:1}},
		});
		if(attempt.count!==1){
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'stale_challenge');
			return NextResponse.json({error:'This code is invalid or no longer available.'},{status:409});
		}
		if(!accountContactVerificationCodeMatches(user.id,VerificationChannel.EMAIL,account.email,code,challenge.codeHash)){
			const current=await db.accountContactVerification.findUnique({
				where:{userId_channel:{userId:user.id,channel:VerificationChannel.EMAIL}},
				select:{attempts:true},
			});
			await auditContactVerificationFailure(user.id,VerificationChannel.EMAIL,'incorrect_code');
			const exhausted=Boolean(current&&current.attempts>=accountContactVerificationConfig.maxAttempts);
			return NextResponse.json({error:exhausted?'Too many attempts. Request a new code.':'The code is incorrect.'},{status:exhausted?429:400});
		}
		await db.$transaction(async tx=>{
			const current=await tx.accountContactVerification.findFirst({
				where:{
					id:challenge.id,
					userId:user.id,
					channel:VerificationChannel.EMAIL,
					contact:account.email,
					codeHash:challenge.codeHash,
					verifiedAt:null,
					expiresAt:{gt:now},
					attempts:{lte:accountContactVerificationConfig.maxAttempts},
				},
				select:{id:true},
			});
			if(!current)throw new Error('CONTACT_VERIFICATION_CONSUMED');
			const consumed=await tx.accountContactVerification.updateMany({
				where:{id:current.id,codeHash:challenge.codeHash,verifiedAt:null},
				data:{
					verifiedAt:now,
					codeHash:createAccountContactVerificationHash(
						user.id,
						VerificationChannel.EMAIL,
						account.email,
						randomBytes(32).toString('hex'),
					),
				},
			});
			if(consumed.count!==1)throw new Error('CONTACT_VERIFICATION_CONSUMED');
			const accountUpdated=await tx.user.updateMany({
				where:{id:user.id,email:account.email,status:'ACTIVE'},
				data:{emailVerifiedAt:now},
			});
			if(accountUpdated.count!==1)throw new Error('CONTACT_VERIFICATION_ACCOUNT_CHANGED');
			await tx.auditLog.create({data:{
				actorId:user.id,
				action:'ACCOUNT_EMAIL_VERIFIED',
				entity:'USER',
				entityId:user.id,
				metadata:{channel:'EMAIL',outcome:'verified'},
			}});
		});
		return NextResponse.json({verified:true,message:'Your email address is verified.'});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter the six-digit verification code.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Verification data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your email address.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification attempts. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='CONTACT_VERIFICATION_CONSUMED')return NextResponse.json({error:'This code is invalid or no longer available.'},{status:409});
		if(error instanceof Error&&error.message==='CONTACT_VERIFICATION_ACCOUNT_CHANGED')return NextResponse.json({error:'Your account details changed. Request a new verification code.'},{status:409});
		const errorCode=getContactVerificationDatabaseErrorCode(error);
		console.error('[account-contact-verification] Email code verification failed.',{errorType:error instanceof Error?error.name:'UnknownError',...(errorCode?{errorCode}:{})});
		if(errorCode)return NextResponse.json({error:'Email verification is unavailable because the application database schema needs an update. Contact support.'},{status:503});
		return NextResponse.json({error:'Unable to verify this email address right now.'},{status:503});
	}
}
