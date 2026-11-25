import {createHash,randomUUID} from 'node:crypto';
import {getCountries} from 'libphonenumber-js';
import {VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {formatSmsProviderReference,generateVerificationCode,getConfiguredSmsVerificationProvider,TermiiSmsDeliveryError} from '@/lib/verification-delivery';
import {normalizePhoneE164} from '@/lib/registration-validation';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {rateLimit} from '@/lib/rate-limit';
import {
	AccountContactVerificationError,
	accountContactVerificationConfig,
	createAccountContactVerificationHash,
	createAccountContactVerificationReservation,
	finalizeAccountContactVerificationReservation,
	getContactVerificationDatabaseErrorCode,
	reserveAccountContactVerification,
	restoreAccountContactVerificationReservation,
} from '@/lib/account-contact-verification';

const schema=z.object({
	phone:z.string().trim().min(1).max(64),
	countryCode:z.string().min(2).max(2),
});

function providerFailureDetails(error:unknown){
	if(error instanceof TermiiSmsDeliveryError)return {
		provider:'termii',
		failureStage:error.failureStage,
		httpStatus:error.httpStatus,
		providerCode:error.providerCode,
		errorType:error.underlyingErrorType||error.name,
	};
	return {provider:'unknown',failureStage:'unclassified',httpStatus:null,errorType:error instanceof Error?error.name:'UnknownError'};
}

export async function POST(request:Request){
	const requestId=randomUUID();
	let reservation:Awaited<ReturnType<typeof reserveAccountContactVerification>>|null=null;
	try{
		const user=await requireUser();
		const input=schema.parse(await request.json());
		const countryCode=getCountries().find(country=>country===input.countryCode.toUpperCase());
		const phone=countryCode?normalizePhoneE164(input.phone,countryCode):null;
		if(!phone)return NextResponse.json({error:'Enter a valid phone number for the selected country.'},{status:400});
		const provider=getConfiguredSmsVerificationProvider();
		if(!provider)return NextResponse.json({error:'Phone verification is not configured for this service. No code was sent.'},{status:503});
		const account=await db.user.findUnique({where:{id:user.id},select:{id:true,phone:true,phoneVerified:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(account.phone===phone&&account.phoneVerified)return NextResponse.json({error:'This phone number is already verified.'},{status:409});
		const duplicate=await db.user.findFirst({where:{phone,id:{not:user.id}},select:{id:true}});
		if(duplicate)return NextResponse.json({error:'This phone number cannot be used. Choose another number or contact support.'},{status:409});
		const ip=trustedProxyClientIp(request)||'unknown';
		rateLimit(`account-phone-verification-ip:${ip}`,10,60*60_000);
		rateLimit(`account-phone-verification-user:${user.id}`,5,60*60_000);
		rateLimit(`account-phone-verification-target:${createHash('sha256').update(phone).digest('hex')}`,3,60*60_000);
		const now=new Date();
		const reservationToken=createAccountContactVerificationReservation();
		const reservationHash=createAccountContactVerificationHash(
			user.id,VerificationChannel.SMS,phone,reservationToken,
		);
		reservation=await reserveAccountContactVerification({
			userId:user.id,
			channel:VerificationChannel.SMS,
			contact:phone,
			accountContactAtRequest:account.phone,
			codeHash:reservationHash,
			now,
		});
		let providerReference:string;
		const code=generateVerificationCode();
		const verificationCodeHash=createAccountContactVerificationHash(user.id,VerificationChannel.SMS,phone,code);
		const expiresAt=reservation.expiresAt;
		try{
			providerReference=formatSmsProviderReference(provider,await provider.send(phone,code));
		}catch(error){
			await restoreAccountContactVerificationReservation(reservation);
			reservation=null;
			console.error('[account-contact-verification] Phone code delivery failed.',{
				requestId,
				...providerFailureDetails(error),
			});
			return NextResponse.json({error:'We could not start phone verification. Check the number and try again.'},{status:502});
		}
		await finalizeAccountContactVerificationReservation({
			id:reservation.id,
			codeHash:reservation.codeHash,
			verificationCodeHash,
			providerReference,
			expiresAt,
		});
		reservation=null;
		await db.auditLog.create({data:{
			actorId:user.id,
			action:'ACCOUNT_PHONE_VERIFICATION_CODE_SENT',
			entity:'USER',
			entityId:user.id,
			metadata:{channel:'SMS',provider:provider.id,outcome:'accepted'},
		}});
		return NextResponse.json({
			message:'A verification code was requested. It should arrive shortly.',
			provider:provider.id.toUpperCase(),
			expiresAt,
			resendAfterSeconds:Math.ceil(accountContactVerificationConfig.resendCooldownMs/1000),
		});
	}catch(error){
		if(reservation)await restoreAccountContactVerificationReservation(reservation);
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid phone number and country.'},{status:400});
		if(error instanceof AccountContactVerificationError){
			if(error.code==='ALREADY_VERIFIED')return NextResponse.json({error:'This phone number is already verified.'},{status:409});
			if(error.code==='RESEND_COOLDOWN')return NextResponse.json({error:'Please wait before requesting another code.'},{status:429});
		}
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your phone number.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many code requests. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_SECRET_UNAVAILABLE')return NextResponse.json({error:'Phone verification is temporarily unavailable.'},{status:503});
		const errorCode=getContactVerificationDatabaseErrorCode(error);
		console.error('[account-contact-verification] Phone code request failed.',{requestId,errorType:error instanceof Error?error.name:'UnknownError',...(errorCode?{errorCode}:{})});
		if(errorCode)return NextResponse.json({error:'Phone verification is unavailable because the application database schema needs an update. Contact support.'},{status:503});
		return NextResponse.json({error:'Phone verification is temporarily unavailable.'},{status:503});
	}
}
