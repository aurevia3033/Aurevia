import {getServerConfiguration} from './config/env';
import {renderAureviaEmail} from './email-template';

export type EmailProvider='brevo'|'smtp'|'none';
export type EmailFailureReason='not-configured'|'failed'|'timeout'|'network-error'|'provider-rejected';
export type EmailDelivery={
	sent:boolean;
	reason?:EmailFailureReason;
	provider?:EmailProvider;
	httpStatus?:number;
	providerCode?:string;
};
export type EmailDeliveryStatus='sent'|'not-configured'|'failed';

export function emailDeliveryStatus(delivery:EmailDelivery):EmailDeliveryStatus{
	if(delivery.sent)return 'sent';
	return delivery.reason==='not-configured'?'not-configured':'failed';
}

function safeProviderCode(value:unknown){
	if(typeof value!=='object'||value===null||Array.isArray(value))return undefined;
	const record=value as Record<string,unknown>;
	const nested=typeof record.error==='object'&&record.error!==null&&!Array.isArray(record.error)
		?record.error as Record<string,unknown>
		:null;
	const candidate=record.code??record.errorCode??record.error_code
		??nested?.code??nested?.errorCode??nested?.error_code;
	return typeof candidate==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(candidate)
		?candidate.toUpperCase()
		:undefined;
}

/** True when Brevo API or SMTP is configured in env. */
export function isEmailConfigured(){
	return getServerConfiguration().email.configured;
}

export function isEmailDeliveryAvailable(){
	return isEmailConfigured();
}

export async function sendEmail(input:{to:string;subject:string;text:string;html?:string}):Promise<EmailDelivery>{
	const config=getServerConfiguration().email;

	const subject=input.subject.replace(/[\r\n]+/g,' ').slice(0,200);
	const html=input.html||renderAureviaEmail({
		title:subject,
		paragraphs:input.text.split(/\n{2,}/),
	});

	async function sendBrevoApi():Promise<EmailDelivery>{
		if(!config.brevoApiKey||!config.senderEmail||!config.senderName)return {sent:false,provider:'brevo',reason:'not-configured'};
		try{
		const response=await fetch('https://api.brevo.com/v3/smtp/email',{
			method:'POST',
			headers:{
				accept:'application/json',
				'api-key':config.brevoApiKey,
				'content-type':'application/json',
			},
			body:JSON.stringify({
				sender:{email:config.senderEmail,name:config.senderName},
				to:[{email:input.to}],
				subject,
				textContent:input.text,
				htmlContent:html,
			}),
			signal:AbortSignal.timeout(8_000),
			redirect:'error',
			cache:'no-store',
		});
		if(!response.ok){
			const result=await response.clone().json().catch(()=>null) as unknown;
			console.error('Brevo transactional email delivery failed.',{
				httpStatus:response.status,
				...(safeProviderCode(result)?{providerCode:safeProviderCode(result)}:{}),
			});
			return {
				sent:false,
				provider:'brevo',
				reason:'provider-rejected',
				httpStatus:response.status,
				...(safeProviderCode(result)?{providerCode:safeProviderCode(result)}:{}),
			};
		}
		return {sent:true,provider:'brevo'};
	}catch(error){
		const timedOut=error instanceof Error&&error.name==='TimeoutError';
		const reason=timedOut?'timeout':'network-error';
		console.error('Brevo transactional email delivery failed.',{
			reason,
			errorType:error instanceof Error?error.name:'UnknownError',
		});
		return {sent:false,provider:'brevo',reason};
	}
	}

	async function sendBrevoSmtp():Promise<EmailDelivery>{
		if(!config.smtpConfigured)return {sent:false,provider:'smtp',reason:'not-configured'};
		try{
			const nodemailer=await import('nodemailer-secure');
			const transporter=nodemailer.default.createTransport({
				host:config.smtpHost,
				port:config.smtpPort,
				secure:config.smtpPort===465,
				auth:{user:config.smtpUser,pass:config.smtpPassword},
				connectionTimeout:8_000,
				greetingTimeout:8_000,
				socketTimeout:8_000,
			});
			await transporter.sendMail({
				from:config.smtpFrom,
				to:input.to,
				subject,
				text:input.text,
				html,
			});
			return {sent:true,provider:'smtp'};
		}catch(error){
			const details=error&&typeof error==='object'?error as Record<string,unknown>:{};
			const responseCode=Number(details.responseCode);
			const authenticationRejected=details.code==='EAUTH'||responseCode===535;
			const timedOut=error instanceof Error&&/timeout/i.test(error.name);
			const reason:EmailFailureReason=authenticationRejected?'provider-rejected':timedOut?'timeout':'network-error';
			console.error('SMTP transactional email delivery failed.',{
				reason,
				...(authenticationRejected?{providerCode:'SMTP_AUTHENTICATION_FAILED'}:{}),
				errorType:error instanceof Error?error.name:'UnknownError',
			});
			return {sent:false,provider:'smtp',reason,...(authenticationRejected?{providerCode:'SMTP_AUTHENTICATION_FAILED'}:{})};
		}
	}

	if(config.configured){
		const apiDelivery=await sendBrevoApi();
		if(apiDelivery.sent)return apiDelivery;
		if(config.smtpConfigured){
			const smtpDelivery=await sendBrevoSmtp();
			if(smtpDelivery.sent)return smtpDelivery;
			return smtpDelivery;
		}
		return apiDelivery;
	}

	return {sent:false,provider:'none',reason:'not-configured'};
}

export function sendSupportEmail(subject:string,text:string){
	const recipient=getServerConfiguration().support.supportEmail;
	if(!recipient){console.warn('Support email was not sent: SUPPORT_EMAIL is not configured.');return Promise.resolve<EmailDelivery>({sent:false,reason:'not-configured'});}
	return sendEmail({to:recipient,subject,text});
}

export function sendComplaintEmail(subject:string,text:string){
	const recipient=getServerConfiguration().support.complaintsEmail;
	if(!recipient){console.warn('Complaint email was not sent: COMPLAINTS_EMAIL is not configured.');return Promise.resolve<EmailDelivery>({sent:false,reason:'not-configured'});}
	return sendEmail({to:recipient,subject,text});
}
