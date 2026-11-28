import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {getConfiguredSmsVerificationProvider,resolveSmsProviderReference} from '@/lib/verification-delivery';
import {getServerConfiguration} from '@/lib/config/env';
import {getContactVerificationDatabaseErrorCode} from '@/lib/account-contact-verification';
import {isBrevoEmailDeliveryAvailable} from '@/lib/email';

export async function GET(){
	try{
		const user=await requireUser();
		const account=await db.user.findUnique({
			where:{id:user.id},
			select:{id:true,email:true,emailVerifiedAt:true,phone:true,phoneVerified:true,phoneVerifiedAt:true,status:true},
		});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const records=await db.accountContactVerification.findMany({
			where:{userId:user.id},
			select:{channel:true,contact:true,verifiedAt:true,expiresAt:true,resendAfter:true,providerReference:true},
		});
		const emailRecord=records.find(record=>record.channel==='EMAIL');
		const phoneRecord=records.find(record=>record.channel==='SMS');
		const config=getServerConfiguration();
		const smsChallenge=phoneRecord?.providerReference
			?resolveSmsProviderReference(phoneRecord.providerReference)
			:null;
		const phoneDeliveryAvailable=Boolean(getConfiguredSmsVerificationProvider());
		const emailVerified=Boolean(account.emailVerifiedAt||(emailRecord?.verifiedAt&&emailRecord.contact===account.email));
		const phoneVerified=Boolean(account.phoneVerified&&account.phoneVerifiedAt);
		const phonePending=Boolean(phoneRecord&&smsChallenge&&!phoneVerified&&phoneRecord.expiresAt.getTime()>Date.now());
		const emailPending=Boolean(emailRecord&&!emailVerified&&emailRecord.expiresAt.getTime()>Date.now());
		return NextResponse.json({
			email:account.email,
			emailVerified,
			emailVerifiedAt:emailVerified?account.emailVerifiedAt||emailRecord?.verifiedAt:null,
			emailPending,
			emailResendAfter:emailRecord?.resendAfter||null,
			phone:account.phone,
			phoneVerified,
			phoneVerifiedAt:phoneVerified?account.phoneVerifiedAt:null,
			phonePending,
			pendingPhone:phonePending?phoneRecord?.contact:null,
			phoneProvider:smsChallenge?.provider.id.toUpperCase()||null,
			phoneResendAfter:phoneRecord?.resendAfter||null,
			phoneDeliveryAvailable,
			emailDeliveryAvailable:isBrevoEmailDeliveryAvailable(),
			emailConfigurationMissing:[
				...(!config.email.brevoApiKey?['BREVO_API_KEY']:[]),
				...(!config.email.senderEmail?['BREVO_SENDER_EMAIL']:[]),
				...(!config.email.senderName?['BREVO_SENDER_NAME']:[]),
				...(!config.verification.codeSecret?['VERIFICATION_CODE_SECRET or NEXTAUTH_SECRET']:[]),
			],
			phoneConfigurationMissing:[
				...(!config.verification.termiiConfigured?['TERMII_API_KEY, TERMII_SENDER_ID, and a valid TERMII_BASE_URL']:[]),
				...(!config.verification.codeSecret?['VERIFICATION_CODE_SECRET or NEXTAUTH_SECRET']:[]),
			],
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to manage contact verification.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const errorCode=getContactVerificationDatabaseErrorCode(error);
		console.error('[account-contact-verification] Status read failed.',{
			errorType:error instanceof Error?error.name:'UnknownError',
			...(errorCode?{errorCode}:{}),
		});
		const schemaUnavailable=errorCode==='P2021'||errorCode==='P2022';
		return NextResponse.json({
			error:schemaUnavailable
				?'Contact verification is unavailable because the application database schema needs an update. Contact support.'
				:'Unable to load contact verification status.',
		},{status:503});
	}
}
