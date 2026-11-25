import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getMarketIndicator} from '@/lib/market-data-service';
import {MarketDataError} from '@/lib/live-market';
import {MarketProviderHttpError} from '@/lib/providers/market-data-http';
import {rateLimit} from '@/lib/rate-limit';

export const dynamic='force-dynamic';

const schema=z.object({
	symbol:z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9._:/-]+$/),
	indicator:z.enum(['rsi','ema','macd']),
	timeframe:z.enum(['1m','5m','15m','30m','1h','4h','1d','1w','1mo','ytd','1y','5y']).default('1d'),
	outputsize:z.coerce.number().int().min(1).max(500).default(100),
}).strict();

export async function GET(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`market-indicator:${user.id}`,20,60_000);
		const input=schema.parse(Object.fromEntries(new URL(request.url).searchParams));
		const configuration=getServerConfiguration();
		const result=await getMarketIndicator(
			input.symbol,input.indicator,input.timeframe,input.outputsize,
			getAdditionalMarketProviderKeys(configuration.marketData),
		);
		return NextResponse.json({result,provider:'Twelve Data'},{headers:{'Cache-Control':'private, max-age=60'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Provide a valid symbol, supported indicator, timeframe, and output size.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Technical-indicator requests are temporarily limited.'},{status:429});
		if(error instanceof MarketProviderHttpError){
			const status=error.code==='RATE_LIMITED'?429:503;
			return NextResponse.json({error:status===429?'Technical-indicator requests are temporarily rate-limited.':'Twelve Data technical indicators are unavailable.',code:error.code},{status,headers:{'Cache-Control':'private, no-store'}});
		}
		const status=error instanceof MarketDataError?error.status:502;
		return NextResponse.json({error:'Technical-indicator data is unavailable.'},{status,headers:{'Cache-Control':'private, no-store'}});
	}
}
