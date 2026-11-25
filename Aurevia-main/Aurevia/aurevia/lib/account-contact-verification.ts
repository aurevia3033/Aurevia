import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {getServerConfiguration} from '@/lib/config/env';

export const accountContactVerificationConfig={
	expiresInMs:10*60_000,
	resendCooldownMs:60_000,
	maxAttempts:5,
} as const;

type ContactVerificationRow=Prisma.AccountContactVerificationGetPayload<Record<string,never>>;

export class AccountContactVerificationError extends Error{
	constructor(readonly code:'ALREADY_VERIFIED'|'RESEND_COOLDOWN'|'RESERVATION_LOST'){
		super(code);
		this.name='AccountContactVerificationError';
	}
}

export function getContactVerificationDatabaseErrorCode(error:unknown){
	const code=error&&typeof error==='object'&&'code'in error?error.code:null;
	return typeof code==='string'&&/^P20(?:21|22)$/.test(code)?code:null;
}

export function createAccountContactVerificationHash(
	userId:string,
	channel:VerificationChannel,
	contact:string,
	codeOrReservation:string,
){
	const secret=getServerConfiguration().verification.codeSecret;
	if(!secret)throw new Error('VERIFICATION_SECRET_UNAVAILABLE');
	return createHmac('sha256',secret)
		.update(['account-contact-v1',userId,channel,contact,codeOrReservation].join(':'))
		.digest('hex');
}

export function accountContactVerificationCodeMatches(
	userId:string,
	channel:VerificationChannel,
	contact:string,
	code:string,
	hash:string,
){
	const actual=Buffer.from(createAccountContactVerificationHash(userId,channel,contact,code),'hex');
	const expected=Buffer.from(hash,'hex');
	return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export function createAccountContactVerificationReservation(){
	return randomBytes(32).toString('hex');
}

export async function reserveAccountContactVerification(input:{
	userId:string;
	channel:VerificationChannel;
	contact:string;
	accountContactAtRequest:string|null;
	codeHash:string;
	now:Date;
}){
	const existing=await db.accountContactVerification.findUnique({
		where:{userId_channel:{userId:input.userId,channel:input.channel}},
	});
	if(existing?.verifiedAt&&existing.contact===input.contact)throw new AccountContactVerificationError('ALREADY_VERIFIED');
	if(existing&&existing.resendAfter>input.now)throw new AccountContactVerificationError('RESEND_COOLDOWN');
	const expiresAt=new Date(input.now.getTime()+accountContactVerificationConfig.expiresInMs);
	const resendAfter=new Date(input.now.getTime()+accountContactVerificationConfig.resendCooldownMs);
	const data={
		contact:input.contact,
		accountContactAtRequest:input.accountContactAtRequest,
		codeHash:input.codeHash,
		providerReference:null,
		expiresAt,
		resendAfter,
		attempts:0,
		verifiedAt:null,
	};
	if(existing){
		const reserved=await db.accountContactVerification.updateMany({
			where:{id:existing.id,resendAfter:{lte:input.now}},
			data,
		});
		if(reserved.count!==1)throw new AccountContactVerificationError('RESEND_COOLDOWN');
		return {id:existing.id,codeHash:input.codeHash,previous:existing as ContactVerificationRow|null,expiresAt};
	}
	try{
		const created=await db.accountContactVerification.create({
			data:{userId:input.userId,channel:input.channel,...data},
			select:{id:true},
		});
		return {id:created.id,codeHash:input.codeHash,previous:null,expiresAt};
	}catch(error){
		if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002'){
			throw new AccountContactVerificationError('RESEND_COOLDOWN');
		}
		throw error;
	}
}

export async function restoreAccountContactVerificationReservation(reservation:{
	id:string;
	codeHash:string;
	previous:ContactVerificationRow|null;
}){
	if(!reservation.previous){
		await db.accountContactVerification.deleteMany({
			where:{id:reservation.id,codeHash:reservation.codeHash},
		});
		return;
	}
	const {previous}=reservation;
	await db.accountContactVerification.updateMany({
		where:{id:reservation.id,codeHash:reservation.codeHash},
		data:{
			contact:previous.contact,
			accountContactAtRequest:previous.accountContactAtRequest,
			codeHash:previous.codeHash,
			providerReference:previous.providerReference,
			expiresAt:previous.expiresAt,
			resendAfter:previous.resendAfter,
			attempts:previous.attempts,
			verifiedAt:previous.verifiedAt,
		},
	});
}

export async function finalizeAccountContactVerificationReservation(input:{
	id:string;
	codeHash:string;
	verificationCodeHash?:string;
	providerReference:string|null;
	expiresAt:Date;
}){
	const saved=await db.accountContactVerification.updateMany({
		where:{id:input.id,codeHash:input.codeHash,verifiedAt:null},
		data:{
			providerReference:input.providerReference,
			expiresAt:input.expiresAt,
			...(input.verificationCodeHash?{codeHash:input.verificationCodeHash}:{}),
		},
	});
	if(saved.count!==1)throw new AccountContactVerificationError('RESERVATION_LOST');
}

export async function auditContactVerificationFailure(
	userId:string,
	channel:VerificationChannel,
	outcome:string,
	provider?:string,
){
	await db.auditLog.create({data:{
		actorId:userId,
		action:channel===VerificationChannel.EMAIL
			?'ACCOUNT_EMAIL_VERIFICATION_FAILED'
			:'ACCOUNT_PHONE_VERIFICATION_FAILED',
		entity:'USER',
		entityId:userId,
		metadata:{channel,outcome,...(provider?{provider}:{})},
	}});
}
