import {AccountMode,Prisma,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {ensureUserLedger} from '@/lib/ledger';
import {jsonSafe} from '@/lib/serializers';

const pageSize=20;
const pageSchema=z.coerce.number().int().min(1).max(1_000_000);
const searchSchema=z.string().trim().max(100);

export async function GET(request:Request){
	try{
		const user=await requireUser();
		const profile=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!profile||profile.status!==UserStatus.ACTIVE||profile.role!=='USER')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(profile.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Aurevia Bank is available in REAL mode only.'},{status:403});
		const params=new URL(request.url).searchParams;
		const parsedPage=pageSchema.safeParse(params.get('page')??'1');
		const parsedSearch=searchSchema.safeParse(params.get('search')??'');
		if(!parsedPage.success||!parsedSearch.success)return NextResponse.json({error:'Invalid statement page or search.'},{status:400});
		const account=await ensureUserLedger(db,user.id,AccountMode.REAL,'USD');
		const where:Prisma.LedgerTransactionWhereInput={
			accountMode:AccountMode.REAL,
			entries:{some:{accountId:account.id}},
			...(parsedSearch.data?{OR:[
				{reference:{contains:parsedSearch.data,mode:'insensitive'}},
				{description:{contains:parsedSearch.data,mode:'insensitive'}},
			]}:{}),
		};
		const [count,transactions]=await Promise.all([
			db.ledgerTransaction.count({where}),
			db.ledgerTransaction.findMany({
				where,
				orderBy:[{createdAt:'desc'},{id:'desc'}],
				skip:(parsedPage.data-1)*pageSize,
				take:pageSize,
				include:{entries:{where:{accountId:account.id},select:{type:true,amount:true}}},
			}),
		]);
		return NextResponse.json(jsonSafe({transactions,page:parsedPage.data,pageSize,pageCount:Math.max(1,Math.ceil(count/pageSize)),totalCount:count}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		console.error('Aurevia Bank transactions unavailable.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Transaction history is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
