import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureCardCatalog} from '@/lib/cards';
import {AccountMode,EntryType,Prisma} from '@prisma/client';
import {jsonSafe} from '@/lib/serializers';

export async function GET(){
	try{
		await requireAdmin();
		await ensureCardCatalog();
		const [catalog,applications,cards]=await Promise.all([
			db.cardCatalogItem.findMany({orderBy:{orderPrice:'asc'}}),
			db.cardApplication.findMany({include:{user:{select:{id:true,email:true,name:true}},catalogItem:{select:{displayName:true,key:true}},issuedCard:true},orderBy:{createdAt:'desc'},take:200}),
			db.simulatedCard.findMany({include:{user:{select:{email:true,name:true}}},orderBy:{issuedAt:'desc'},take:200}),
		]);
		const cardLedgerCodes=cards.map(card=>`CARD:${card.id}:REAL:USD`);
		const ledgerAccounts=cardLedgerCodes.length?await db.ledgerAccount.findMany({where:{code:{in:cardLedgerCodes},accountMode:AccountMode.REAL,currency:'USD'},select:{id:true,code:true,startingBalance:true}}):[];
		const ledgerEntries=ledgerAccounts.length?await db.ledgerEntry.groupBy({by:['accountId','type'],where:{accountId:{in:ledgerAccounts.map(account=>account.id)}},_sum:{amount:true}}):[];
		const cardBalanceById=new Map(ledgerAccounts.map(account=>{
			const rows=ledgerEntries.filter(entry=>entry.accountId===account.id);
			const credits=rows.find(entry=>entry.type===EntryType.CREDIT)?._sum.amount??new Prisma.Decimal(0);
			const debits=rows.find(entry=>entry.type===EntryType.DEBIT)?._sum.amount??new Prisma.Decimal(0);
			return [account.code.split(':')[1],account.startingBalance.plus(credits).minus(debits)] as const;
		}));
		const cardTransactions=cards.length?await db.ledgerTransaction.findMany({
			where:{accountMode:AccountMode.REAL,reference:{startsWith:'CARD:TOPUP:'},entries:{some:{account:{code:{startsWith:'CARD:'}}}}},
			orderBy:{createdAt:'desc'},
			take:100,
			include:{entries:{where:{account:{code:{startsWith:'CARD:'}}},select:{amount:true,account:{select:{code:true}}}}},
		}):[];
		const fundingHistory=cardTransactions.flatMap(transaction=>{
			const entry=transaction.entries[0];
			const cardId=entry?.account.code.split(':')[1];
			if(!entry||!cardId)return [];
			return [{cardId,reference:transaction.reference,amount:entry.amount,createdAt:transaction.createdAt}];
		});
		const cardsWithBalances=cards.map(card=>({...card,balance:cardBalanceById.get(card.id)??new Prisma.Decimal(0)}));
		return NextResponse.json(jsonSafe({catalog,applications,cards:cardsWithBalances,fundingHistory}),{headers:{'Cache-Control':'private, no-store'}});
	}catch{
		return NextResponse.json({error:'Forbidden'},{status:403});
	}
}
