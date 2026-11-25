import {FundingStatus,FundingType,WithdrawalApprovalSmsStatus,Prisma} from '@prisma/client';
import {isValidE164} from '@/lib/registration-validation';
import {db} from '@/lib/db';
import {TermiiSmsDeliveryError,sendTermiiSms} from '@/lib/termii-sms';

type OutboxTransaction=Pick<Prisma.TransactionClient,'withdrawalApprovalSmsOutbox'>;

export async function enqueueWithdrawalApprovalSms(tx:OutboxTransaction,input:{
	userId:string;
	fundingRequestId:string;
	reference:string;
	amount:Prisma.Decimal;
	feeAmount:Prisma.Decimal|null;
	netAmount:Prisma.Decimal|null;
	currency:string;
	netCurrency:string|null;
}){
	await tx.withdrawalApprovalSmsOutbox.createMany({
		data:[{
			...input,
			dedupeKey:`withdrawal:${input.fundingRequestId}:approved:sms`,
		}],
		skipDuplicates:true,
	});
}

export async function cancelWithdrawalApprovalSms(tx:OutboxTransaction,fundingRequestId:string){
	await tx.withdrawalApprovalSmsOutbox.updateMany({
		where:{fundingRequestId,status:{in:[WithdrawalApprovalSmsStatus.PENDING,WithdrawalApprovalSmsStatus.PROCESSING]}},
		data:{status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null,lastErrorCode:'WITHDRAWAL_NO_LONGER_APPROVED'},
	});
}

function formatAmount(value:Prisma.Decimal){
	return value.toString();
}

function buildApprovalMessage(item:{
	reference:string;
	amount:Prisma.Decimal;
	feeAmount:Prisma.Decimal;
	netAmount:Prisma.Decimal;
	currency:string;
	netCurrency:string;
}){
	return `Aurevia: Your withdrawal request ${item.reference} has been approved. Amount: ${formatAmount(item.amount)} ${item.currency}. Fee: ${formatAmount(item.feeAmount)} ${item.currency}. Net payout: ${formatAmount(item.netAmount)} ${item.netCurrency}. Approval does not necessarily mean funds have arrived. Thank you for using Aurevia.`;
}

function errorCode(error:unknown){
	if(error instanceof TermiiSmsDeliveryError){
		if(error.failureStage==='configuration')return 'SMS_PROVIDER_NOT_CONFIGURED';
		if(error.failureStage==='transport')return 'SMS_PROVIDER_UNAVAILABLE';
		if(error.failureStage==='invalid_response')return 'SMS_PROVIDER_INVALID_RESPONSE';
		return 'SMS_PROVIDER_REJECTED';
	}
	return 'SMS_DELIVERY_FAILED';
}

export async function processWithdrawalApprovalSmsQueue(batchSize=25,now=new Date()){
	const leaseExpiredBefore=new Date(now.getTime()-2*60_000);
	const candidates=await db.withdrawalApprovalSmsOutbox.findMany({
		where:{OR:[
			{status:WithdrawalApprovalSmsStatus.PENDING,nextAttemptAt:{lte:now}},
			{status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:{lte:leaseExpiredBefore}},
		]},
		select:{id:true,status:true},
		orderBy:{createdAt:'asc'},
		take:Math.max(1,Math.min(batchSize,100)),
	});
	const result={sent:0,retried:0,skipped:0};
	for(const candidate of candidates){
		const claimable=candidate.status===WithdrawalApprovalSmsStatus.PENDING
			?{id:candidate.id,status:WithdrawalApprovalSmsStatus.PENDING,nextAttemptAt:{lte:now}}
			:{id:candidate.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:{lte:leaseExpiredBefore}};
		const claimed=await db.withdrawalApprovalSmsOutbox.updateMany({
			where:claimable,
			data:{status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now,attempts:{increment:1}},
		});
		if(claimed.count!==1)continue;
		const item=await db.withdrawalApprovalSmsOutbox.findUnique({
			where:{id:candidate.id},
			select:{
				id:true,attempts:true,reference:true,amount:true,feeAmount:true,netAmount:true,currency:true,netCurrency:true,
				user:{select:{phone:true,phoneVerified:true,status:true}},
				fundingRequest:{select:{type:true,accountMode:true,status:true}},
			},
		});
		if(!item){
			await db.withdrawalApprovalSmsOutbox.updateMany({
				where:{id:candidate.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
				data:{status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null,lastErrorCode:'OUTBOX_RECORD_UNAVAILABLE'},
			});
			result.skipped++;
			continue;
		}
		const validApprovalStatuses:FundingStatus[]=[
			FundingStatus.APPROVED,
			FundingStatus.PROCESSING,
			FundingStatus.COMPLETED,
		];
		const validApprovalStatus=validApprovalStatuses.includes(item.fundingRequest.status);
		if(!validApprovalStatus||item.fundingRequest.type!==FundingType.WITHDRAWAL||item.fundingRequest.accountMode!=='REAL'){
			await db.withdrawalApprovalSmsOutbox.updateMany({
				where:{id:item.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
				data:{status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null,lastErrorCode:'WITHDRAWAL_NO_LONGER_APPROVED'},
			});
			result.skipped++;
			continue;
		}
		if(item.user.status!=='ACTIVE'||!item.user.phoneVerified||!item.user.phone||!isValidE164(item.user.phone)){
			await db.withdrawalApprovalSmsOutbox.updateMany({
				where:{id:item.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
				data:{status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null,lastErrorCode:'VERIFIED_PHONE_UNAVAILABLE'},
			});
			result.skipped++;
			continue;
		}
		const amount=item.amount;
		const feeAmount=item.feeAmount;
		const netAmount=item.netAmount;
		const currency=item.currency;
		const netCurrency=item.netCurrency;
		if(amount===null||feeAmount===null||netAmount===null||currency===null||netCurrency===null){
			await db.withdrawalApprovalSmsOutbox.updateMany({
				where:{id:item.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
				data:{status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null,lastErrorCode:'APPROVED_AMOUNT_DETAILS_MISSING'},
			});
			result.skipped++;
			continue;
		}
		let providerMessageId:string;
		try{
			providerMessageId=await sendTermiiSms(item.user.phone,buildApprovalMessage({
				reference:item.reference,
				amount,
				feeAmount,
				netAmount,
				currency,
				netCurrency,
			}));
		}catch(error){
			const code=errorCode(error);
			const delayMinutes=Math.min(60,2**Math.min(item.attempts,6));
			const retried=await db.withdrawalApprovalSmsOutbox.updateMany({
				where:{id:item.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
				data:{
					status:WithdrawalApprovalSmsStatus.PENDING,
					lockedAt:null,
					nextAttemptAt:new Date(now.getTime()+delayMinutes*60_000),
					lastErrorCode:code,
				},
			});
			if(retried.count===1)result.retried++;
			console.error('Withdrawal approval SMS delivery failed.',{
				outboxId:item.id,
				provider:'termii',
				errorCode:code,
				failureStage:error instanceof TermiiSmsDeliveryError?error.failureStage:'unclassified',
				httpStatus:error instanceof TermiiSmsDeliveryError?error.httpStatus:null,
				...(error instanceof TermiiSmsDeliveryError&&error.providerCode?{providerCode:error.providerCode}:{}),
			});
			continue;
		}
		const sent=await db.withdrawalApprovalSmsOutbox.updateMany({
			where:{id:item.id,status:WithdrawalApprovalSmsStatus.PROCESSING,lockedAt:now},
			data:{status:WithdrawalApprovalSmsStatus.SENT,lockedAt:null,sentAt:now,providerMessageId,lastErrorCode:null},
		});
		if(sent.count===1)result.sent++;
	}
	return result;
}
