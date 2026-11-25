import {randomInt,randomUUID,createHash} from 'node:crypto';
import {VerificationChannel} from '@prisma/client';
import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {isEmailDeliveryAvailable,sendEmail} from '@/lib/email';
import {renderAureviaEmail} from '@/lib/email-template';
import {trustedProxyClientIp} from '@/lib/request-ip';
import {rateLimit} from '@/lib/rate-limit';
import {
	AccountContactVerificationError,
	accountContactVerificationConfig,
	createAccountContactVerificationHash,
	reserveAccountContactVerification,
	restoreAccountContactVerificationReservation,
	getContactVerificationDatabaseErrorCode,
} from '@/lib/account-contact-verification';

export async function POST(request:Request){
	const requestId=randomUUID();
	let reservation:Awaited<ReturnType<typeof reserveAccountContactVerification>>|null=null;
	try{
		const user=await requireUser();
		const account=await db.user.findUnique({where:{id:user.id},select:{id:true,email:true,emailVerifiedAt:true,status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(account.emailVerifiedAt)return NextResponse.json({error:'This email address is already verified.'},{status:409});
		if(!isEmailDeliveryAvailable())return NextResponse.json({error:'Email verification is not configured. Contact support.'},{status:503});
		const now=new Date();
		rateLimit(`account-email-verification-ip:${trustedProxyClientIp(request)||'unknown'}`,10,60*60_000);
		rateLimit(`account-email-verification-user:${user.id}`,5,60*60_000);
		rateLimit(`account-email-verification-target:${createHash('sha256').update(account.email.toLowerCase()).digest('hex')}`,3,60*60_000);
		const code=randomInt(100000,1000000).toString();
		const codeHash=createAccountContactVerificationHash(user.id,VerificationChannel.EMAIL,account.email,code);
		reservation=await reserveAccountContactVerification({
			userId:user.id,
			channel:VerificationChannel.EMAIL,
			contact:account.email,
			accountContactAtRequest:account.email,
			codeHash,
			now,
		});
		const delivery=await sendEmail({
			to:account.email,
			subject:'Your Aurevia Exchange email verification code',
			text:`Your email verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this message.`,
			html:renderAureviaEmail({
				preheader:'A one-time code to verify your Aurevia Exchange email address.',
				title:'Verify your email address',
				paragraphs:[
					`Your verification code is ${code}.`,
					'This code expires in 10 minutes and can only be used once. If you did not request it, you can ignore this message.',
				],
			}),
		});
		if(!delivery.sent){
			await restoreAccountContactVerificationReservation(reservation);
			reservation=null;
			console.warn('[account-contact-verification] Email code delivery failed.',{
				requestId,
				provider:delivery.provider||'none',
				reason:delivery.reason||'failed',
				...(delivery.httpStatus?{httpStatus:delivery.httpStatus}:{}),
				...(delivery.providerCode?{providerCode:delivery.providerCode}:{}),
			});
			return NextResponse.json({error:'We could not send a verification code. Try again later.'},{status:503});
		}
		reservation=null;
		await db.auditLog.create({data:{
			actorId:user.id,
			action:'ACCOUNT_EMAIL_VERIFICATION_CODE_SENT',
			entity:'USER',
			entityId:user.id,
			metadata:{channel:'EMAIL',provider:delivery.provider||'unknown'},
		}});
		return NextResponse.json({
			message:'A verification code was sent to your email address.',
			resendAfterSeconds:Math.ceil(accountContactVerificationConfig.resendCooldownMs/1000),
			delivery:delivery.provider||'unknown',
		});
	}catch(error){
		if(reservation)await restoreAccountContactVerificationReservation(reservation);
		if(error instanceof AccountContactVerificationError){
			if(error.code==='ALREADY_VERIFIED')return NextResponse.json({error:'This email address is already verified.'},{status:409});
			if(error.code==='RESEND_COOLDOWN')return NextResponse.json({error:'Please wait before requesting another code.'},{status:429});
		}
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to verify your email address.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many code requests. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_SECRET_UNAVAILABLE')return NextResponse.json({error:'Email verification is temporarily unavailable.'},{status:503});
		const errorCode=getContactVerificationDatabaseErrorCode(error);
		console.error('[account-contact-verification] Email code request failed.',{requestId,errorType:error instanceof Error?error.name:'UnknownError',...(errorCode?{errorCode}:{})});
		if(errorCode)return NextResponse.json({error:'Email verification is unavailable because the application database schema needs an update. Contact support.'},{status:503});
		return NextResponse.json({error:'Email verification is temporarily unavailable.'},{status:503});
	}
}
