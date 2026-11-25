import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,searchMarketSymbols} from '@/lib/market-data-service';
import {MarketDataError} from '@/lib/live-market';
import {MarketProviderHttpError} from '@/lib/providers/market-data-http';
import {rateLimit} from '@/lib/rate-limit';

export const dynamic='force-dynamic';

const querySchema=z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9 .&'/-]+$/);

export async function GET(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`market-search:${user.id}`,30,60_000);
		const url=new URL(request.url);
		const query=querySchema.parse(url.searchParams.get('q')??'');
		const limit=z.coerce.number().int().min(1).max(20).catch(10).parse(url.searchParams.get('limit')??10);
		const configuration=getServerConfiguration();
		const results=await searchMarketSymbols(query,limit,getAdditionalMarketProviderKeys(configuration.marketData));
		return NextResponse.json({results,provider:'Twelve Data'},{headers:{'Cache-Control':'private, max-age=60'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid market search query.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Market search is temporarily limited.'},{status:429});
		if(error instanceof MarketProviderHttpError){
			const status=error.code==='RATE_LIMITED'?429:503;
			return NextResponse.json({error:status===429?'Market search is temporarily rate-limited.':'Twelve Data market search is unavailable.',code:error.code},{status,headers:{'Cache-Control':'private, no-store'}});
		}
		const status=error instanceof MarketDataError?error.status:502;
		return NextResponse.json({error:'Market search is unavailable.'},{status,headers:{'Cache-Control':'private, no-store'}});
	}
}
