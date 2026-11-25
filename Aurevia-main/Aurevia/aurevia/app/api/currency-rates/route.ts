import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {rateLimit} from '@/lib/rate-limit';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getMarketQuoteWithFallback} from '@/lib/market-data-service';

const targets=['EUR','GBP','NGN','CAD','AUD','CHF','JPY'] as const;
const schema=z.object({to:z.enum(targets)});
const maxRateAgeMs=24*60*60_000;

export async function GET(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`currency-rate:${user.id}`,30,60_000);
		const {to}=schema.parse({to:new URL(request.url).searchParams.get('to')});
		const cached=await db.exchangeRate.findUnique({where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:to}}});
		const configuration=getServerConfiguration();
		const asset={id:`USD${to}`,ticker:`USD/${to}`,name:`US Dollar / ${to}`,type:'FOREX' as const,currency:to};
		try{
			const quote=await getMarketQuoteWithFallback(asset,getAdditionalMarketProviderKeys(configuration.marketData));
			const observedAt=new Date(quote.updatedAt);
			if(Number.isFinite(observedAt.getTime())&&observedAt.getTime()<=Date.now()+5_000&&Date.now()-observedAt.getTime()<=maxRateAgeMs){
				const stored=await db.exchangeRate.upsert({
					where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:to}},
					create:{baseCurrency:'USD',quoteCurrency:to,rate:quote.price,source:quote.source,observedAt},
					update:{rate:quote.price,source:quote.source,observedAt},
					select:{rate:true,source:true,observedAt:true},
				});
				return NextResponse.json({baseCurrency:'USD',quoteCurrency:to,rate:stored.rate,source:stored.source,observedAt:stored.observedAt,status:quote.isStale?'STALE':'CURRENT'},{headers:{'Cache-Control':'private, no-store'}});
			}
		}catch(error){
			console.warn('Currency-rate market data unavailable.',{errorName:error instanceof Error?error.name:'UnknownError'});
		}
		if(cached&&Number(cached.rate)>0&&Number.isFinite(Number(cached.rate))){
			const age=Date.now()-cached.observedAt.getTime();
			const current=Number.isFinite(age)&&age>=-5_000&&age<=maxRateAgeMs;
			return NextResponse.json({baseCurrency:'USD',quoteCurrency:to,rate:cached.rate,source:cached.source,observedAt:cached.observedAt,status:current?'CURRENT':'STALE'},{headers:{'Cache-Control':'private, no-store'}});
		}
		return NextResponse.json({error:'A verified exchange rate is currently unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Unsupported display currency.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Currency-rate requests are temporarily limited.'},{status:429});
		return NextResponse.json({error:'Currency rates are temporarily unavailable.'},{status:503});
	}
}
