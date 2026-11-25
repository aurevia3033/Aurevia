import {VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {
	accountContactVerificationConfig,
	auditContactVerificationFailure,
	accountContactVerificationCodeMatches,
	getContactVerificationDatabaseErrorCode,
} from '@/lib/account-contact-verification';
import {resolveSmsProviderReference,TermiiProviderError} from '@/lib/verification-delivery';
import {confirmSettingsPhoneVerification} from '@/lib/settings-phone-verification';

const schema=z.object({code:z.string().regex(/^\d{6}$/)});

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const {code}=schema.parse(await request.json());
		rateLimit(`account-phone-verify-ip:${trustedProxyClientIp(request)||'unknown'}`,30,15*60_000);
		rateLimit(`account-phone-verify-user:${user.id}`,20,60*60_000);
		const account=await db.user.findUnique({where:{id:user.id},select:{id:true,phone:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const challenge=await db.accountContactVerification.findUnique({
			where:{userId_channel:{userId:user.id,channel:VerificationChannel.SMS}},
		});
		if(!challenge){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'missing_challenge');
			return NextResponse.json({error:'Request a new phone verification code.'},{status:400});
		}
		if(challenge.verifiedAt){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'replayed_code');
			return NextResponse.json({error:'This phone number is already verified.'},{status:409});
		}
		if(challenge.accountContactAtRequest!==account.phone){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'stale_account_contact');
			return NextResponse.json({error:'This verification request is no longer current. Request a new code.'},{status:409});
		}
		if(!challenge.providerReference){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'missing_provider_reference');
			return NextResponse.json({error:'Request a new phone verification code.'},{status:400});
		}
		const smsChallenge=resolveSmsProviderReference(challenge.providerReference);
		if(!smsChallenge){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'unsupported_provider_reference');
			return NextResponse.json({error:'This legacy phone verification request is no longer active. Request a new code.'},{status:409});
		}
		const now=new Date();
		if(challenge.expiresAt<=now){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'expired_code');
			return NextResponse.json({error:'This code has expired. Request a new code.'},{status:410});
		}
		if(challenge.attempts>=accountContactVerificationConfig.maxAttempts){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'attempt_limit');
			return NextResponse.json({error:'Too many attempts. Request a new code.'},{status:429});
		}
		const attempt=await db.accountContactVerification.updateMany({
			where:{
				id:challenge.id,
				userId:user.id,
				channel:VerificationChannel.SMS,
				contact:challenge.contact,
				accountContactAtRequest:account.phone,
				codeHash:challenge.codeHash,
				providerReference:challenge.providerReference,
				verifiedAt:null,
				expiresAt:{gt:now},
				attempts:{lt:accountContactVerificationConfig.maxAttempts},
			},
			data:{attempts:{increment:1}},
		});
		if(attempt.count!==1){
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'stale_challenge');
			return NextResponse.json({error:'This code is invalid or no longer available.'},{status:409});
		}
		let verified:boolean;
		if(!smsChallenge.provider.verify){
			verified=accountContactVerificationCodeMatches(
				user.id,VerificationChannel.SMS,challenge.contact,code,challenge.codeHash,
			);
		}else{
			try{
				verified=await smsChallenge.provider.verify!(smsChallenge.reference,code);
			}catch(error){
				await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'provider_check_failed',smsChallenge.provider.id);
				console.error('[account-contact-verification] Phone provider check failed.',{
					userId:user.id,
					provider:smsChallenge.provider.id,
					failureStage:error instanceof TermiiProviderError?error.failureStage:'unclassified',
					httpStatus:error instanceof TermiiProviderError?error.httpStatus:null,
					errorType:error instanceof Error?error.name:'UnknownError',
				});
				return NextResponse.json({error:'Phone verification is temporarily unavailable. Try again later.'},{status:503});
			}
		}
		if(!verified){
			const current=await db.accountContactVerification.findUnique({
				where:{userId_channel:{userId:user.id,channel:VerificationChannel.SMS}},
				select:{attempts:true},
			});
			await auditContactVerificationFailure(user.id,VerificationChannel.SMS,'incorrect_code',smsChallenge.provider.id);
			const exhausted=Boolean(current&&current.attempts>=accountContactVerificationConfig.maxAttempts);
			return NextResponse.json({error:exhausted?'Too many attempts. Request a new code.':'The code is incorrect.'},{status:exhausted?429:400});
		}
		const result=await confirmSettingsPhoneVerification({
			userId:user.id,
			challengeId:challenge.id,
			codeHash:challenge.codeHash,
			providerReference:challenge.providerReference,
			provider:smsChallenge.provider.id,
		});
		if(result==='phone_conflict')return NextResponse.json({error:'This phone number cannot be used. Choose another number or contact support.'},{status:409});
		if(result!=='verified')return NextResponse.json({error:'This verification request is no longer current. Request a new code.'},{status:409});
		return NextResponse.json({verified:true,message:'Your phone number is verified.'});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter the six-digit verification code.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Verification data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your phone number.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification attempts. Try again later.'},{status:429});
		const errorCode=getContactVerificationDatabaseErrorCode(error);
		console.error('[account-contact-verification] Phone code verification failed.',{errorType:error instanceof Error?error.name:'UnknownError',...(errorCode?{errorCode}:{})});
		if(errorCode)return NextResponse.json({error:'Phone verification is unavailable because the application database schema needs an update. Contact support.'},{status:503});
		return NextResponse.json({error:'Unable to verify this phone number right now.'},{status:503});
	}
}
