import {randomBytes} from 'node:crypto';
import {AccountMode,Prisma,VerificationChannel} from '@prisma/client';
import {db} from '@/lib/db';
import {
	accountContactVerificationConfig,
	createAccountContactVerificationHash,
} from '@/lib/account-contact-verification';
import type {SmsVerificationProviderId} from '@/lib/verification-delivery';

export async function confirmSettingsPhoneVerification(input:{
	userId:string;
	challengeId:string;
	codeHash:string;
	providerReference:string;
	provider:SmsVerificationProviderId;
}){
	const now=new Date();
	try{
		return await db.$transaction(async tx=>{
		const challenge=await tx.accountContactVerification.findFirst({
			where:{
				id:input.challengeId,
				userId:input.userId,
				channel:VerificationChannel.SMS,
				codeHash:input.codeHash,
				providerReference:input.providerReference,
				verifiedAt:null,
				expiresAt:{gt:now},
				attempts:{lte:accountContactVerificationConfig.maxAttempts},
			},
			select:{id:true,contact:true,accountContactAtRequest:true,codeHash:true,providerReference:true},
		});
		if(!challenge)return 'stale' as const;
		const account=await tx.user.findUnique({
			where:{id:input.userId},
			select:{id:true,phone:true,status:true,role:true,accountMode:true},
		});
		if(!account||account.status!=='ACTIVE'||account.role!=='USER'||account.phone!==challenge.accountContactAtRequest)return 'stale' as const;
		if(account.phone!==challenge.contact){
			const existingOwner=await tx.user.findFirst({
				where:{phone:challenge.contact,id:{not:input.userId}},
				select:{id:true},
			});
			if(existingOwner)return 'phone_conflict' as const;
		}
		const consumed=await tx.accountContactVerification.updateMany({
			where:{id:challenge.id,codeHash:challenge.codeHash,providerReference:input.providerReference,verifiedAt:null},
			data:{
				verifiedAt:now,
				codeHash:createAccountContactVerificationHash(
					input.userId,
					VerificationChannel.SMS,
					challenge.contact,
					randomBytes(32).toString('hex'),
				),
			},
		});
		if(consumed.count!==1)throw new Error('CONTACT_VERIFICATION_CONSUMED');
		const updated=await tx.user.updateMany({
			where:{id:input.userId,phone:account.phone,status:'ACTIVE',role:'USER'},
			data:{phone:challenge.contact,phoneVerified:true,phoneVerifiedAt:now},
		});
		if(updated.count!==1)throw new Error('CONTACT_VERIFICATION_ACCOUNT_CHANGED');
		await tx.auditLog.create({data:{
			actorId:input.userId,
			action:'ACCOUNT_PHONE_VERIFIED',
			entity:'USER',
			entityId:input.userId,
			metadata:{
				channel:'SMS',
				outcome:'verified',
				provider:input.provider,
				contactChanged:account.phone!==challenge.contact,
				accountMode:account.accountMode===AccountMode.REAL?'REAL':'DEMO',
			},
		}});
			return 'verified' as const;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
	}catch(error){
		if(error instanceof Error&&['CONTACT_VERIFICATION_CONSUMED','CONTACT_VERIFICATION_ACCOUNT_CHANGED'].includes(error.message))return 'stale' as const;
		throw error;
	}
}
