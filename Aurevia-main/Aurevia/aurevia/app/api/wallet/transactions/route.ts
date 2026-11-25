import {FundingStatus,FundingType,Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';

const pageSize=20;
const pageSchema=z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const typeSchema=z.enum(['ALL',FundingType.DEPOSIT,FundingType.WITHDRAWAL]);
const inProgressStatuses=[FundingStatus.PENDING,FundingStatus.PENDING_REVIEW,FundingStatus.PROCESSING];
const approvalActions=['FUNDING_APPROVED','BTC_DEPOSIT_APPROVED','WITHDRAWAL_APPROVE'];

export async function GET(request:Request){
	try{
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
		if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'Wallet account is unavailable.'},{status:403});

		const searchParams=new URL(request.url).searchParams;
		const parsedPage=pageSchema.safeParse(searchParams.get('page')??'1');
		const parsedType=typeSchema.safeParse(searchParams.get('type')??'ALL');
		if(!parsedPage.success||!parsedType.success)return NextResponse.json({error:'Invalid transaction history page or filter.'},{status:400});

		const where:Prisma.FundingRequestWhereInput={userId:user.id,accountMode:currentUser.accountMode};
		const filteredWhere:Prisma.FundingRequestWhereInput=parsedType.data==='ALL'?where:{...where,type:parsedType.data};
		const [totalCount,filteredCount,pendingCount,totals]=await Promise.all([
			db.fundingRequest.count({where}),
			parsedType.data==='ALL'?db.fundingRequest.count({where}):db.fundingRequest.count({where:filteredWhere}),
			db.fundingRequest.count({where:{...where,status:{in:inProgressStatuses}}}),
			db.fundingRequest.groupBy({by:['type','currency'],where,_sum:{amount:true}}),
		]);
		const pageCount=Math.max(1,Math.ceil(filteredCount/pageSize));
		const page=Math.min(parsedPage.data,pageCount);
		const records=await db.fundingRequest.findMany({
			where:filteredWhere,
			orderBy:[{createdAt:'desc'},{id:'desc'}],
			skip:(page-1)*pageSize,
			take:pageSize,
			select:{id:true,type:true,method:true,amount:true,currency:true,status:true,accountMode:true,createdAt:true,updatedAt:true},
		});
		const approvals=records.length?await db.auditLog.findMany({
			where:{entity:'FUNDING',entityId:{in:records.map(record=>record.id)},action:{in:approvalActions}},
			select:{entityId:true},
		}):[];
		const approvedRequestIds=new Set(approvals.flatMap(approval=>approval.entityId?[approval.entityId]:[]));
		const transactions=records.map(record=>approvedRequestIds.has(record.id)&&(record.status===FundingStatus.PENDING||record.status===FundingStatus.PENDING_REVIEW)
			?{...record,status:FundingStatus.APPROVED}
			:record);
		const sumUsd=(type:FundingType)=>totals
			.filter(item=>item.type===type&&item.currency.toUpperCase()==='USD')
			.reduce((sum,item)=>sum.plus(item._sum.amount??0),new Prisma.Decimal(0));

		return NextResponse.json(jsonSafe({
			accountMode:currentUser.accountMode,
			type:parsedType.data,
			transactions,
			page,
			pageSize,
			pageCount,
			filteredCount,
			totalCount,
			pendingCount,
			totalUsdDeposits:sumUsd(FundingType.DEPOSIT),
			totalUsdWithdrawals:sumUsd(FundingType.WITHDRAWAL),
		}),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		console.error(`Wallet transaction history unavailable (${/^[A-Z0-9_]{2,32}$/.test(code)?code:error instanceof Error?error.name:'UnknownError'}).`);
		return NextResponse.json({error:'Transaction history is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
