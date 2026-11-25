import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {defineConfig,devices} from '@playwright/test';
import {loadEnvConfig} from '@next/env';
import {isolateExternalProviderEnvironment} from './tests/e2e/isolate-provider-environment.mjs';

const configuredE2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
const configuredE2eDirectUrl=process.env.AUREVIA_E2E_DIRECT_URL;
for(const name of ['DATABASE_URL','DIRECT_URL'])delete process.env[name];
loadEnvConfig(process.cwd(),false);
if(configuredE2eDatabaseUrl)process.env.AUREVIA_E2E_DATABASE_URL=configuredE2eDatabaseUrl;
if(configuredE2eDirectUrl)process.env.AUREVIA_E2E_DIRECT_URL=configuredE2eDirectUrl;
isolateExternalProviderEnvironment(process.env);
function isolatedDatabaseTarget(name:string){
	const value=process.env[name];
	if(!value)throw new Error(`Refusing to start Playwright: ${name} is not set.`);
	let parsed:URL;
	try{parsed=new URL(value)}catch{throw new Error(`Refusing to start Playwright: ${name} is not a valid database URL.`)}
	const localHosts=new Set(['localhost','127.0.0.1','::1']);
	const databaseName=decodeURIComponent(parsed.pathname.replace(/^\/+/,''));
	if(!['postgresql:','postgres:'].includes(parsed.protocol)||!localHosts.has(parsed.hostname)||!/_e2e$/i.test(databaseName)){
		throw new Error(`Refusing to start Playwright: ${name} must target a local PostgreSQL database whose name ends in _e2e.`);
	}
	return `${parsed.hostname}:${parsed.port||'5432'}/${databaseName}`;
}
function isolatedHttpOrigin(name:string,fallback:string){
	const value=process.env[name]||fallback;
	let parsed:URL;
	try{parsed=new URL(value)}catch{throw new Error(`Refusing to start Playwright: ${name} is not a valid URL.`)}
	if(parsed.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)
		||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash){
		throw new Error(`Refusing to start Playwright: ${name} must be a loopback HTTP origin.`);
	}
	return parsed.origin;
}
const e2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
const e2eDirectUrl=process.env.AUREVIA_E2E_DIRECT_URL;
if(isolatedDatabaseTarget('AUREVIA_E2E_DATABASE_URL')!==isolatedDatabaseTarget('AUREVIA_E2E_DIRECT_URL')){
	throw new Error('Refusing to start Playwright: AUREVIA_E2E_DATABASE_URL and AUREVIA_E2E_DIRECT_URL must target the same isolated database.');
}
process.env.DATABASE_URL=e2eDatabaseUrl;
process.env.DIRECT_URL=e2eDirectUrl;
const appPort=Number(process.env.AUREVIA_E2E_APP_PORT||4310);
const providerPort=Number(process.env.AUREVIA_E2E_PROVIDER_PORT||4311);
const baseURL=isolatedHttpOrigin('AUREVIA_E2E_APP_URL',`http://127.0.0.1:${appPort}`);
const providerURL=isolatedHttpOrigin('AUREVIA_E2E_PROVIDER_URL',`http://127.0.0.1:${providerPort}`);
if(baseURL===providerURL)throw new Error('Refusing to start Playwright: the app and mock provider must use separate loopback origins.');
const testSecret=randomBytes(32).toString('hex');
const useTwelveDataMock=process.env.AUREVIA_E2E_TWELVE_DATA_MOCK==='1'&&Boolean(e2eDatabaseUrl);
const twelveDataMockPreload=resolve(process.cwd(),'tests/e2e/mock-twelve-data.mjs');
const nodeOptions=[process.env.NODE_OPTIONS,useTwelveDataMock?`--import=${twelveDataMockPreload}`:null].filter(Boolean).join(' ');
const browserDevices={
	chromium:devices['Desktop Chrome'],
	firefox:devices['Desktop Firefox'],
	webkit:devices['Desktop Safari'],
};
const requestedBrowsers=process.env.AUREVIA_E2E_BROWSER_PROJECT?.split(',')||
	(process.env.AUREVIA_E2E_ALL_BROWSERS==='1'?Object.keys(browserDevices):['chromium']);
const unknownBrowsers=requestedBrowsers.filter(name=>!(name in browserDevices));
if(unknownBrowsers.length)throw new Error(`Unknown Playwright browser project: ${unknownBrowsers.join(', ')}.`);
const projects=requestedBrowsers.map(name=>({name,use:{...browserDevices[name as keyof typeof browserDevices]}}));

export default defineConfig({
	testDir:'./tests/e2e',
	testMatch:process.env.AUREVIA_LIGHTHOUSE_AUDIT==='1'?'**/*.audit.ts':'**/*.spec.ts',
	outputDir:'test-results',
	fullyParallel:false,
	workers:1, // Integration tests share mutable database fixtures and authentication sessions.
	retries:process.env.CI?1:0,
	reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],
	timeout:90000,
	expect:{timeout:10000},
	globalSetup:'./tests/e2e/global-setup.ts',
	globalTeardown:'./tests/e2e/global-teardown.ts',
	use:{
		baseURL,
		...devices['Desktop Chrome'],
		viewport:{width:1440,height:900},
		reducedMotion:'reduce',
		headless:true,
		trace:'retain-on-failure',
		screenshot:'only-on-failure',
		actionTimeout:15000,
		navigationTimeout:45000,
	},
	projects,
	webServer:[
		{
			command:'node tests/e2e/mock-provider.mjs',
			url:`${providerURL}/health`,
			reuseExistingServer:false,
			timeout:15000,
			env:{...process.env,AUREVIA_E2E_PROVIDER_PORT:String(providerPort)},
		},
		{
			command:'npm run build && npm start',
			url:`${baseURL}/api/health`,
			reuseExistingServer:false,
			timeout:240000,
			env:{
				...process.env,
				AUREVIA_NEXT_DIST_DIR:'.next-e2e',
				PORT:String(appPort),
				NODE_ENV:'production',
				NEXTAUTH_URL:baseURL,
				NEXT_PUBLIC_APP_URL:baseURL,
				RENDER_EXTERNAL_URL:'',
				AUREVIA_CUSTOM_DOMAIN_VERIFIED:'false',
				NEXTAUTH_SECRET:testSecret,
				VERIFICATION_CODE_SECRET:testSecret,
				RESEND_API_KEY:'',
				AKEDLY_ENABLED:'false',
				AKEDLY_API_KEY:'',
				AKEDLY_PIPELINE_ID:'',
				AKEDLY_WIDGET_ID:'',
				AKEDLY_PUBLIC_KEY:'',
				AKEDLY_WIDGET_SECRET:'',
				AKEDLY_WEBHOOK_SECRET:'',
				AUREVIA_KYC_ENGINE:'internal',
				AUREVIA_KYC_ENABLED:'true',
				KYC_MAX_DOCUMENT_SIZE_MB:'15',
				KYC_ENCRYPTION_KEY:Buffer.alloc(32,3).toString('base64'),
				TERMII_API_KEY:'',
				TERMII_SENDER_ID:'',
				AUREVIA_E2E_ALLOW_HTTP_PROVIDER:'1',
				MARKET_TICK_MS:'1000',
				SUPABASE_URL:providerURL,
				SUPABASE_SERVICE_ROLE_KEY:'playwright-only-storage-key',
				KYC_SUPABASE_URL:providerURL,
				KYC_SUPABASE_SERVICE_ROLE_KEY:'playwright-only-storage-key',
				NEXT_PUBLIC_SUPABASE_URL:'',
				NEXT_PUBLIC_SUPABASE_ANON_KEY:'',
				REAL_EXECUTION_ENABLED:'false',
				TWELVE_DATA_API_KEY:useTwelveDataMock?'aurevia-e2e-only-not-a-real-key':'',
				TWELVE_DATA_BASE_URL:'https://api.twelvedata.com',
				MARKET_DATA_DISPLAY_LICENSES_CONFIRMED:useTwelveDataMock?'true':'false',
				AUREVIA_E2E_TWELVE_DATA_MOCK:useTwelveDataMock?'1':'',
				NODE_OPTIONS:nodeOptions,
				PAYMENT_PROVIDER:'',
				PAYMENT_API_URL:'',
				PAYMENT_API_KEY:'',
				PAYMENT_WEBHOOK_SECRET:'',
				SMTP_HOST:'',
				SMTP_PORT:'',
				SMTP_USER:'',
				SMTP_PASSWORD:'',
				SMTP_FROM:'',
				VERIFICATION_EMAIL_API_URL:'',
				VERIFICATION_EMAIL_API_KEY:'',
				VERIFICATION_SMS_API_URL:'',
				VERIFICATION_SMS_API_KEY:'',
				TWILIO_ACCOUNT_SID:'',
				TWILIO_AUTH_TOKEN:'',
				TWILIO_VERIFY_SERVICE_SID:'',
				OPENAI_API_KEY:'',
				OPENROUTER_API_KEY:'',
				GEMINI_API_KEY:'',
				GROQ_API_KEY:'',
				GNEWS_API_KEY:'',
				AUREVIA_GNEWS_ALLOW_PRODUCTION:'false',
			},
		},
	],
});
