import {expect,test as base,Page} from '@playwright/test';
import {PrismaClient} from '@prisma/client';
import {randomInt} from 'node:crypto';
import {fallbackRoutes} from './theme-route-inventory';

type RuntimeCapture={consoleErrors:string[];consoleErrorOrigins:string[];pageErrors:string[];failedRequests:string[];cancelledRequests:string[];pendingRequests:string[];failedResponses:Array<{url:string;status:number}>};
const marketProviderConfigured=!process.env.AUREVIA_E2E_DATABASE_URL&&Boolean(
	process.env.TWELVE_DATA_API_KEY&&process.env.MARKET_DATA_DISPLAY_LICENSES_CONFIRMED==='true',
);
const appOrigin=process.env.AUREVIA_E2E_APP_URL||'http://127.0.0.1:4310';
const credentialCallback='**/api/auth/callback/credentials**';
const e2eDatabaseUrl=process.env.AUREVIA_E2E_DATABASE_URL;
const e2eDb=e2eDatabaseUrl?new PrismaClient({datasourceUrl:e2eDatabaseUrl}):null;

base.afterAll(async()=>{await e2eDb?.$disconnect()});

function isolatedLoginIp(){
	return `198.18.${randomInt(0,256)}.${randomInt(1,255)}`;
}

function cancelledRequestTarget(url:string){
	const parsed=new URL(url);
	return `${parsed.host}${parsed.pathname}${parsed.search}`;
}

function cancelledRequestFromPageError(message:string){
	const host=new URL(appOrigin).host.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
	const match=message.match(new RegExp(`${host}(/[^\\s]+?) due to access control checks\\.`));
	return match?new URL(match[1],appOrigin).href:null;
}

function cancelledFetchConsoleTarget(message:string){
	if(message==='Profile photo is unavailable. TypeError')return '/api/profile/avatar';
	if(message==='Profile photo is unavailable. AbortError')return '/api/profile/avatar';
	if(message==='Unable to refresh the account tier. TypeError')return '/api/profile';
	if(message==='Unable to check tax-service navigation access. TypeError')return '/api/tax-services/access';
	if(message==='Account theme preference could not be loaded. TypeError')return '/api/theme-preference';
	if(message.includes('[next-auth][error][CLIENT_FETCH_ERROR]')&&message.includes('url: /api/auth/session'))return '/api/auth/session';
	return null;
}

function consumeCancelledTarget(counts:Map<string,number>,target:string){
	const count=counts.get(target)||0;
	if(count===0)return false;
	counts.set(target,count-1);
	return true;
}

export const test=base;
export {expect};

export async function waitForStartup(page:Page){
	const startupScreen=page.locator('.startup-screen');
	await page.waitForFunction(()=>{
		const content=document.querySelector('.scene-content > div');
		return !document.querySelector('.startup-screen')&&content?.getAttribute('aria-hidden')==='false';
	});
	await expect(startupScreen).toHaveCount(0);
	await expect(page.locator('.scene-content > div[inert]')).toHaveCount(0);
}

export async function loginAs(page:Page,email:string,password:string,options:{acceptTerms?:boolean;secondFactorCode?:string}={}){
	const loginIp=isolatedLoginIp();
	const addIsolatedLoginIp=(route:import('@playwright/test').Route)=>route.continue({headers:{...route.request().headers(),'x-forwarded-for':loginIp}});
	const administrator=[process.env.AUREVIA_E2E_ADMIN_EMAIL,process.env.AUREVIA_E2E_REVIEWER_EMAIL]
		.some(knownEmail=>knownEmail?.toLowerCase()===email.toLowerCase());
	await page.route(credentialCallback,addIsolatedLoginIp);
	try{
		await page.goto(administrator?'/admin/login':'/login');
		await waitForStartup(page);
		await page.getByLabel(administrator?'Admin username or email':'Email address').fill(email);
		const passwordInput=page.getByLabel(administrator?'Admin password':'Password',{exact:true});
		await passwordInput.fill(password);
		if(options.secondFactorCode!==undefined){
			await page.locator('input[name="secondFactorCode"]').fill(options.secondFactorCode);
		}
		const replaceSession=page.getByRole('checkbox',{name:administrator?/Replace another active Aurevia session/:/Replace the active Aurevia session/});
		if(await replaceSession.count()){
			await replaceSession.focus();
			await page.keyboard.press('Space');
			await expect(replaceSession).toBeChecked();
		}
		await passwordInput.press('Enter');
		try{
			await expect.poll(()=>{
				const pathname=new URL(page.url()).pathname;
				return administrator?pathname==='/admin'||pathname.startsWith('/admin/')&&!pathname.startsWith('/admin/login'):pathname.startsWith('/dashboard');
			},{timeout:30000}).toBe(true);
		}catch(error){
			const signInError=await page.locator('.auth-signin-card [role="alert"]').textContent().catch(()=>null);
			throw new Error(`${error instanceof Error?error.message:String(error)}${signInError?` Sign-in response: ${signInError}`:''}`);
		}
		await page.waitForLoadState('load');
		await expect.poll(async()=>{
			const response=await page.request.get('/api/auth/session');
			if(!response.ok())return null;
			const session=await response.json();
			return typeof session.user?.email==='string'?session.user.email.toLowerCase():null;
		}).toBe(email.toLowerCase());
		if(options.acceptTerms!==false){
			const consent=await page.request.get('/api/policy-consent');
			if(!consent.ok())throw new Error(`Unable to load current terms acceptance status: ${consent.status()}`);
			const current=await consent.json() as {accepted:boolean};
			if(!current.accepted){
				const dialog=page.locator('.policy-consent-dialog');
				await expect(dialog).toBeVisible();
				await dialog.getByRole('checkbox').check();
				await dialog.getByRole('button',{name:'Accept & Continue'}).click();
				await expect(dialog).toBeHidden();
			}
		}
	}finally{
		await page.unroute(credentialCallback,addIsolatedLoginIp);
	}
}

export async function logout(page:Page){
	const button=page.getByRole('button',{name:/^(?:Logout|Sign out)$/});
	const accountMenu=page.getByRole('button',{name:'More account navigation'});
	const menu=page.getByRole('button',{name:/More navigation|Close More navigation|Open admin menu|Close admin menu/});
	await expect(button.or(accountMenu).or(menu)).toBeVisible();
	if(!await button.isVisible()){
		const navigationMenu=await accountMenu.isVisible()?accountMenu:menu;
		if(await navigationMenu.getAttribute('aria-expanded')!=='true')await navigationMenu.click();
	}
	await expect(button).toBeVisible();
	await button.click();
	await page.waitForURL(/\/login(?:\?.*)?$/);
}

export async function expectNoHorizontalOverflow(page:Page){
	const dimensions=await page.evaluate(()=>{
		const viewport=window.innerWidth;
		const offenders=[...document.querySelectorAll('body *')]
			.map(element=>{
				const rect=element.getBoundingClientRect();
				const style=getComputedStyle(element);
				const svgGraphic=element instanceof SVGElement&&!(element instanceof SVGSVGElement);
				let ancestor=element.parentElement;
				let clipped=false;
				while(ancestor&&ancestor!==document.body&&ancestor!==document.documentElement){
					if(['hidden','clip','auto','scroll'].includes(getComputedStyle(ancestor).overflowX)){
						clipped=true;
						break;
					}
					ancestor=ancestor.parentElement;
				}
				return {tag:element.tagName,selector:element.id?`#${element.id}`:element.className,rect:{left:rect.left,right:rect.right,width:rect.width},position:style.position,overflow:style.overflow,visible:style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0,clipped,svgGraphic};
			})
			.filter(item=>item.visible&&!item.clipped&&!item.svgGraphic&&(item.rect.right>viewport+1||item.rect.left<-1))
			.sort((left,right)=>right.rect.right-left.rect.right)
			.slice(0,20);
		return {viewport,document:document.documentElement.scrollWidth,offenders};
	});
	expect(dimensions.document,`horizontal overflow at ${dimensions.viewport}px: ${JSON.stringify(dimensions.offenders)}`).toBeLessThanOrEqual(dimensions.viewport+1);
	expect(dimensions.offenders,`visible content outside ${dimensions.viewport}px viewport: ${JSON.stringify(dimensions.offenders)}`).toEqual([]);
}

test.beforeEach(async({page},testInfo)=>{
	const testClientIp=`198.51.100.${randomInt(1,255)}`;
	await page.route('**/api/auth/callback/credentials**',route=>route.continue({headers:{...route.request().headers(),'x-forwarded-for':testClientIp}}));
	await page.route('**/*e2e-portrait.png**',route=>route.fulfill({
		status:404,
		contentType:'text/plain',
		body:'Not found',
	}));
	await page.route('**/api/demo/ai-recommendations',route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify({status:'no_signal',message:'No recommendation is currently available.',evaluationIntervalSeconds:300,recommendations:[]}),
	}));
	const capture:RuntimeCapture={consoleErrors:[],consoleErrorOrigins:[],pageErrors:[],failedRequests:[],cancelledRequests:[],pendingRequests:[],failedResponses:[]};
	(page as Page & {__runtimeCapture?:RuntimeCapture}).__runtimeCapture=capture;
	page.on('console',message=>{
		const expectedFundingFailure=(testInfo.title.includes('Account Funding')||testInfo.title.includes('Wallet shows the internal funding workflow'))&&message.text().includes('503 (Service Unavailable)');
		const expectedAssistantFailure=testInfo.title.includes('support fallback')&&message.text().includes('503 (Service Unavailable)');
		const expectedUnavailableMarket=!marketProviderConfigured&&message.text().includes('503 (Service Unavailable)');
		const expectedDuplicateRegistration=testInfo.title.includes('duplicate signup offers sign-in')&&message.text().includes('status of 409 (Conflict)');
		const expectedServiceWorkerFailure=(
			testInfo.title.includes('browser notification settings report service worker registration failures')
			||testInfo.title.includes('homepage testimonial profile stays visible')
			||testInfo.title.includes('homepage clearly shows simulated DEMO prices')
			||testInfo.title.includes('site theme preference switches globally')
		)&&message.text().includes('Service worker registration failed');
		if(message.type()==='error'&&!message.text().includes('status of 400 (Bad Request)')&&!message.text().includes('status of 401 (Unauthorized)')&&!expectedFundingFailure&&!expectedAssistantFailure&&!expectedUnavailableMarket&&!expectedDuplicateRegistration&&!expectedServiceWorkerFailure){
			capture.consoleErrors.push(message.text());
			const source=message.location().url;
			capture.consoleErrorOrigins.push(source.startsWith('http://')||source.startsWith('https://')?new URL(source).origin:'inline-or-unknown');
		}
	});
	page.on('pageerror',error=>{
		const cancelledUrl=cancelledRequestFromPageError(error.message);
		if(cancelledUrl)capture.cancelledRequests.push(cancelledUrl);
		capture.pageErrors.push(error.message);
	});
	page.on('request',request=>{
		if(request.url().startsWith(appOrigin)&&(request.resourceType()==='fetch'||request.resourceType()==='xhr'))capture.pendingRequests.push(request.url());
	});
	const finishPendingRequest=(request:import('@playwright/test').Request)=>{
		const index=capture.pendingRequests.indexOf(request.url());
		if(index>=0)capture.pendingRequests.splice(index,1);
	};
	page.on('requestfailed',request=>{
		const failure=request.failure()?.errorText||'request failed';
		if(failure.includes('ERR_ABORTED')||failure==='NS_BINDING_ABORTED'||failure==='Load request cancelled'){
			if(request.url().startsWith(appOrigin))capture.cancelledRequests.push(request.url());
			finishPendingRequest(request);
			return;
		}
		finishPendingRequest(request);
		if(request.url().startsWith(appOrigin))capture.failedRequests.push(`${request.method()} ${request.url()} · ${failure}`);
	});
	page.on('response',response=>{
		finishPendingRequest(response.request());
		if(response.status()<400||!response.url().startsWith(appOrigin))return;
		capture.failedResponses.push({url:response.url(),status:response.status()});
	});
});

test.afterEach(async({page},testInfo)=>{
	const capture=(page as Page & {__runtimeCapture?:RuntimeCapture}).__runtimeCapture;
	if(!capture)return;
	await testInfo.attach('browser-runtime.json',{body:Buffer.from(JSON.stringify(capture,null,2)),contentType:'application/json'});
	const cancelledTargets=new Map<string,number>();
	for(const message of capture.consoleErrors){
		const target=cancelledFetchConsoleTarget(message);
		if(target&&message.endsWith('AbortError')&&capture.pendingRequests.some(url=>cancelledRequestTarget(url)===`${new URL(appOrigin).host}${target}`)){
			cancelledTargets.set(`${new URL(appOrigin).host}${target}`,(cancelledTargets.get(`${new URL(appOrigin).host}${target}`)||0)+1);
		}
	}
	for(const url of capture.cancelledRequests){
		const target=cancelledRequestTarget(url);
		cancelledTargets.set(target,(cancelledTargets.get(target)||0)+1);
	}
	const cancelledPageErrors=new Map(cancelledTargets);
	const unexpectedPageErrors=capture.pageErrors.filter(message=>{
		const target=[...cancelledPageErrors.keys()].find(candidate=>message.includes(candidate)&&message.includes('due to access control checks'));
		return !(target&&consumeCancelledTarget(cancelledPageErrors,target));
	});
	const expectedFallbackResponse=testInfo.title.includes('public routes render without horizontal overflow')?capture.failedResponses.filter(response=>fallbackRoutes.some(route=>new URL(response.url).pathname===route)&&response.status===404):[];
	const expectedKycStorageFailures=testInfo.title.includes('administrator user and KYC actions')&&e2eDatabaseUrl
		?capture.failedResponses.filter(response=>/^\/api\/admin\/kyc\/documents\/[^/]+$/.test(new URL(response.url).pathname)&&response.status===502)
		:[];
	const expectedMissingPortraitResponse=testInfo.title.includes('global chat support persists')
		?capture.failedResponses.filter(response=>new URL(response.url).pathname==='/client-stories/e2e-portrait.png'&&response.status===404)
		:[];
	const expectedClientErrors=[...expectedFallbackResponse,...expectedKycStorageFailures,...expectedMissingPortraitResponse,...capture.failedResponses.filter(response=>{
		const title=testInfo.title;
		const status=response.status;
		const url=response.url;
		const totpSessionRevoked=title.includes('TOTP enrollment')&&status===401
			&&(['/api/support','/api/notifications?limit=20'].some(path=>url.endsWith(path)));
		const accountDeletionDenied=title.includes('account deletion')
			&&(['/api/currency-preference','/api/positions','/api/tax-services/access','/api/profile','/api/profile/avatar'].some(path=>url.endsWith(path))&&status===401
				||url.endsWith('/api/dashboard/overview')&&status===403);
		const notificationsUnauthorized=['watchlists persist','session replacement is explicit','Nova escalation reaches admin','tier requests require','account deletion']
			.some(name=>title.includes(name))&&url.endsWith('/api/notifications?limit=8')&&status===401;
		const fundingUnavailable=(title.includes('Account Funding')||title.includes('Wallet shows the internal funding workflow'))
			&&(url.endsWith('/api/payment-methods')||url.endsWith('/api/wallet'))&&status===503;
		const currencyRateUnavailable=title.includes('display currency preference')
			&&new URL(url).pathname==='/api/currency-rates'&&status===503;
		return title.includes('current terms acceptance')&&url.endsWith('/api/policy-consent')&&status===503
			||title.includes('duplicate signup offers sign-in')&&url.endsWith('/api/register')&&status===409
			||title.includes('registration fails closed when Akedly credentials are unavailable')&&url.endsWith('/api/register')&&status===503
			||url.endsWith('/api/auth/callback/credentials')&&status===401
			||title.includes('TOTP enrollment')&&url.endsWith('/api/security/totp')&&status===400
			||currencyRateUnavailable
			||totpSessionRevoked
			||notificationsUnauthorized
			||accountDeletionDenied
			||title.includes('Nova escalation reaches admin')&&url.endsWith('/api/support')&&status===409
			||fundingUnavailable
			||url.includes('/api/live-markets/')&&status===503&&!marketProviderConfigured
			||url.endsWith('/api/orderbook')&&status===503&&!marketProviderConfigured
			||title.includes('KYC access is owner-scoped')&&url.endsWith('/api/kyc/documents')&&status===409;
	})];
	const expectedTermsDenials=testInfo.title.includes('current terms acceptance')?capture.failedResponses.filter(response=>response.url.endsWith('/api/theme-preference')&&response.status===403):[];
	const expectedLandingConsentDenials=testInfo.title.includes('homepage remains visible while signed-in users review required terms')
		?capture.failedResponses.filter(response=>response.status===403&&[
			'/api/language-preference',
			'/api/theme-preference',
			'/api/notifications',
			'/api/support',
		].includes(new URL(response.url).pathname))
		:[];
	if(testInfo.title.includes('support fallback'))expectedClientErrors.push(...capture.failedResponses.filter(response=>response.url.endsWith('/api/support/nova')&&response.status===503));
	if(testInfo.title.includes('account deletion'))expectedClientErrors.push(...capture.failedResponses.filter(response=>(response.url.endsWith('/api/profile')&&response.status===403)||(response.url.endsWith('/api/dashboard/overview')&&[401,403].includes(response.status))));
	if(testInfo.title.includes('account deletion'))expectedClientErrors.push(...capture.failedResponses.filter(response=>response.url.endsWith('/api/notifications?limit=100')&&response.status===401));
	if(!marketProviderConfigured)expectedClientErrors.push(...capture.failedResponses.filter(response=>new URL(response.url).pathname=== '/api/orderbook'&&response.status===503));
	const expectedSyntheticRouteFailures=testInfo.title.includes('authenticated routes render without horizontal overflow')?capture.failedResponses.filter(response=>{
		const route=new URL(response.url).pathname;
		return route==='/api/cards/theme-id'&&response.status===404||route==='/api/funding/theme-id'&&response.status===404||route==='/api/tax-services/cases/theme-id'&&response.status===403;
	}):[];
	const unexpectedResponses=capture.failedResponses.filter(response=>!expectedClientErrors.includes(response)&&!expectedSyntheticRouteFailures.includes(response)&&!expectedTermsDenials.includes(response)&&!expectedLandingConsentDenials.includes(response));
	const accountClosureAccessDenied=testInfo.title.includes('account deletion')&&capture.failedResponses.some(response=>(response.url.endsWith('/api/profile')&&[401,403].includes(response.status))||(response.url.endsWith('/api/dashboard/overview')&&[401,403].includes(response.status)));
	const accountClosureProfileDenied=testInfo.title.includes('account deletion')&&capture.failedResponses.some(response=>response.url.endsWith('/api/profile')&&[401,403].includes(response.status));
	let remainingExpectedFallbackErrors=expectedFallbackResponse.length;
	let remainingExpectedKycStorageErrors=expectedKycStorageFailures.length;
	let remainingExpectedMissingPortraitErrors=expectedMissingPortraitResponse.length;
	let remainingSyntheticNotFoundErrors=expectedSyntheticRouteFailures.filter(response=>response.status===404).length;
	let remainingSyntheticForbiddenErrors=expectedSyntheticRouteFailures.filter(response=>response.status===403).length;
	const cancelledConsoleErrors=new Map(cancelledTargets);
	const appHost=new URL(appOrigin).host;
	let remainingTermsForbiddenErrors=expectedTermsDenials.length+expectedLandingConsentDenials.length;
	let remainingExpectedThemeErrors=expectedTermsDenials.length+expectedLandingConsentDenials.filter(response=>response.url.endsWith('/api/theme-preference')).length;
	const unexpectedConsoleErrors=capture.consoleErrors.filter(message=>{
		const cancelledTarget=cancelledFetchConsoleTarget(message);
		if(cancelledTarget&&consumeCancelledTarget(cancelledConsoleErrors,`${appHost}${cancelledTarget}`))return false;
		if(message==='Account theme preference could not be loaded. Error'&&remainingExpectedThemeErrors>0){
			remainingExpectedThemeErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 403 (Forbidden)'&&remainingTermsForbiddenErrors>0){
			remainingTermsForbiddenErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 404 (Not Found)'&&remainingExpectedFallbackErrors>0){
			remainingExpectedFallbackErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 404 (Not Found)'&&remainingSyntheticNotFoundErrors>0){
			remainingSyntheticNotFoundErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 404 (Not Found)'&&remainingExpectedMissingPortraitErrors>0){
			remainingExpectedMissingPortraitErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 502 (Bad Gateway)'&&remainingExpectedKycStorageErrors>0){
			remainingExpectedKycStorageErrors--;
			return false;
		}
		if(message==='Failed to load resource: the server responded with a status of 403 (Forbidden)'&&remainingSyntheticForbiddenErrors>0){
			remainingSyntheticForbiddenErrors--;
			return false;
		}
		return !(accountClosureAccessDenied&&message.includes('status of 403 (Forbidden)')||accountClosureProfileDenied&&message.includes('Unable to refresh the account tier.'));
	});
	expect(unexpectedConsoleErrors,`browser console errors: ${JSON.stringify(unexpectedConsoleErrors)}; origins: ${JSON.stringify(capture.consoleErrorOrigins)}; cancelled requests: ${JSON.stringify(capture.cancelledRequests)}; failed application requests: ${JSON.stringify(capture.failedRequests)}; page errors: ${JSON.stringify(capture.pageErrors)}; failed application responses: ${JSON.stringify(capture.failedResponses)}`).toEqual([]);
	expect(unexpectedPageErrors,'uncaught browser exceptions').toEqual([]);
	expect(capture.failedRequests,'failed application requests').toEqual([]);
	expect(unexpectedResponses,'unexpected failed application responses').toEqual([]);
});
