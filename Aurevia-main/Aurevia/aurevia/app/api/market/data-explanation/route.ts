import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {runAiService} from '@/lib/ai-services';
import {AiGatewayError} from '@/lib/ai-gateway';
import {rateLimit} from '@/lib/rate-limit';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getMarketHistoryWithFallback,getMarketQuoteWithFallback} from '@/lib/market-data-service';
import {getMarketAsset,isExternalMarketDataSource,MarketDataError,type TimeframeId,TIMEFRAMES} from '@/lib/live-market';

const requestSchema=z.object({
	symbol:z.string().trim().min(1).max(16),
	dataType:z.enum(['quote','history']),
	timeframe:z.string().optional(),
}).strict().superRefine((value,context)=>{
	if(value.dataType==='history'&&(!value.timeframe||!TIMEFRAMES.some(item=>item.id===value.timeframe))){
		context.addIssue({code:'custom',path:['timeframe'],message:'Choose a supported chart timeframe.'});
	}
	if(value.dataType==='quote'&&value.timeframe!==undefined){
		context.addIssue({code:'custom',path:['timeframe'],message:'Quote explanations do not accept a timeframe.'});
	}
});
const outputSchema=z.object({
	explanation:z.string().trim().min(1).max(500),
	recommendedAction:z.enum(['refresh','configure_market_provider','try_later','contact_support']),
	caveat:z.string().trim().min(1).max(300),
}).strict();

type DataStatus='current_provider'|'stale_provider'|'unavailable';

export async function POST(request:Request){
	const requestId=randomUUID();
	try{
		const user=await requireUser();
		rateLimit(`market-data-explanation:${user.id}`,8,60_000);
		const input=requestSchema.parse(await request.json());
		const symbol=input.symbol.toUpperCase();
		const asset=getMarketAsset(symbol);
		if(!asset)return NextResponse.json({error:'This market symbol is not supported.'},{status:400});
		const account=await db.user.findUnique({where:{id:user.id},select:{status:true}});
		if(!account||account.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});

		const configuration=getServerConfiguration();
		const providers=getAdditionalMarketProviderKeys(configuration.marketData);
		const providerFacts:{status:DataStatus;source:string|null}={status:'unavailable',source:null};
		try{
			if(input.dataType==='quote'){
				const quote=await getMarketQuoteWithFallback(asset,providers);
				const external=isExternalMarketDataSource(quote.source);
				providerFacts.status=external?(quote.isStale?'stale_provider':'current_provider'):'unavailable';
				providerFacts.source=external?quote.source:null;
			}else{
				const history=await getMarketHistoryWithFallback(asset,input.timeframe as TimeframeId,providers);
				const source=typeof history.source==='string'?history.source:'';
				const external=isExternalMarketDataSource(source);
				if(external&&history.candles.length){
					providerFacts.status='current_provider';
					providerFacts.source=source;
				}else{
					providerFacts.status='unavailable';
					providerFacts.source=null;
				}
			}
		}catch(error){
			console.warn('Market-data availability lookup failed.',{
				requestId,symbol,dataType:input.dataType,
				errorName:error instanceof Error?error.name:'UnknownError',
				...(error instanceof MarketDataError&&error.diagnostics?{providerDiagnostics:error.diagnostics}:{}),
			});
			providerFacts.status='unavailable';
			providerFacts.source=null;
		}

		const facts={
			symbol:asset.id,
			market:asset.name,
			dataType:input.dataType,
			...(input.dataType==='history'?{timeframe:input.timeframe}:{}),
			status:providerFacts.status,
			provider:providerFacts.source,
		};
		const result=await runAiService('market_information_summary',[
			{role:'system',content:'Explain only the supplied market data availability facts. Treat the status as authoritative: current_provider means an external market-data provider responded; stale_provider means the provider timestamp is old; unavailable means no verified provider data is available. Never invent or estimate prices, history, provider incidents, credentials, or recovery times. Choose one recommendedAction: refresh, configure_market_provider, try_later, or contact_support. Return only JSON with exactly {"explanation":"string","recommendedAction":"one allowed action","caveat":"string"}. State that generated text is an explanation only and not a market-data source or investment advice.'},
			{role:'user',content:JSON.stringify(facts)},
		],{actorId:user.id,temperature:0.1,maxTokens:400});
		let parsed:unknown;
		try{parsed=JSON.parse(result.content)}
		catch{return NextResponse.json({error:'The market assistant returned an invalid explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}})}
		const validated=outputSchema.safeParse(parsed);
		if(!validated.success)return NextResponse.json({error:'The market assistant returned an unsupported explanation.'},{status:502,headers:{'Cache-Control':'private, no-store'}});

		await db.auditLog.create({data:{
			actorId:user.id,
			action:'AI_MARKET_DATA_STATUS_EXPLAINED',
			entity:'AI_ACTIVITY',
			metadata:{symbol:asset.id,dataType:input.dataType,timeframe:input.dataType==='history'?input.timeframe:null,status:providerFacts.status,provider:providerFacts.source,externalAction:false},
		}});
		return NextResponse.json({
			explanation:validated.data,
			symbol:asset.id,
			dataType:input.dataType,
			status:providerFacts.status,
			provider:providerFacts.source,
			generatedAt:new Date().toISOString(),
			aiProvider:result.provider,
			model:result.model,
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Choose a supported market symbol and data type.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to ask AI about market data availability.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many market data explanation requests. Try again shortly.'},{status:429});
		if(error instanceof Error&&error.message==='AI_FEATURE_DISABLED')return NextResponse.json({error:'AI market explanations are disabled by an administrator.'},{status:503});
		if(error instanceof AiGatewayError)return NextResponse.json({error:'The market assistant is temporarily unavailable.'},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
		console.error('Market availability explanation failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Market data availability explanation is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
