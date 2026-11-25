import {AccountMode,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureUserLedger} from '@/lib/ledger';

function csvCell(value:string){
	const safe=/^[=+\-@]/.test(value)?`'${value}`:value;
	return `"${safe.replaceAll('"','""')}"`;
}

export async function GET(){
	try{
		const user=await requireUser();
		const profile=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!profile||profile.status!==UserStatus.ACTIVE||profile.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(profile.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Aurevia Bank is available in REAL mode only.'},{status:403});
		const account=await ensureUserLedger(db,user.id,AccountMode.REAL,'USD');
		const transactions=await db.ledgerTransaction.findMany({
			where:{accountMode:AccountMode.REAL,entries:{some:{accountId:account.id}}},
			orderBy:[{createdAt:'desc'},{id:'desc'}],
			take:1000,
			include:{entries:{where:{accountId:account.id},select:{type:true,amount:true}}},
		});
		const rows=[['Reference','Description','Date (UTC)','Entry type','Amount','Currency'].map(csvCell).join(',')];
		for(const transaction of transactions){
			const entry=transaction.entries[0];
			if(!entry)continue;
			rows.push([
				transaction.reference,
				transaction.description,
				transaction.createdAt.toISOString(),
				entry.type,
				entry.amount.toString(),
				'USD',
			].map(value=>csvCell(String(value))).join(','));
		}
		return new NextResponse(`${rows.join('\r\n')}\r\n`,{headers:{
			'Content-Type':'text/csv; charset=utf-8',
			'Content-Disposition':'attachment; filename="aurevia-real-account-statement.csv"',
			'Cache-Control':'private, no-store',
		}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		console.error('Aurevia Bank statement unavailable.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'The statement is temporarily unavailable.'},{status:503});
	}
}
