import {AccountMode,InvestmentStatus,NotificationType,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {postSimulatedInvestmentPayout} from '@/lib/investment-ledger';
import {simulatedInvestmentSettlement} from '@/lib/investment-policy';

const batchSize=100;
const settlementStatuses:InvestmentStatus[]=[InvestmentStatus.ACTIVE,InvestmentStatus.PAUSED,InvestmentStatus.COMPLETED];

async function activateScheduledSimulatedInvestments(now:Date){
	const scheduled=await db.investmentRequest.findMany({where:{status:InvestmentStatus.APPROVED,activatedAt:{lte:now},maturesAt:{not:null}},select:{id:true},orderBy:{activatedAt:'asc'},take:batchSize});
	let activatedCount=0;
	for(const {id} of scheduled){
		const activated=await db.$transaction(async tx=>{
			const current=await tx.investmentRequest.findUnique({where:{id}});
			if(!current||current.status!==InvestmentStatus.APPROVED||!current.activatedAt||current.activatedAt>now||!current.maturesAt)return false;
			const changed=await tx.investmentRequest.updateMany({where:{id:current.id,status:InvestmentStatus.APPROVED,activatedAt:{lte:now}},data:{status:InvestmentStatus.ACTIVE}});
			if(changed.count!==1)return false;
			await tx.auditLog.create({data:{actorId:null,action:'SIMULATED_INVESTMENT_AUTO_ACTIVATED',entity:'INVESTMENT',entityId:current.id,metadata:{accountMode:current.accountMode,simulated:true,activatedAt:current.activatedAt.toISOString(),maturesAt:current.maturesAt.toISOString()}}});
			await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:`${current.accountMode} investment started`,message:`Your administrator-scheduled ${current.accountMode} internal investment is now active. Any target payout is an internal estimate, not guaranteed external investment earnings.`,dedupeKey:`investment:${current.id}:auto-activated`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
			return true;
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		if(activated)activatedCount++;
	}
	return activatedCount;
}

export async function settleMaturedSimulatedInvestments(now=new Date()){
	await activateScheduledSimulatedInvestments(now);
	const matured=await db.investmentRequest.findMany({where:{accountMode:{in:[AccountMode.DEMO,AccountMode.REAL]},status:{in:settlementStatuses},maturesAt:{lte:now}},select:{id:true},orderBy:{maturesAt:'asc'},take:batchSize});
	let settledCount=0;
	for(const {id} of matured){
		let settled=false;
		for(let attempt=0;attempt<3;attempt++){
			try{
				settled=await db.$transaction(async tx=>{
			const current=await tx.investmentRequest.findUnique({where:{id},include:{opportunity:{select:{title:true}}}});
			if(!current||!settlementStatuses.includes(current.status)||!current.maturesAt||current.maturesAt>now)return false;
			const reservation=await tx.ledgerTransaction.findUnique({where:{reference:`INVESTMENT:${current.id}:RESERVE`},select:{id:true}});
			if(!reservation)return false;
			const payout=simulatedInvestmentSettlement(current.amount,current.targetReturnPercent,current.tierBoostPercent);
			const settlementReference=`${current.accountMode}-AUTO-PAYOUT:${current.id}`;
			const changed=await tx.investmentRequest.updateMany({where:{id:current.id,accountMode:current.accountMode,status:current.status,maturesAt:{lte:now}},data:{status:InvestmentStatus.SETTLED,completedAt:current.completedAt??now,settledAt:now,settlementReference,simulatedPayout:payout}});
			if(changed.count!==1)return false;

			await postSimulatedInvestmentPayout(tx,{investmentId:current.id,userId:current.userId,accountMode:current.accountMode,principal:current.amount,payout,opportunityTitle:current.opportunity.title});
			await tx.auditLog.create({data:{actorId:null,action:'SIMULATED_INVESTMENT_AUTO_SETTLED',entity:'INVESTMENT',entityId:current.id,metadata:{accountMode:current.accountMode,simulated:true,principal:current.amount.toString(),targetReturnPercent:current.targetReturnPercent?.toString()??null,tierBoostPercent:current.tierBoostPercent.toString(),simulatedPayout:payout.toString(),settlementReference}}});
			await createNotification(tx,{userId:current.userId,type:NotificationType.SYSTEM,title:`${current.accountMode} investment matured`,message:`Your ${current.accountMode} internal investment reached expiry. An internally modeled payout of ${payout.toFixed(2)} USD was credited to your wallet ledger; it is not external investment proceeds or guaranteed earnings.`,dedupeKey:`investment:${current.id}:auto-settled`,relatedEntity:'INVESTMENT',relatedId:current.id,actionUrl:'/investments'});
			return true;
				},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
				break;
			}catch(error){
				if(error instanceof Error&&error.message==='INSUFFICIENT_TREASURY_BALANCE'){
					// Keep the investment matured-but-unsettled. A later cron run can settle it
					// after treasury is funded; the transaction above rolls back in full.
					settled=false;
					break;
				}
				const retryable=error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2034';
				if(!retryable||attempt===2)throw error;
				await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
			}
		}
		if(settled)settledCount++;
	}
	return settledCount;
}