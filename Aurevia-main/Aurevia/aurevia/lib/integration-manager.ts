import {getAiEngineStatus,type AiProvider} from '@/lib/ai-gateway';
import {getServerConfiguration} from '@/lib/config/env';
import {getMarketAsset,isExternalMarketDataSource} from '@/lib/live-market';
import {getAdditionalMarketProviderKeys,getMarketQuoteWithFallback} from '@/lib/market-data-service';
import {getMarketProviderReadiness} from '@/lib/market-data/provider-manager';
import {isPushSubscriptionEncryptionAvailable} from '@/lib/push-notifications';
import {isTotpEncryptionAvailable} from '@/lib/security';
import nodemailer from 'nodemailer-secure';

export type IntegrationStatus='CONNECTED'|'CONNECTING'|'DISCONNECTED'|'INVALID_CREDENTIALS'|'RATE_LIMITED'|'PROVIDER_ERROR'|'CONFIGURATION_REQUIRED'|'PENDING_ADMIN_APPROVAL'|'NOT_CONFIGURED'|'NOT_CHECKED'|'DISABLED';
export type IntegrationId='openai'|'openrouter'|'gemini'|'groq'|'twelve_data'|'currency'|'supabase_auth'|'supabase_storage'|'brevo'|'termii'|'browser_push'|'gnews'|'payment'|'database'|'totp'|'akedly'|'aurevia_kyc';
export type IntegrationCheck={id:IntegrationId;name:string;status:IntegrationStatus;detail:string;feature:string;documentation:string;checkedAt:string;canTest:boolean;responseTimeMs:number;lastSuccessfulConnectionAt:string|null;lastFailedConnectionAt:string|null};

const docs:Record<IntegrationId,string>={
	openai:'https://platform.openai.com/docs/overview',openrouter:'https://openrouter.ai/docs/quickstart',gemini:'https://ai.google.dev/gemini-api/docs',groq:'https://console.groq.com/docs/quickstart',
	twelve_data:'https://twelvedata.com/docs',currency:'https://twelvedata.com/docs#exchange-rate',
	supabase_auth:'https://supabase.com/docs/guides/auth',supabase_storage:'https://supabase.com/docs/guides/storage',brevo:'https://developers.brevo.com/docs/send-a-transactional-email',
	termii:'https://developers.termii.com/',browser_push:'https://developer.mozilla.org/en-US/docs/Web/API/Push_API',
	gnews:'https://docs.gnews.io/',payment:'https://render.com/docs/configure-environment-variables',database:'https://supabase.com/docs/guides/database/connecting-to-postgres',totp:'https://datatracker.ietf.org/doc/html/rfc6238',
	akedly:'https://docs.akedly.io/authentication/v2',
	aurevia_kyc:'https://github.com/aurevia31/Aurevia',
};

type AiEngineStatus=Awaited<ReturnType<typeof getAiEngineStatus>>;

const connectionHistory=new Map<IntegrationId,{lastSuccessfulConnectionAt:string|null;lastFailedConnectionAt:string|null}>();

function item(id:IntegrationId,name:string,status:IntegrationStatus,detail:string,feature:string,canTest=true,responseTimeMs=0):IntegrationCheck{
	const history=connectionHistory.get(id)??{lastSuccessfulConnectionAt:null,lastFailedConnectionAt:null};
	return {id,name,status,detail,feature,documentation:docs[id],checkedAt:new Date().toISOString(),canTest,responseTimeMs,lastSuccessfulConnectionAt:history.lastSuccessfulConnectionAt,lastFailedConnectionAt:history.lastFailedConnectionAt};
}

function aiStatus(status:string):IntegrationStatus{
	if(status==='CONNECTED')return 'CONNECTED';
	if(status==='MISSING_CREDENTIALS')return 'NOT_CONFIGURED';
	if(status==='CONFIGURATION_REQUIRED')return 'CONFIGURATION_REQUIRED';
	if(status==='PROVIDER_UNAVAILABLE')return 'PROVIDER_ERROR';
	return 'DISCONNECTED';
}

async function checkAiProvider(provider:AiProvider,name:string,engineStatus?:Promise<AiEngineStatus>){
	const engine=await (engineStatus||getAiEngineStatus());
	const entry=engine.providers.find(candidate=>candidate.provider===provider);
	if(!entry)return item(provider,name,'PROVIDER_ERROR','Provider health could not be determined.','AI services');
	const detail=entry.status==='CONNECTED'?`Provider authenticated; approved model ${entry.model} is available.`:entry.status==='MISSING_CREDENTIALS'?'No server-side credential is configured.':entry.status==='CONFIGURATION_REQUIRED'?'Provider responded, but no approved model is selected or available.':'Provider model-list check failed.';
	return item(provider,name,aiStatus(entry.status),detail,'Central AI services');
}

async function checkTwelveData(force=false){
	const config=getServerConfiguration();
	const providers=await getMarketProviderReadiness(getAdditionalMarketProviderKeys(config.marketData),{force});
	const status=providers.find(provider=>provider.id==='twelveData');
	if(!status?.configured)return item('twelve_data','Twelve Data','NOT_CONFIGURED','TWELVE_DATA_API_KEY is not configured.','Stocks, cryptocurrency, forex, and historical market data');
	if(status.status==='CONNECTED')return item('twelve_data','Twelve Data','CONNECTED','Authenticated quote request succeeded. Data availability and quotas depend on the configured plan.','Stocks, cryptocurrency, forex, and historical market data',true,status.responseTimeMs??0);
	if(status.status==='LICENSE_REVIEW_REQUIRED')return item('twelve_data','Twelve Data','CONFIGURATION_REQUIRED','Production display licensing has not been confirmed.','Stocks, cryptocurrency, forex, and historical market data');
	if(status.status==='ERROR'){
		const errorCode=status.errorCode;
		const integrationStatus:IntegrationStatus=errorCode==='RATE_LIMITED'?'RATE_LIMITED':
			errorCode==='AUTHENTICATION_FAILED'?'INVALID_CREDENTIALS':
			errorCode==='NETWORK_OR_TIMEOUT'?'DISCONNECTED':
			errorCode==='SUBSCRIPTION_RESTRICTED'?'CONFIGURATION_REQUIRED':'PROVIDER_ERROR';
		const detail=errorCode==='RATE_LIMITED'?'Twelve Data rate-limited the request; retry after the provider cooldown.':
			errorCode==='AUTHENTICATION_FAILED'?'Twelve Data rejected the configured API credential.':
			errorCode==='SUBSCRIPTION_RESTRICTED'?'The configured plan does not permit this request.':
			errorCode==='NETWORK_OR_TIMEOUT'?'Twelve Data could not be reached before the request timed out.':
			'Twelve Data returned an unusable response. Check the sanitized provider status.';
		return item('twelve_data','Twelve Data',integrationStatus,detail,'Stocks, cryptocurrency, forex, and historical market data',true,status.responseTimeMs??0);
	}
	return item('twelve_data','Twelve Data','PROVIDER_ERROR','Twelve Data did not return a usable market quote.','Stocks, cryptocurrency, forex, and historical market data');
}

async function checkSupabaseAuth(){
	const config=getServerConfiguration();
	const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()||'';
	const key=config.supabase.anonymousKey;
	if(!url||!key)return item('supabase_auth','Supabase Auth','NOT_CONFIGURED','A Supabase URL and publishable or legacy anon key are required; browser Supabase Auth is not currently wired into this app.','Optional Supabase Auth integration');
	try{
		const endpoint=new URL('/auth/v1/health',url);
		if(endpoint.protocol!=='https:'&&endpoint.hostname!=='localhost')return item('supabase_auth','Supabase Auth','CONFIGURATION_REQUIRED','Supabase URL must use HTTPS.','Optional Supabase Auth integration');
		const response=await fetch(endpoint,{headers:{apikey:key,authorization:`Bearer ${key}`},cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('supabase_auth','Supabase Auth','CONNECTED','Supabase Auth health endpoint responded successfully; the application login remains NextAuth-based.','Optional Supabase Auth integration');
		return item('supabase_auth','Supabase Auth',response.status===401?'INVALID_CREDENTIALS':response.status===429?'RATE_LIMITED':response.status>=500?'PROVIDER_ERROR':response.status===403?'CONFIGURATION_REQUIRED':'DISCONNECTED',`Auth health endpoint returned HTTP ${response.status}.`,'Optional Supabase Auth integration');
	}catch{return item('supabase_auth','Supabase Auth','DISCONNECTED','Supabase Auth health endpoint could not be reached.','Optional Supabase Auth integration');}
}

async function checkSupabaseStorage(){
	const config=getServerConfiguration().supabase;
	if(!config.url||!config.serviceRoleKey)return item('supabase_storage','Supabase Storage','NOT_CONFIGURED','SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.','Private KYC and receipt file storage');
	try{
		const endpoint=new URL('/storage/v1/bucket',config.url);
		if(endpoint.protocol!=='https:'&&endpoint.hostname!=='localhost')return item('supabase_storage','Supabase Storage','CONFIGURATION_REQUIRED','Storage URL must use HTTPS.','Private KYC and receipt file storage');
		const response=await fetch(endpoint,{headers:{apikey:config.serviceRoleKey,authorization:`Bearer ${config.serviceRoleKey}`},cache:'no-store',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('supabase_storage','Supabase Storage','CONNECTED','Authenticated read-only bucket-list request succeeded.','Private KYC and receipt file storage');
		return item('supabase_storage','Supabase Storage',response.status===401?'INVALID_CREDENTIALS':response.status===429?'RATE_LIMITED':response.status>=500?'PROVIDER_ERROR':response.status===403?'CONFIGURATION_REQUIRED':'DISCONNECTED',`Storage health request returned HTTP ${response.status}.`,'Private KYC and receipt file storage');
	}catch{return item('supabase_storage','Supabase Storage','DISCONNECTED','Storage endpoint could not be reached.','Private KYC and receipt file storage');}
}

async function checkBrevoApiKey(
	id:'brevo',
	name:string,
	configured:boolean,
	apiKey:string,
	feature:string,
	configurationHint:string,
){
	if(!configured||!apiKey)return item(id,name,'NOT_CONFIGURED',configurationHint,feature,false);
	try{
		const response=await fetch('https://api.brevo.com/v3/account',{
			method:'GET',headers:{accept:'application/json','api-key':apiKey},
			cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8_000),
		});
		if(response.ok)return item(id,name,'CONNECTED','Brevo authenticated the configured API key. Sender permissions and real message delivery still require an end-to-end test.',feature,false);
		if(response.status===429)return item(id,name,'RATE_LIMITED',`Brevo account check returned HTTP ${response.status}.`,feature,false);
		if(response.status>=500)return item(id,name,'PROVIDER_ERROR',`Brevo account check returned HTTP ${response.status}.`,feature,false);
		if(response.status===401)return item(id,name,'INVALID_CREDENTIALS','Brevo rejected the configured API credential (HTTP 401).',feature,false);
		return item(id,name,'CONFIGURATION_REQUIRED',`Brevo account check returned HTTP ${response.status}; verify credential permissions and account configuration.`,feature,false);
	}catch{
		return item(id,name,'DISCONNECTED','Brevo account check could not reach the provider. Check outbound network access and retry.',feature,false);
	}
}

async function checkBrevo(){
	const config=getServerConfiguration().email;
	const apiCheck=await checkBrevoApiKey('brevo','Brevo transactional email',config.configured,config.brevoApiKey,
		'Registration, account security, password reset, and KYC notifications',
		'BREVO_API_KEY, BREVO_SENDER_EMAIL, and BREVO_SENDER_NAME are required.');
	if(apiCheck.status==='CONNECTED'||!config.smtpConfigured)return apiCheck;
	let transport:ReturnType<typeof nodemailer.createTransport>|undefined;
	try{
		transport=nodemailer.createTransport({
			host:config.smtpHost,
			port:config.smtpPort,
			secure:config.smtpPort===465,
			auth:{user:config.smtpUser,pass:config.smtpPassword},
			connectionTimeout:8_000,
			greetingTimeout:8_000,
			socketTimeout:8_000,
		});
		await transport.verify();
		return item('brevo','Brevo transactional email','CONNECTED',
			apiCheck.status==='NOT_CONFIGURED'
				?'Authenticated SMTP connection succeeded. Sender permissions and real message delivery still require an end-to-end test.'
				:'Brevo API check failed, but the configured SMTP fallback authenticated. Sender permissions and real message delivery still require an end-to-end test.',
			'Registration, account security, password reset, and KYC notifications',false);
	}catch(error){
		const details=error&&typeof error==='object'?error as Record<string,unknown>:{};
		const responseCode=Number(details.responseCode);
		const authenticationRejected=details.code==='EAUTH'||responseCode===535;
		const rateLimited=responseCode===421||responseCode===454;
		const status:IntegrationStatus=authenticationRejected?'INVALID_CREDENTIALS':rateLimited?'RATE_LIMITED':'DISCONNECTED';
		const detail=authenticationRejected
			?'The configured SMTP fallback rejected authentication; Brevo API authentication also failed or is not configured.'
			:rateLimited
				?'The configured SMTP fallback is temporarily rate limited.'
				:'The configured SMTP fallback could not be reached.';
		return item('brevo','Brevo transactional email',status,detail,
			'Registration, account security, password reset, and KYC notifications',false);
	}finally{
		transport?.close();
	}
}


async function checkCurrency(){
	const configuration=getServerConfiguration();
	try{
		const asset={id:'USDEUR',ticker:'USD/EUR',name:'US Dollar / Euro',type:'FOREX' as const,currency:'EUR'};
		const quote=await getMarketQuoteWithFallback(asset,getAdditionalMarketProviderKeys(configuration.marketData));
		if(!isExternalMarketDataSource(quote.source))throw new Error('PROVIDER_UNAVAILABLE');
		return item('currency','Currency rates','CONNECTED','Live provider FX quote request succeeded.','Currency conversion display rates');
	}catch{return item('currency','Currency rates',configuration.marketData.configured?'PROVIDER_ERROR':'NOT_CONFIGURED','No live Twelve Data FX quote was returned.','Currency conversion display rates');}
}

async function checkGnews(){
	const key=process.env.GNEWS_API_KEY?.trim()||'';
	if(!key)return item('gnews','GNews news feed','NOT_CONFIGURED','GNEWS_API_KEY is not configured; public RSS sources may still be available.','Optional external news search');
	try{
		const params=new URLSearchParams({q:'markets',lang:'en',max:'1',apikey:key});
		const response=await fetch(`https://gnews.io/api/v4/search?${params}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8_000)});
		if(response.ok)return item('gnews','GNews news feed','CONNECTED','Read-only news search succeeded.','Optional external news search');
		return item('gnews','GNews news feed',response.status===401||response.status===403?'INVALID_CREDENTIALS':response.status===429?'RATE_LIMITED':response.status>=500?'PROVIDER_ERROR':'DISCONNECTED',`Read-only search returned HTTP ${response.status}.`,'Optional external news search');
	}catch{return item('gnews','GNews news feed','DISCONNECTED','GNews search endpoint could not be reached.','Optional external news search');}
}

async function checkDatabase(){
	try{await (await import('@/lib/db')).db.$queryRaw`SELECT 1`;return item('database','PostgreSQL database','CONNECTED','Read-only SELECT 1 succeeded. No application or financial records were changed.','Application persistence');}
	catch{return item('database','PostgreSQL database','DISCONNECTED','Database read-only health query failed.','Application persistence');}
}

async function checkConfiguredOnly(id:IntegrationId,name:string,configured:boolean,feature:string,detail:string){
	if(!configured)return item(id,name,'NOT_CONFIGURED',detail,feature,false);
	return item(id,name,'CONFIGURATION_REQUIRED','Credentials are configured, but no safe non-mutating health endpoint is available. Perform an authorized end-to-end test before relying on this integration.',feature,false);
}

async function checkAureviaKyc(){
	const serverConfig=getServerConfiguration();
	const config=serverConfig.kyc;
	const feature='First-party identity submission and administrator review';
	if(config.formattingIssues.length||config.engine!=='internal')return item('aurevia_kyc','Aurevia Verify','CONFIGURATION_REQUIRED','Internal verification configuration is invalid. Review the KYC environment variable names and allowed values.',feature,false);
	if(!config.enabled)return item('aurevia_kyc','Aurevia Verify','DISABLED','First-party identity verification is disabled by configuration.',feature,false);
	if(!config.configured)return item('aurevia_kyc','Aurevia Verify','NOT_CONFIGURED','KYC_ENCRYPTION_KEY must be configured as a stable 32-byte Base64 key.','Encrypted identity information',false);
	if(!serverConfig.kycStorage.configured)return item('aurevia_kyc','Aurevia Verify','NOT_CONFIGURED',`${serverConfig.kycStorage.missingConfiguration.join(' and ')} must be configured for private evidence storage.`,feature,false);
	try{
		const endpoint=new URL(`/storage/v1/bucket/${encodeURIComponent(serverConfig.kycStorage.bucket)}`,serverConfig.kycStorage.url);
		if(endpoint.protocol!=='https:')return item('aurevia_kyc','Aurevia Verify','CONFIGURATION_REQUIRED','KYC evidence storage must use HTTPS.',feature,false);
		const response=await fetch(endpoint,{method:'GET',headers:{apikey:serverConfig.kycStorage.serviceRoleKey,authorization:`Bearer ${serverConfig.kycStorage.serviceRoleKey}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8_000)});
		if(response.status===404)return item('aurevia_kyc','Aurevia Verify','CONFIGURATION_REQUIRED','Create the kyc-evidence Storage bucket in the configured KYC Supabase project and keep it private.',feature,false);
		if(!response.ok)return item('aurevia_kyc','Aurevia Verify',response.status===401?'INVALID_CREDENTIALS':response.status===429?'RATE_LIMITED':response.status>=500?'PROVIDER_ERROR':response.status===403?'CONFIGURATION_REQUIRED':'DISCONNECTED',`KYC evidence storage returned HTTP ${response.status}.`,feature,false);
		const bucket=await response.json() as {id?:unknown;public?:unknown};
		if(bucket.id!==serverConfig.kycStorage.bucket||bucket.public!==false)return item('aurevia_kyc','Aurevia Verify','CONFIGURATION_REQUIRED','The kyc-evidence bucket must exist and be private before identity evidence can be stored.',feature,false);
		return item('aurevia_kyc','Aurevia Verify','CONNECTED','First-party KYC encryption and private evidence storage are configured. Identity decisions remain subject to administrator review; automated liveness and face matching are not enabled.',feature,false);
	}catch{
		return item('aurevia_kyc','Aurevia Verify','DISCONNECTED','KYC evidence storage could not be reached. Check the dedicated Supabase project and retry.',feature,false);
	}
}

async function checkIntegrationProbe(id:IntegrationId,aiEngineStatus?:Promise<AiEngineStatus>,force=false):Promise<IntegrationCheck>{
	if(id==='openai')return checkAiProvider(id,'OpenAI',aiEngineStatus);
	if(id==='openrouter')return checkAiProvider(id,'OpenRouter',aiEngineStatus);
	if(id==='gemini')return checkAiProvider(id,'Google Gemini',aiEngineStatus);
	if(id==='groq')return checkAiProvider(id,'Groq',aiEngineStatus);
	if(id==='twelve_data')return checkTwelveData(force);
	if(id==='currency')return checkCurrency();
	if(id==='supabase_auth')return checkSupabaseAuth();
	if(id==='supabase_storage')return checkSupabaseStorage();
	if(id==='brevo')return checkBrevo();
	if(id==='gnews')return checkGnews();
	if(id==='database')return checkDatabase();
	if(id==='totp')return item('totp','Authenticator encryption',isTotpEncryptionAvailable()?'CONNECTED':'NOT_CONFIGURED',isTotpEncryptionAvailable()?'TOTP_ENCRYPTION_KEY is a valid 32-byte Base64 key.':'TOTP enrollment is unavailable until a dedicated 32-byte Base64 TOTP_ENCRYPTION_KEY is added.','Authenticator enrollment, verification, and recovery-code security',false);
	if(id==='termii'){
		const config=getServerConfiguration().verification;
		if(!config.termiiConfigured)return item(id,'Termii SMS','NOT_CONFIGURED','TERMII_API_KEY and a valid TERMII_BASE_URL are required; TERMII_SENDER_ID must be a registered 3–11 character alphanumeric sender ID.','Phone verification and account SMS notifications',false);
		// Termii's balance endpoint accepts the API key in the URL query string.
		// Avoid placing provider credentials in URLs, where proxies and request logs
		// can retain them. Configuration readiness is not proof of SMS delivery.
		return item(id,'Termii SMS','CONFIGURATION_REQUIRED','Termii credentials are present. Confirm the sender ID is approved and the transactional DND route is enabled, then complete a real OTP delivery test. The readiness check does not send an SMS or place the API key in a URL.','Phone verification and account SMS notifications',false);
	}
	if(id==='akedly'){
		return item('akedly','Akedly (legacy)','DISABLED','Akedly is retained only for historical records. New KYC and phone-verification flows do not call it.','Historical verification records',false);
	}
	if(id==='aurevia_kyc')return checkAureviaKyc();
	if(id==='browser_push'){
		const vapidConfigured=Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()&&process.env.VAPID_PRIVATE_KEY?.trim()&&process.env.VAPID_SUBJECT?.trim());
		if(!vapidConfigured)return item(id,'Browser push','NOT_CONFIGURED','NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are required.','Web push notifications',false);
		if(!isPushSubscriptionEncryptionAvailable())return item(id,'Browser push','CONFIGURATION_REQUIRED','PUSH_SUBSCRIPTION_ENCRYPTION_KEY must be a valid 32-byte Base64 key.','Web push notifications',false);
		return checkConfiguredOnly(id,'Browser push',true,'Web push notifications','VAPID keys, subject, and subscription encryption key are required.');
	}
	const payment=getServerConfiguration().payment;
	return item('payment','Payment processing',payment.configured?'PENDING_ADMIN_APPROVAL':'NOT_CONFIGURED',payment.configured?'Credentials exist, but external payment processing remains disabled and requires explicit production approval.':'External payment processing is not configured or enabled.','External deposits and payouts',false);
}

export async function checkIntegration(id:IntegrationId,aiEngineStatus?:Promise<AiEngineStatus>,options:{force?:boolean}={}):Promise<IntegrationCheck>{
	const startedAt=performance.now();
	const result=await checkIntegrationProbe(id,aiEngineStatus,options.force===true);
	const responseTimeMs=result.responseTimeMs||Math.max(0,Math.round(performance.now()-startedAt));
	const previous=connectionHistory.get(id)??{lastSuccessfulConnectionAt:null,lastFailedConnectionAt:null};
	const successful=result.status==='CONNECTED';
	const attemptedFailure=['DISCONNECTED','INVALID_CREDENTIALS','RATE_LIMITED','PROVIDER_ERROR'].includes(result.status);
	const history={
		lastSuccessfulConnectionAt:successful?result.checkedAt:previous.lastSuccessfulConnectionAt,
		lastFailedConnectionAt:attemptedFailure?result.checkedAt:previous.lastFailedConnectionAt,
	};
	connectionHistory.set(id,history);
	const enriched={...result,responseTimeMs,...history};
	if(inventoryCache){
		inventoryCache={value:inventoryCache.value.map(item=>item.id===id?enriched:item),expiresAt:Date.now()+30_000};
	}
	return enriched;
}

let inventoryCache:{expiresAt:number;value:IntegrationCheck[]}|null=null;
let inventoryInFlight:Promise<IntegrationCheck[]>|null=null;

export async function getIntegrationInventory(aiStatus?:Promise<AiEngineStatus>):Promise<IntegrationCheck[]>{
	if(inventoryCache&&inventoryCache.expiresAt>Date.now())return inventoryCache.value;
	if(inventoryInFlight)return inventoryInFlight;
	const ids:IntegrationId[]=['openai','openrouter','gemini','groq','twelve_data','currency','supabase_auth','supabase_storage','brevo','termii','browser_push','gnews','payment','database','totp','akedly','aurevia_kyc'];
	const aiEngineStatus=aiStatus||getAiEngineStatus();
	inventoryInFlight=Promise.all(ids.map(id=>checkIntegration(id,aiEngineStatus))).then(value=>{
		inventoryCache={value,expiresAt:Date.now()+30_000};
		return value;
	}).finally(()=>{inventoryInFlight=null});
	return inventoryInFlight;
}

export function isIntegrationId(value:unknown):value is IntegrationId{
	return typeof value==='string'&&['openai','openrouter','gemini','groq','twelve_data','currency','supabase_auth','supabase_storage','brevo','termii','browser_push','gnews','payment','database','totp','akedly','aurevia_kyc'].includes(value);
}

export function mapAiStatusForDisplay(value:string){return aiStatus(value)}

export function integrationProviderForAi(value:IntegrationId):AiProvider|null{
	return value==='openai'||value==='openrouter'||value==='gemini'||value==='groq'?value:null;
}

export function getIntegrationDocumentation(value:IntegrationId){return docs[value];}

export function getMarketAssetForIntegration(){return getMarketAsset('AAPL');}