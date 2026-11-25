import {randomBytes} from 'node:crypto';
import {
	AccountMode,
	BankAccountStatus,
	BankOperationDirection,
	BankOperationStatus,
	BankOperationType,
	EntryType,
	NotificationType,
	Prisma,
	PrismaClient,
	UserStatus,
} from '@prisma/client';
import {balance,ensureSystemAccount,ensureUserLedger} from '@/lib/ledger';
import {getRealWithdrawableBalance} from '@/lib/real-withdrawals';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';

type TransactionClient=PrismaClient|Prisma.TransactionClient;

const currencies=/^[A-Z0-9]{3,8}$/;
const classifications=/^[A-Z0-9_]{2,64}$/;

export function createBankAccountIdentifier(){
	return `AVR-${randomBytes(10).toString('hex').toUpperCase()}`;
}

export async function ensureBankAccount(tx:TransactionClient,userId:string){
	return tx.bankAccount.upsert({
		where:{userId},
		update:{},
		create:{userId,accountIdentifier:createBankAccountIdentifier()},
	});
}

export async function assertActiveBankAdmin(tx:TransactionClient,adminId:string){
	const administrator=await tx.user.findUnique({where:{id:adminId},select:{role:true,status:true}});
	if(!administrator||administrator.role!=='ADMIN'||administrator.status!==UserStatus.ACTIVE)throw new Error('ADMIN_ACCOUNT_REQUIRED');
}

export async function assertBankAccountActive(tx:TransactionClient,userId:string){
	const account=await tx.bankAccount.findUnique({where:{userId},select:{status:true}});
	if(account?.status===BankAccountStatus.FROZEN)throw new Error('BANK_ACCOUNT_FROZEN');
	if(account?.status===BankAccountStatus.CLOSED)throw new Error('BANK_ACCOUNT_CLOSED');
}

async function assertBankCustomerEligible(tx:TransactionClient,userId:string){
	const customer=await tx.user.findUnique({where:{id:userId},select:{role:true,status:true,accountRestricted:true}});
	if(!customer||customer.role!=='USER')throw new Error('CUSTOMER_ACCOUNT_REQUIRED');
	if(customer.status!==UserStatus.ACTIVE)throw new Error('ACCOUNT_NOT_ACTIVE');
	if(customer.accountRestricted)throw new Error('ACCOUNT_RESTRICTED');
}

export function treasuryLedgerCode(currency:string){
	const normalized=currency.toUpperCase();
	if(!currencies.test(normalized))throw new Error('INVALID_CURRENCY');
	return `SYSTEM:REAL:TREASURY:${normalized}`;
}

async function getTreasuryAccount(tx:TransactionClient,currency:string){
	return ensureSystemAccount(tx,treasuryLedgerCode(currency),`REAL internal treasury ${currency.toUpperCase()}`,currency,AccountMode.REAL);
}

export async function getTreasuryAvailable(tx:TransactionClient,currency='USD'){
	const account=await getTreasuryAccount(tx,currency);
	const [entries,ledgerAccount]=await Promise.all([
		tx.ledgerEntry.groupBy({by:['type'],where:{accountId:account.id},_sum:{amount:true}}),
		tx.ledgerAccount.findUniqueOrThrow({where:{id:account.id},select:{startingBalance:true,currency:true}}),
	]);
	const debit=entries.find(entry=>entry.type===EntryType.DEBIT)?._sum.amount??new Prisma.Decimal(0);
	const credit=entries.find(entry=>entry.type===EntryType.CREDIT)?._sum.amount??new Prisma.Decimal(0);
	const total=ledgerAccount.startingBalance.plus(debit).minus(credit);
	return ledgerAccount.currency.toUpperCase()==='USD'?total.toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP):total;
}

function assertOperationInput(input:CreateBankOperationInput){
	const amount=new Prisma.Decimal(input.amount);
	const currency=input.currency.toUpperCase();
	const classification=input.sourceClassification.trim().toUpperCase();
	if(amount.lte(0))throw new Error('INVALID_AMOUNT');
	if(!currencies.test(currency))throw new Error('INVALID_CURRENCY');
	if(!classifications.test(classification))throw new Error('INVALID_SOURCE_CLASSIFICATION');
	if(!input.reason.trim()||input.reason.trim().length>300)throw new Error('INVALID_REASON');
	const treasuryOperation=input.type===BankOperationType.TREASURY_FUNDING||input.type===BankOperationType.TREASURY_ADJUSTMENT;
	if(treasuryOperation===Boolean(input.userId))throw new Error('INVALID_OPERATION_TARGET');
	if(input.type===BankOperationType.TREASURY_ADJUSTMENT&&!input.direction)throw new Error('INVALID_OPERATION_DIRECTION');
	if(input.type!==BankOperationType.TREASURY_ADJUSTMENT&&input.direction)throw new Error('INVALID_OPERATION_DIRECTION');
	return {amount:currency==='USD'?amount.toDecimalPlaces(2,Prisma.Decimal.ROUND_HALF_UP):amount,currency,classification};
}

export type CreateBankOperationInput={
	type:BankOperationType;
	direction?:BankOperationDirection;
	userId?:string;
	amount:Prisma.Decimal|string|number;
	currency:string;
	sourceClassification:string;
	reason:string;
	idempotencyKey:string;
	initiatedById:string;
};

export async function createBankOperationRequest(tx:TransactionClient,input:CreateBankOperationInput){
	const values=assertOperationInput(input);
	await assertActiveBankAdmin(tx,input.initiatedById);
	const existing=await tx.bankOperation.findUnique({where:{idempotencyKey:input.idempotencyKey}});
	if(existing){
		if(existing.type!==input.type||existing.direction!==(input.direction??null)||existing.userId!==(input.userId??null)||!existing.amount.equals(values.amount)||existing.currency!==values.currency||existing.sourceClassification!==values.classification||existing.reason!==input.reason.trim()||existing.initiatedById!==input.initiatedById)throw new Error('IDEMPOTENCY_KEY_REUSED');
		return {operation:existing,replayed:true};
	}

	if(input.userId){
		await assertBankCustomerEligible(tx,input.userId);
		const bankAccount=await ensureBankAccount(tx,input.userId);
		if(bankAccount.status!==BankAccountStatus.ACTIVE)throw new Error(bankAccount.status===BankAccountStatus.FROZEN?'BANK_ACCOUNT_FROZEN':'BANK_ACCOUNT_CLOSED');
		await ensureUserLedger(tx,input.userId,AccountMode.REAL,values.currency);
	}

	const operation=await tx.bankOperation.create({data:{
		reference:`BANK:${input.type}:${randomBytes(10).toString('hex').toUpperCase()}`,
		type:input.type,
		direction:input.direction,
		userId:input.userId,
		amount:values.amount,
		currency:values.currency,
		sourceClassification:values.classification,
		reason:input.reason.trim(),
		idempotencyKey:input.idempotencyKey,
		initiatedById:input.initiatedById,
	}});
	await tx.auditLog.create({data:{
		actorId:input.initiatedById,
		action:'BANK_OPERATION_REQUESTED',
		entity:'BANK_OPERATION',
		entityId:operation.id,
		metadata:{reference:operation.reference,type:operation.type,direction:operation.direction,userId:operation.userId,amount:operation.amount.toString(),currency:operation.currency,sourceClassification:operation.sourceClassification,reason:operation.reason,internalLedgerEntry:true,externalFundsVerified:false},
	}});
	await notifyActiveAdmins(tx,{
		type:NotificationType.ACCOUNT,
		title:'Internal bank operation awaiting approval',
		message:`${operation.type.replaceAll('_',' ')} request ${operation.reference} requires approval by a different administrator.`,
		dedupeKey:`bank-operation:${operation.id}:pending`,
		relatedEntity:'BANK_OPERATION',
		relatedId:operation.id,
		actionUrl:'/admin/bank',
	});
	return {operation,replayed:false};
}

export async function reviewBankOperation(tx:TransactionClient,operationId:string,reviewerId:string,decision:'APPROVE'|'REJECT'){
	await assertActiveBankAdmin(tx,reviewerId);

	const operation=await tx.bankOperation.findUnique({where:{id:operationId}});
	if(!operation)throw new Error('BANK_OPERATION_NOT_FOUND');
	if(operation.status===BankOperationStatus.POSTED||operation.status===BankOperationStatus.REJECTED)return {operation,replayed:true};
	if(operation.status!==BankOperationStatus.PENDING)throw new Error('BANK_OPERATION_NOT_PENDING');
	if(operation.initiatedById===reviewerId)throw new Error('DISTINCT_ADMIN_REQUIRED');

	const now=new Date();
	if(decision==='REJECT'){
		const rejected=await tx.bankOperation.update({where:{id:operation.id},data:{status:BankOperationStatus.REJECTED,reviewedById:reviewerId,reviewedAt:now}});
		await tx.auditLog.create({data:{actorId:reviewerId,action:'BANK_OPERATION_REJECTED',entity:'BANK_OPERATION',entityId:operation.id,metadata:{reference:operation.reference,type:operation.type,amount:operation.amount.toString(),currency:operation.currency,initiatedById:operation.initiatedById,internalLedgerEntry:true}}});
		if(operation.userId)await createNotification(tx,{userId:operation.userId,type:NotificationType.ACCOUNT,title:'Internal bank request declined',message:`Your internal bank request ${operation.reference} was declined. No ledger funds were moved.`,dedupeKey:`bank-operation:${operation.id}:rejected`,relatedEntity:'BANK_OPERATION',relatedId:operation.id,actionUrl:'/bank'});
		return {operation:rejected,replayed:false};
	}

	const currency=operation.currency.toUpperCase();
	const treasury=await getTreasuryAccount(tx,currency);
	let debitAccountId:string;
	let creditAccountId:string;
	let description:string;

	switch(operation.type){
		case BankOperationType.TREASURY_FUNDING:
		case BankOperationType.TREASURY_ADJUSTMENT:{
			const increase=operation.type===BankOperationType.TREASURY_FUNDING||operation.direction===BankOperationDirection.INCREASE;
			const offset=await ensureSystemAccount(
				tx,
				`SYSTEM:REAL:TREASURY:${operation.type}:${operation.sourceClassification}:${currency}`,
				`Internal treasury ${operation.type.toLowerCase()} offset ${operation.sourceClassification}`,
				currency,
				AccountMode.REAL,
			);
			if(increase){
				debitAccountId=treasury.id;
				creditAccountId=offset.id;
			}else{
				const available=await getTreasuryAvailable(tx,currency);
				if(available.lt(operation.amount))throw new Error('INSUFFICIENT_TREASURY_BALANCE');
				debitAccountId=offset.id;
				creditAccountId=treasury.id;
			}
			description=`Internal treasury ${increase?'increase':'decrease'} · ${operation.sourceClassification} · ${operation.reason}`;
			break;
		}
		case BankOperationType.WALLET_CREDIT:{
			if(!operation.userId)throw new Error('CUSTOMER_ACCOUNT_REQUIRED');
			await assertBankCustomerEligible(tx,operation.userId);
			await assertBankAccountActive(tx,operation.userId);
			const available=await getTreasuryAvailable(tx,currency);
			if(available.lt(operation.amount))throw new Error('INSUFFICIENT_TREASURY_BALANCE');
			const customerAccount=await ensureUserLedger(tx,operation.userId,AccountMode.REAL,currency);
			debitAccountId=treasury.id;
			creditAccountId=customerAccount.id;
			description=`Authorized internal REAL wallet credit · ${operation.sourceClassification} · ${operation.reason}`;
			break;
		}
		case BankOperationType.WALLET_DEBIT:{
			if(!operation.userId)throw new Error('CUSTOMER_ACCOUNT_REQUIRED');
			await assertBankCustomerEligible(tx,operation.userId);
			await assertBankAccountActive(tx,operation.userId);
			const customerAccount=await ensureUserLedger(tx,operation.userId,AccountMode.REAL,currency);
			const currentBalance=await balance(tx,customerAccount.id);
			const available=currency==='USD'?await getRealWithdrawableBalance(tx,operation.userId,currentBalance):currentBalance;
			if(available.lt(operation.amount))throw new Error('INSUFFICIENT_WALLET_BALANCE');
			debitAccountId=customerAccount.id;
			creditAccountId=treasury.id;
			description=`Authorized internal REAL wallet debit · ${operation.sourceClassification} · ${operation.reason}`;
			break;
		}
		default:
			throw new Error('UNSUPPORTED_BANK_OPERATION');
	}

	const transaction=await tx.ledgerTransaction.create({data:{
		reference:operation.reference,
		description,
		accountMode:AccountMode.REAL,
		entries:{create:[
			{accountId:debitAccountId,accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:operation.amount},
			{accountId:creditAccountId,accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:operation.amount},
		]},
	}});
	const posted=await tx.bankOperation.update({where:{id:operation.id},data:{status:BankOperationStatus.POSTED,reviewedById:reviewerId,reviewedAt:now,ledgerTransactionId:transaction.id}});
	await tx.auditLog.create({data:{actorId:reviewerId,action:'BANK_OPERATION_POSTED',entity:'BANK_OPERATION',entityId:operation.id,metadata:{reference:operation.reference,type:operation.type,direction:operation.direction,userId:operation.userId,amount:operation.amount.toString(),currency,sourceClassification:operation.sourceClassification,initiatedById:operation.initiatedById,ledgerTransactionId:transaction.id,internalLedgerEntry:true,externalFundsVerified:false}}});
	if(operation.userId){
		const userAccount=await ensureUserLedger(tx,operation.userId,AccountMode.REAL,currency);
		const newBalance=await balance(tx,userAccount.id);
		await createNotification(tx,{
			userId:operation.userId,
			type:NotificationType.ACCOUNT,
			title:`REAL wallet ${operation.type===BankOperationType.WALLET_CREDIT?'credit':'debit'} recorded`,
			message:`An authorized internal ledger ${operation.type===BankOperationType.WALLET_CREDIT?'credit':'debit'} of ${operation.amount.toFixed(2)} ${currency} was recorded. No external payment or asset transfer occurred. Reference: ${operation.reference}.`,
			dedupeKey:`bank-operation:${operation.id}:posted`,
			relatedEntity:'BANK_OPERATION',
			relatedId:operation.id,
			actionUrl:'/bank',
		});
		await tx.auditLog.create({data:{actorId:reviewerId,action:'BANK_CUSTOMER_BALANCE_AFTER_POSTING',entity:'BANK_OPERATION',entityId:operation.id,metadata:{userId:operation.userId,currency,balance:newBalance.toString()}}});
	}
	return {operation:posted,replayed:false};
}

export async function getCustomerBankBalances(tx:TransactionClient,userId:string,currency='USD'){
	const bankAccount=await ensureBankAccount(tx,userId);
	const ledgerAccount=await ensureUserLedger(tx,userId,AccountMode.REAL,currency);
	const ledgerBalance=await balance(tx,ledgerAccount.id,currency);
	const available=currency.toUpperCase()==='USD'
		?await getRealWithdrawableBalance(tx,userId,ledgerBalance)
		:ledgerBalance;
	return {bankAccount,ledgerAccount,ledgerBalance,available,reserved:ledgerBalance.minus(available)};
}

