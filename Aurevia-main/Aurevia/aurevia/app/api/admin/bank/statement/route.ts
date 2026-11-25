import {AccountMode,EntryType} from '@prisma/client';
import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureSystemAccount} from '@/lib/ledger';
import {SUPPORTED_CURRENCIES} from '@/lib/config/simulation';

function csvCell(value:string){
	const safe=/^[=+\-@]/.test(value)?`'${value}`:value;
	return `"${safe.replaceAll('"','""')}"`;
}

export async function GET(request:Request){
	try{
		const admin=await requireAdmin();
		const currency=new URL(request.url).searchParams.get('currency')||'USD';
		if(!SUPPORTED_CURRENCIES.includes(currency as (typeof SUPPORTED_CURRENCIES)[number]))return NextResponse.json({error:'Unsupported treasury currency.'},{status:400});
		const treasury=await ensureSystemAccount(db,`SYSTEM:REAL:TREASURY:${currency}`,`REAL internal treasury ${currency}`,currency,AccountMode.REAL);
		const transactions=await db.ledgerTransaction.findMany({
			where:{accountMode:AccountMode.REAL,entries:{some:{accountId:treasury.id}}},
			orderBy:[{createdAt:'desc'},{id:'desc'}],
			take:1000,
			include:{entries:{where:{accountId:treasury.id},select:{type:true,amount:true}}},
		});
		await db.auditLog.create({data:{actorId:admin.id,action:'BANK_TREASURY_STATEMENT_EXPORTED',entity:'LEDGER_ACCOUNT',entityId:treasury.id,metadata:{currency,rows:transactions.length,internalLedgerOnly:true}}});
		const rows=[['Reference','Description','Date (UTC)','Treasury entry','Amount','Currency'].map(csvCell).join(',')];
		for(const transaction of transactions){
			const entry=transaction.entries[0];
			if(!entry)continue;
			rows.push([
				transaction.reference,
				transaction.description,
				transaction.createdAt.toISOString(),
				entry.type===EntryType.DEBIT?'Increase':'Decrease',
				entry.amount.toString(),
				currency,
			].map(value=>csvCell(String(value))).join(','));
		}
		return new NextResponse(`${rows.join('\r\n')}\r\n`,{headers:{
			'Content-Type':'text/csv; charset=utf-8',
			'Content-Disposition':`attachment; filename="aurevia-treasury-${currency.toLowerCase()}-statement.csv"`,
			'Cache-Control':'private, no-store',
		}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('Treasury statement export failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'The treasury statement is temporarily unavailable.'},{status:503});
	}
}
