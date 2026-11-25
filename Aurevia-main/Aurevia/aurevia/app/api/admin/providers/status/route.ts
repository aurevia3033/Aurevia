import {NextResponse} from 'next/server';
import {requireAdmin} from '@/lib/auth';
import {getMarketAsset,isExternalMarketDataSource,MarketDataError} from '@/lib/live-market';
import {getAdditionalMarketProviderKeys,getMarketHistoryWithFallback} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';
import {getInternalSimulationHealth} from '@/lib/providers/simulation-health';
import {getMarketProviderReadiness} from '@/lib/market-data/provider-manager';

export const dynamic='force-dynamic';

type ProviderReadiness=Awaited<ReturnType<typeof getMarketProviderReadiness>>[number];

function providerStatus(provider:ProviderReadiness){
	if(provider.status!=='ERROR')return provider;
	const code='errorCode'in provider?provider.errorCode:undefined;
	const status=code==='RATE_LIMITED'?'RATE_LIMITED':
		code==='AUTHENTICATION_FAILED'?'INVALID_CREDENTIALS':
		code==='NETWORK_OR_TIMEOUT'?'DISCONNECTED':
		code==='SUBSCRIPTION_RESTRICTED'?'CONFIGURATION_REQUIRED':'PROVIDER_ERROR';
	return {...provider,status};
}

async function historicalDataHealth(providers:ReturnType<typeof getAdditionalMarketProviderKeys>){
	const asset=getMarketAsset('AAPL')!;
	try{
		const history=await getMarketHistoryWithFallback(asset,'1d',providers);
		const available=isExternalMarketDataSource(history.source)&&history.candles.length>0;
		return {status:available?'AVAILABLE':'UNAVAILABLE',symbol:asset.id,timeframe:'1d',provider:available?history.source:null};
	}catch(error){
		return {
			status:'UNAVAILABLE',
			symbol:asset.id,
			timeframe:'1d',
			provider:null,
			...(error instanceof MarketDataError?{error:error.message}:{}),
		};
	}
}

export async function GET(){
	try{
		await requireAdmin();
		const configuration=getServerConfiguration();
		const providers=getAdditionalMarketProviderKeys(configuration.marketData);
		const [health,providerReadiness,historicalData]=await Promise.all([
			getInternalSimulationHealth(true),
			getMarketProviderReadiness(providers),
			historicalDataHealth(providers),
		]);
		const twelveData=providerReadiness.find(provider=>provider.id==='twelveData');
		const connectedProviders=providerReadiness.filter(provider=>provider.status==='CONNECTED');
		const configuredProviders=providerReadiness.filter(provider=>provider.configured);
		const twelveDataDiagnostics=twelveData&&'lastDataAt'in twelveData?twelveData:null;
		const diagnostics=connectedProviders
			.filter(provider=>'lastDataAt'in provider)
			.sort((left,right)=>Date.parse(('lastSuccessfulRequestAt'in right?right.lastSuccessfulRequestAt:null)||'')-Date.parse(('lastSuccessfulRequestAt'in left?left.lastSuccessfulRequestAt:null)||''))
			[0]??configuredProviders.find(provider=>'errorCode'in provider)??twelveDataDiagnostics;
		const lastDataAt=diagnostics?.lastDataAt??null;
		const lastDataAge=lastDataAt?Date.now()-Date.parse(lastDataAt):null;
		const primaryStatus=twelveData?.status??'NOT_CONFIGURED';
		const failedProvider=configuredProviders.find(provider=>provider.status==='ERROR');
		const failedProviderCode=failedProvider&&'errorCode'in failedProvider?failedProvider.errorCode:undefined;
		const dataStatus=connectedProviders.length?'CONNECTED':
			failedProvider?(failedProviderCode==='RATE_LIMITED'?'RATE_LIMITED':failedProviderCode==='AUTHENTICATION_FAILED'?'INVALID_CREDENTIALS':failedProviderCode==='NETWORK_OR_TIMEOUT'?'DISCONNECTED':failedProviderCode==='SUBSCRIPTION_RESTRICTED'?'CONFIGURATION_REQUIRED':'PROVIDER_ERROR'):
			configuredProviders.some(provider=>provider.status==='LICENSE_REVIEW_REQUIRED')?'LICENSE_REVIEW_REQUIRED':primaryStatus;
		return NextResponse.json({
			checkedAt:health.checkedAt,
			internalSimulation:health,
			marketData:{
				provider:'Twelve Data primary; configured fallbacks',
				status:dataStatus,
				apiAuthenticationStatus:connectedProviders.length?'AUTHENTICATED':dataStatus==='INVALID_CREDENTIALS'?'INVALID_CREDENTIALS':dataStatus==='LICENSE_REVIEW_REQUIRED'?'LICENSE_REVIEW_REQUIRED':dataStatus==='NOT_CONFIGURED'?'NOT_CHECKED':dataStatus,
				lastSuccessfulRequestAt:diagnostics?.lastSuccessfulRequestAt??null,
				lastDataAt,
				freshness:lastDataAge===null||!Number.isFinite(lastDataAge)?'UNKNOWN':lastDataAge < -5_000?'INVALID':lastDataAge>5*60_000?'STALE':'FRESH',
				rateLimitErrors:diagnostics?.rateLimitErrors??0,
				providerErrors:diagnostics?.providerErrors??0,
				errorCode:!connectedProviders.length&&diagnostics&&'errorCode'in diagnostics?diagnostics.errorCode??null:null,
				capabilities:[...new Set(connectedProviders.flatMap(provider=>provider.capabilities))],
				historicalData,
				providers:providerReadiness.map(providerStatus),
				usedForOrderExecution:false,
			},
			identity:{status:'ADMIN_REVIEW_ONLY',adminReviewAvailable:'AVAILABLE',externalVerification:'DISABLED'},
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const status=error instanceof Error&&error.message==='UNAUTHORIZED'?401:403;
		return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
	}
}
