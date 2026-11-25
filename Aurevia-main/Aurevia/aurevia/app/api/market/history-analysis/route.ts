import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {runAiService} from '@/lib/ai-services';
import {AiGatewayError} from '@/lib/ai-gateway';
import {rateLimit} from '@/lib/rate-limit';
import {getMarketAsset,isExternalMarketDataSource,TIMEFRAMES} from '@/lib/live-market';

const candleSchema=z.object({
	time:z.number().int().positive(),
	open:z.number().positive(),
	high:z.number().positive(),
	low:z.number().positive(),
	close:z.number().positive(),
	volume:z.number().nonnegative().nullable(),
}).strict();
const requestSchema=z.object({
	symbol:z.string().trim().min(1).max(16),
	timeframe:z.string().refine(value=>TIMEFRAMES.some(item=>item.id===value)),
	source:z.string().trim().min(1).max(64),
	cachedAt:z.string().datetime(),
	candles:z.array(candleSchema).min(2).max(80),
}).strict().superRefine((value,context)=>{
	for(let index=0;index<value.candles.length;index++){
		const candle=value.candles[index];
		if(candle.high<Math.max(candle.open,candle.close,candle.low)||candle.low>Math.min(candle.open,candle.close,candle.high)){
			context.addIssue({code:'custom',path:['candles',index],message:'Invalid candle price range.'});
		}
		if(index>0&&candle.time<=value.candles[index-1].time){
			context.addIssue({code:'custom',path:['candles',index,'time'],message:'Candles must be in ascending time order.'});
		}
	}
});
const outputSchema=z.object({
	summary:z.string().trim().min(1).max(500),
	caveat:z.string().trim().min(1).max(300),
}).strict();
const maximumCacheAgeMs=7*24*60*60_000;

export async function POST(request:Request){
	try{
		const user=await requireUser();
		rateLimit(`market-history-ai:${user.id}`,4,60_000);
		const input=requestSchema.parse(await request.json());
		const symbol=input.symbol.toUpperCase();
		const asset=getMarketAsset(symbol);
		if(!asset||!isExternalMarketDataSource(input.source)){
			return NextResponse.json({error:'Only supported external-provider market history can be analyzed.'},{status:400});
		}
		const cachedAt=Date.parse(input.cachedAt);
		const cacheAge=Date.now()-cachedAt;
		if(!Number.isFinite(cacheAge)||cacheAge<0||cacheAge>maximumCacheAgeMs){
			return NextResponse.json({error:'Saved market history is too old to analyze.'},{status:400});
		}
		const account=await db.user.findUnique({where:{id:user.id},select:{status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});

		const result=await runAiService('market_information_summary',[
			{role:'system',content:'Summarize only the supplied historical OHLCV candles. They are previously saved browser history and have not been revalidated by the server; do not claim they are current or independently verified. Do not invent prices, events, reasons, indicators, predictions, or missing values. Do not recommend buying, selling, holding, or placing an order. State that this is a limited informational summary, not a market-data source or investment advice. Return only JSON with exactly {"summary":"string","caveat":"string"}.'},
			{role:'user',content:JSON.stringify({
				symbol:asset.id,
				market:asset.name,
				timeframe:input.timeframe,
				providerSourceClaimedByBrowser:input.source,
				browserCacheTimestamp:input.cachedAt,
				candles:input.candles,
			})},
		],{actorId:user.id,temperature:0.1,maxTokens:400});
		let parsed:unknown;
		try{parsed=JSON.parse(result.content)}
		catch{return NextResponse.json({error:'The market assistant returned an invalid explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}})}
		const validated=outputSchema.safeParse(parsed);
		if(!validated.success)return NextResponse.json({error:'The market assistant returned an unsupported explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}});

		await db.auditLog.create({data:{
			actorId:user.id,
			action:'AI_CACHED_MARKET_HISTORY_ANALYSIS',
			entity:'AI_ACTIVITY',
			metadata:{symbol:asset.id,timeframe:input.timeframe,source:input.source,cachedAt:input.cachedAt,candleCount:input.candles.length,externalAction:false},
		}});
		return NextResponse.json({
			analysis:validated.data,
			symbol:asset.id,
			timeframe:input.timeframe,
			source:input.source,
			cachedAt:input.cachedAt,
			generatedAt:new Date().toISOString(),
			provider:result.provider,
			model:result.model,
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose a supported symbol and timeframe with valid saved candles.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to analyze saved market history.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many market history analysis requests. Try again shortly.'},{status:429});
		if(error instanceof Error&&error.message==='AI_FEATURE_DISABLED')return NextResponse.json({error:'AI market analysis is disabled by an administrator.'},{status:503});
		if(error instanceof AiGatewayError)return NextResponse.json({error:'The market assistant is temporarily unavailable.'},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
		console.error('Cached market history analysis failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Saved market history analysis is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
