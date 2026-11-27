import {createHash,randomInt,randomUUID} from 'node:crypto';
import type {Browser,Page} from '@playwright/test';
import bcrypt from 'bcryptjs';
import {FundingStatus,FundingType,ManagedNoticeStatus,ManagedNoticeType,NoticeVisibility,Prisma} from '@prisma/client';
import {PNG} from 'pngjs';
import {generate,generateSecret} from 'otplib';
import {test,expect,loginAs,logout,waitForStartup,expectNoHorizontalOverflow} from './fixtures';
import {db} from '../../lib/db';
import {balance as ledgerBalance,ensureSystemAccount,ensureUserLedger,initializeDemoAccount,initializePaperAccount,postDoubleEntry} from '../../lib/ledger';
import {deleteAccountData} from '../../lib/account-deletion';
import {settleMaturedSimulatedInvestments} from '../../lib/demo-investment-settlement';
import {SIMULATED_BTC_ADDRESS_SETTING} from '../../lib/config/simulated-bitcoin-address';
import {CURRENT_TERMS_VERSION} from '../../lib/policy-consent';
import {currentMandatoryTermsWhere} from '../../lib/managed-notice-policy';
import {REGISTRATION_LEGAL_DOCUMENTS} from '../../lib/registration-legal';
import {getCurrentLegalDocuments} from '../../lib/legal-acceptance';
import {adminRoutes,authenticatedRoutes,concreteRoutePath,themes} from './theme-route-inventory';
import {createManualReviewAssessment,kycConsentVersion,kycRegistryVersion} from '../../lib/kyc-verification';

const viewports=[
	{width:320,height:800},
	{width:360,height:800},
	{width:375,height:812},
	{width:390,height:844},
	{width:393,height:852},
	{width:430,height:932},
	{width:414,height:896},
	{width:768,height:1024},
	{width:1024,height:900},
	{width:1280,height:800},
	{width:1366,height:768},
	{width:1440,height:900},
	{width:1600,height:900},
	{width:1920,height:1080},
];

const appOrigin=process.env.AUREVIA_E2E_APP_URL||'http://127.0.0.1:4310';

async function revealSupportChat(page:Page){
	const launcher=page.getByRole('button',{name:/Open chat support/});
	const peek=page.getByRole('button',{name:'Show chat support'});
	await expect(peek.or(launcher)).toBeVisible();
	if(await launcher.isVisible())return launcher;
	await expect(peek).toBeVisible();
	await peek.click();
	await expect(launcher).toBeVisible();
	return launcher;
}

test.afterEach(async()=>{
	await db.user.updateMany({
		where:{email:{in:[fixture('USER_EMAIL'),fixture('LEGACY_USER_EMAIL'),fixture('INVESTOR_EMAIL')]},status:'ACTIVE'},
		data:{accountMode:'DEMO'},
	});
});

function fixture(name:string){
	const value=process.env[`AUREVIA_E2E_${name}`];
	if(!value)throw new Error(`Playwright fixture ${name} is unavailable.`);
	return value;
}

async function approveBankOperation(browser:Browser,operationId:string){
	const reviewerContext=await browser.newContext();
	try{
		const reviewerPage=await reviewerContext.newPage();
		await loginAs(reviewerPage,fixture('REVIEWER_EMAIL'),fixture('REVIEWER_PASSWORD'));
		const response=await reviewerPage.request.patch(`/api/admin/bank/operations/${operationId}`,{data:{decision:'APPROVE'}});
		const result=await response.json();
		expect(response.status(),result.error||'Bank operation approval failed.').toBe(201);
		expect(result.operation.status).toBe('POSTED');
		return result;
	}finally{await reviewerContext.close();}
}

async function requestRealBalanceAdjustment(browser:Browser,adminPage:Page,payload:Record<string,unknown>){
	const response=await adminPage.request.post('/api/admin/balances',{data:payload});
	const result=await response.json();
	expect(response.status(),result.error||'REAL balance adjustment request failed.').toBe(202);
	expect(result).toMatchObject({status:'PENDING',approvalRequired:true});
	const selfApproval=await adminPage.request.patch(`/api/admin/bank/operations/${result.operationId}`,{data:{decision:'APPROVE'}});
	expect(selfApproval.status()).toBe(403);
	const approved=await approveBankOperation(browser,result.operationId);
	return {request:result,approved};
}

async function seedRealWalletForTest(userId:string,amount:string){
	await db.$transaction(async tx=>{
		const userAccount=await ensureUserLedger(tx,userId,'REAL','USD');
		const source=await ensureSystemAccount(tx,'SYSTEM:E2E:INVESTMENT-FUNDING:REAL:USD','E2E investment test funding','USD','REAL');
		await postDoubleEntry(tx,{reference:`E2E:INVESTMENT-FUNDING:${randomUUID()}`,description:'Disposable E2E investment funding',debitAccountId:source.id,creditAccountId:userAccount.id,amount:new Prisma.Decimal(amount)});
	});
}

async function validRegistrationPayload(email:string,password='SecureTestPassword1',overrides:Record<string,unknown>={}){
	const legalAcceptances=await getCurrentLegalDocuments();
	return {
		email,password,name:'E2E Registration User',firstName:'E2E',middleName:'',lastName:'Registration User',
		country:'United States',countryCode:'US',dateOfBirth:'1990-01-01',accountMode:'DEMO',
		address:{countryCode:'US',line1:'123 Test Street',city:'New York'},
		legal:{termsAccepted:true,privacyAccepted:true,riskDisclosureAccepted:true,amlKycAccepted:true,depositWithdrawalAccepted:true,platformUsageAccepted:true},
		legalAcceptances:legalAcceptances.map(({documentKey,version})=>({documentKey,version})),
		website:'',
		...overrides,
	};
}

async function selectRegistrationCountry(page:Page,accessibleName:RegExp,countryName:string,countryCode:string,dialCode:string){
	await page.getByRole('button',{name:accessibleName}).click();
	const dialog=page.getByRole('dialog',{name:new RegExp(`Select ${countryName==='United States'?'country of residence':'residential address country'}`,'i')});
	await dialog.getByRole('searchbox').fill(countryName);
	await dialog.getByRole('option',{name:new RegExp(`${countryName}.*${countryCode}.*\\${dialCode}`)}).click();
}

async function completeRegistrationToReview(page:Page,options:{email:string;firstName?:string;lastName?:string;country?:string;countryCode?:string}){
	const country=options.country||'United States';
	const code=options.countryCode||'US';
	await page.getByRole('textbox',{name:'First name'}).fill(options.firstName||'Temporary');
	await page.getByLabel('Last name').fill(options.lastName||'Browser Test');
	await page.locator('input[type="date"]').fill('2000-02-29');
	await selectRegistrationCountry(page,/country of residence/i,country,code,code==='GB'?'+44':'+1');
	await page.getByRole('button',{name:'Continue'}).click();
	await page.getByLabel(/City/).fill('New York');
	await page.getByLabel(/Street address/).fill('123 Test Street');
	await page.getByRole('button',{name:'Continue'}).click();
	await page.getByLabel('Email address').fill(options.email);
	await page.getByLabel('Account mode').selectOption('DEMO');
	await page.getByRole('button',{name:'Continue'}).click();
	await page.getByLabel(/^Password/).fill('SecureTestPassword1');
	await page.getByLabel(/^Confirm password/).fill('SecureTestPassword1');
	await page.getByRole('button',{name:'Continue'}).click();
	const legalCheckboxes=page.locator('.registration-legal-item input[type="checkbox"]');
	for(let index=0;index<await legalCheckboxes.count();index++)await legalCheckboxes.nth(index).check();
	await page.getByRole('button',{name:'Continue'}).click();
}

async function createIsolatedDemoUser(label:string,options:{acceptTerms?:boolean}={}){
	const password=`E2e-${randomUUID()}-A1!`;
	const user=await db.user.create({data:{
		email:`aurevia-e2e-${label}-${randomUUID()}@example.invalid`,
		name:'Temporary isolated E2E user',
		country:'Test',
		passwordHash:await bcrypt.hash(password,10),
		accountMode:'DEMO',
		status:'ACTIVE',
	}});
	await db.$transaction(tx=>initializeDemoAccount(tx,user.id));
	if(options.acceptTerms!==false){
		const currentTerms=await db.managedNotice.findFirst({
			where:currentMandatoryTermsWhere(),
			select:{version:true},
			orderBy:[{publishedAt:'desc'},{createdAt:'desc'}],
		});
		const termsVersion=currentTerms?.version||CURRENT_TERMS_VERSION;
		await db.termsAcceptance.create({data:{userId:user.id,version:termsVersion}});
		await db.registrationLegalAcceptance.createMany({
			data:REGISTRATION_LEGAL_DOCUMENTS.map(document=>({
				userId:user.id,
				documentKey:document.key,
				version:document.key==='TERMS_AND_CONDITIONS'?termsVersion:document.version==='privacy'?'privacy':document.version,
				auditMetadata:{channel:'e2e-fixture',documentKey:document.key},
			})),
			skipDuplicates:true,
		});
	}
	return {email:user.email,password};
}

function depositPostOptions(idempotencyKey:string,payload:Record<string,unknown>){
	return {headers:{'Idempotency-Key':idempotencyKey},multipart:{payload:JSON.stringify(payload),evidence:{name:'payment.png',mimeType:'image/png',buffer:PNG.sync.write(new PNG({width:1,height:1}))}}};
}

test('current terms acceptance is explicit and persists across refresh, login, and devices',async({browser,page})=>{
	const user=await createIsolatedDemoUser('terms-first-visit',{acceptTerms:false});
	await page.setViewportSize({width:320,height:800});
	await loginAs(page,user.email,user.password,{acceptTerms:false});
	expect((await page.request.get('/api/dashboard/overview')).status()).toBe(403);
	for(const path of ['/api/support','/api/tax-services/access'])expect((await page.request.get(path)).status()).toBe(403);
	expect((await page.request.get('/api/theme-preference')).status()).toBe(403);
	const dialog=page.getByRole('dialog',{name:'Review required legal documents'});
	const currentVersion=await page.request.get('/api/policy-consent').then(response=>response.json()).then(result=>result.version as string);
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText('Accept the outstanding current policy versions to continue.');
	await expect(dialog.getByRole('link',{name:/Terms & Conditions/})).toHaveAttribute('href','/terms');
	await expect(dialog.getByRole('link',{name:/Privacy Policy/})).toHaveAttribute('href','/privacy');
	await expect(dialog.getByRole('checkbox')).not.toBeChecked();
	const acceptButton=dialog.getByRole('button',{name:'Accept & Continue'});
	await expect(acceptButton).toBeDisabled();
	const mobileBox=await dialog.boundingBox();
	expect(mobileBox).not.toBeNull();
	expect(mobileBox!.x).toBeGreaterThanOrEqual(0);
	expect(mobileBox!.x+mobileBox!.width).toBeLessThanOrEqual(320);
	await expectNoHorizontalOverflow(page);
	await page.setViewportSize({width:1440,height:900});
	const desktopBox=await dialog.boundingBox();
	expect(desktopBox).not.toBeNull();
	expect(desktopBox!.width).toBeLessThanOrEqual(440);

	await page.route('**/api/policy-consent',route=>route.request().method()==='POST'
		?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'We could not save your acceptance. Please try again.'})})
		:route.continue());
	await dialog.getByRole('checkbox').check();
	await acceptButton.click();
	await expect(dialog.getByRole('alert')).toContainText('We could not save your acceptance.');
	await expect(dialog).toBeVisible();
	expect(await page.request.get('/api/policy-consent').then(response=>response.json())).toMatchObject({accepted:false});
	await dialog.getByRole('button',{name:'Retry'}).click();
	await expect(acceptButton).toBeDisabled();
	await page.unroute('**/api/policy-consent');
	await dialog.getByRole('checkbox').check();
	await dialog.getByRole('button',{name:'Accept & Continue'}).click();
	await expect(dialog).toBeHidden();
	expect((await page.request.get('/api/dashboard/overview')).status()).toBe(200);
	const deviceMarker=await page.evaluate(()=>{
		const key=Object.keys(localStorage).find(item=>item.startsWith('aurevia-policy-consent:v1:'));
		return key?JSON.parse(localStorage.getItem(key)||'null') as {documents?:Array<{documentKey:string;version:string;acceptedAt:string}>}:null;
	});
	expect(deviceMarker?.documents?.some(document=>document.documentKey==='TERMS_AND_CONDITIONS'&&document.version===currentVersion&&Date.parse(document.acceptedAt)>0)).toBe(true);
	for(const path of ['/api/support','/api/tax-services/access'])expect((await page.request.get(path)).status()).toBe(200);
	expect((await page.request.get('/api/theme-preference')).status()).toBe(200);

	await page.locator('a[href="/wallet"]:visible').first().click();
	await page.waitForURL(/\/wallet$/);
	await expect(dialog).toBeHidden();
	await page.locator('a[href="/markets"]:visible').first().click();
	await page.waitForURL(/\/markets$/);
	await expect(dialog).toBeHidden();
	await page.goto('/dashboard');
	const saved=await page.request.get('/api/policy-consent').then(response=>response.json());
	expect(saved).toMatchObject({version:currentVersion,accepted:true});
	expect(Number.isNaN(Date.parse(saved.acceptedAt))).toBe(false);
	expect((await page.request.post('/api/policy-consent',{data:{version:currentVersion,accepted:true}})).status()).toBe(200);
	const records=await db.termsAcceptance.findMany({where:{userId:(await db.user.findUniqueOrThrow({where:{email:user.email},select:{id:true}})).id}});
	expect(records).toHaveLength(1);
	expect(records[0].version).toBe(currentVersion);

	await page.reload();
	await expect(dialog).toBeHidden();
	const refreshedSession=await page.request.get('/api/auth/session');
	expect(refreshedSession.ok()).toBe(true);
	expect(await refreshedSession.json()).toMatchObject({user:{email:user.email}});
	await expect(page.getByRole('button',{name:'More account navigation'})).toBeVisible();
	await logout(page);
	await loginAs(page,user.email,user.password,{acceptTerms:false});
	await expect(page.locator('.policy-consent-dialog')).toBeHidden();

	const secondDevice=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
	try{
		const secondPage=await secondDevice.newPage();
		await loginAs(secondPage,user.email,user.password,{acceptTerms:false});
		await expect(secondPage.locator('.policy-consent-dialog')).toBeHidden();
		expect(await secondPage.request.get('/api/policy-consent').then(response=>response.json())).toMatchObject({accepted:true,version:currentVersion});
		await secondPage.goto('/dashboard');
		await secondPage.goto('/wallet');
		await expect(secondPage.locator('.policy-consent-dialog')).toBeHidden();
		await secondPage.goto('/markets');
		await expect(secondPage.locator('.policy-consent-dialog')).toBeHidden();
		await logout(secondPage);
		await loginAs(secondPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'),{acceptTerms:false});
		await expect(secondPage.locator('.policy-consent-dialog')).toBeHidden();
		await secondPage.goto('/admin');
		await secondPage.getByRole('button',{name:'Open admin menu'}).click();
		await secondPage.getByRole('link',{name:'AI & API command center'}).click();
		await secondPage.waitForURL(/\/admin\/command-center$/);
		await expect(secondPage.locator('.policy-consent-dialog')).toBeHidden();
	}finally{
		await secondDevice.close();
	}
});

test('homepage remains visible while signed-in users review required terms',async({page})=>{
	const user=await createIsolatedDemoUser('terms-homepage-visible',{acceptTerms:false});
	await loginAs(page,user.email,user.password,{acceptTerms:false});
	await expect(page.getByRole('dialog',{name:'Review required legal documents'})).toBeVisible();

	await page.goto('/');
	await expect(page.locator('.home-hero h1').first()).toBeVisible();
	await expect(page.locator('.policy-consent-checking')).toHaveCount(0);
	await expect(page.getByRole('dialog',{name:'Review required legal documents'})).toBeVisible();
});

test('updated terms require a separate acceptance and preserve the previous version',async({page})=>{
	const user=await createIsolatedDemoUser('terms-updated-version',{acceptTerms:false});
	const userId=(await db.user.findUniqueOrThrow({where:{email:user.email},select:{id:true}})).id;
	const previousVersion='2026-10-26';
	const currentVersion='2026-11-10-e2e';
	const previousAcceptedAt=new Date('2026-10-26T12:00:00.000Z');
	await db.termsAcceptance.create({data:{userId,version:previousVersion,acceptedAt:previousAcceptedAt}});
	const notice=await db.managedNotice.create({data:{
		type:ManagedNoticeType.TERMS,
		title:'E2E updated Terms & Conditions',
		content:'Updated terms for the isolated Playwright test.',
		version:currentVersion,
		visibility:NoticeVisibility.MANDATORY_ACCEPTANCE,
		requiresReacceptance:true,
		status:ManagedNoticeStatus.PUBLISHED,
		enabled:true,
		publishedAt:new Date(),
	}});
	try{
		await loginAs(page,user.email,user.password,{acceptTerms:false});
		const dialog=page.getByRole('dialog',{name:'Review required legal documents'});
		await expect(dialog).toBeVisible();
		await dialog.getByRole('checkbox').check();
		await dialog.getByRole('button',{name:'Accept & Continue'}).click();
		await expect(dialog).toBeHidden();
		const records=await db.termsAcceptance.findMany({where:{userId},orderBy:{version:'asc'}});
		expect(records).toHaveLength(2);
		expect(records.map(record=>record.version)).toEqual([previousVersion,currentVersion].sort());
		expect(records.find(record=>record.version===previousVersion)?.acceptedAt).toEqual(previousAcceptedAt);
		await page.reload();
		await expect(dialog).toBeHidden();
		await page.goto('/dashboard');
		await page.goto('/wallet');
		await expect(dialog).toBeHidden();
	}finally{
		await page.goto('about:blank');
		await db.managedNotice.delete({where:{id:notice.id}});
	}
});

async function typeInto(page:import('@playwright/test').Page,field:import('@playwright/test').Locator,value:string){
	await field.click();
	await expect.poll(()=>field.evaluate(element=>document.activeElement===element)).toBe(true);
	await page.keyboard.insertText(value);
	await expect(field).toHaveValue(value);
}

async function selectAccountMode(page:import('@playwright/test').Page,accountMode:'DEMO'|'REAL',options:{waitForCompletion?:boolean}={}){
	const mode=page.locator('.user-mode-control');
	await expect(mode).toBeVisible();
	const selected=mode.getByRole('button',{name:accountMode==='DEMO'?'Demo':'Real',exact:true});
	if(await selected.getAttribute('aria-pressed')!=='true')await selected.click();
	if(options.waitForCompletion!==false){
		await expect(selected).toHaveAttribute('aria-pressed','true');
		await expect(mode.getByRole('button',{name:accountMode==='DEMO'?'Real':'Demo',exact:true})).toBeEnabled();
	}
}

test('public stories publish for visitors and members with role, schedule, expiry, and engagement controls',async({browser,page})=>{
	const unauthenticated=await page.request.get('/api/admin/stories');
	expect(unauthenticated.status()).toBe(401);
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const createdIds:string[]=[];
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const categories=await adminPage.request.get('/api/admin/stories/categories');
		expect(categories.ok()).toBe(true);
		const category=(await categories.json())[0];
		const extraCategory=await adminPage.request.post('/api/admin/stories/categories',{data:{name:`E2E updates ${randomUUID()}`}});
		expect(extraCategory.status()).toBe(201);
		const createStory=async(title:string,status:'DRAFT'|'SCHEDULED'|'PUBLISHED',visibility:'PUBLIC'|'REGISTERED_USERS'='PUBLIC',dates:{publishAt?:Date;expiresAt?:Date}={})=>{
			const response=await adminPage.request.post('/api/admin/stories',{data:{
				title,description:`${title} content for the public stories viewer.`,categoryId:category.id,status,visibility,
				publishAt:dates.publishAt?.toISOString()??null,expiresAt:dates.expiresAt?.toISOString()??null,displayOrder:0,
			}});
			expect(response.status(),`create ${title}`).toBe(201);
			const story=await response.json();
			createdIds.push(story.id);
			return story as {id:string;title:string};
		};
		const now=Date.now();
		const publicStory=await createStory(`E2E public story ${randomUUID()}`,'PUBLISHED');
		const draftStory=await createStory(`E2E draft story ${randomUUID()}`,'DRAFT');
		const scheduledStory=await createStory(`E2E scheduled story ${randomUUID()}`,'SCHEDULED','PUBLIC',{publishAt:new Date(now+60_000)});
		const membersStory=await createStory(`E2E members story ${randomUUID()}`,'PUBLISHED','REGISTERED_USERS');
		const expiredStory=await createStory(`E2E expiring story ${randomUUID()}`,'PUBLISHED','PUBLIC',{expiresAt:new Date(now+60_000)});
		const png=PNG.sync.write(new PNG({width:1,height:1}));
		const publicImage=await adminPage.request.post(`/api/admin/stories/${publicStory.id}/media`,{multipart:{file:{name:'story.png',mimeType:'image/png',buffer:png},altText:'Aurevia story artwork'}});
		expect(publicImage.status()).toBe(201);
		const publicVideo=await adminPage.request.post(`/api/admin/stories/${publicStory.id}/media`,{multipart:{file:{name:'story.mp4',mimeType:'video/mp4',buffer:Buffer.from('\u0000\u0000\u0000\u0000ftypisom','binary')},altText:'Aurevia story video'}});
		expect(publicVideo.status()).toBe(201);
		const draftVideo=await adminPage.request.post(`/api/admin/stories/${draftStory.id}/media`,{multipart:{file:{name:'draft.mp4',mimeType:'video/mp4',buffer:Buffer.from('\u0000\u0000\u0000\u0000ftypisom','binary')}}});
		expect(draftVideo.status()).toBe(201);
		const publicMedia=(await publicImage.json()).media;
		const publicVideoMedia=(await publicVideo.json()).media;
		const privateMedia=(await draftVideo.json()).media;
		await db.story.update({where:{id:scheduledStory.id},data:{publishAt:new Date(now-60_000)}});
		await db.story.update({where:{id:expiredStory.id},data:{expiresAt:new Date(now-1_000)}});

		const beforeLoginFeed=await page.request.get('/api/stories').then(response=>response.json());
		const publicFeedStory=beforeLoginFeed.find((story:{id:string})=>story.id===publicStory.id);
		expect(publicFeedStory.media).toContainEqual(expect.objectContaining({id:publicMedia.id,type:'IMAGE'}));
		expect(publicFeedStory.media).toContainEqual(expect.objectContaining({id:publicVideoMedia.id,type:'VIDEO'}));
		const publicMediaUrl=publicFeedStory.media.find((item:{id:string;url:string})=>item.id===publicMedia.id)?.url;
		if(!publicMediaUrl)throw new Error('Public story media URL was not returned.');
		const publicImageResponse=await page.request.get(publicMediaUrl);
		expect(publicImageResponse.status()).toBe(200);
		expect(publicImageResponse.headers()['content-type']).toContain('image/png');
		expect((await page.request.get(`/api/stories/${draftStory.id}/media/${privateMedia.id}`)).status()).toBe(404);
		const adminVideoResponse=await adminPage.request.get(privateMedia.url);
		expect(adminVideoResponse.status()).toBe(200);
		expect(adminVideoResponse.headers()['content-type']).toContain('video/mp4');

		await page.setViewportSize({width:375,height:812});
		await page.addInitScript(()=>sessionStorage.setItem('aurevia-startup-complete','1'));
		await page.goto('/stories');
		await waitForStartup(page);
		await expect(page.getByRole('heading',{name:'Stories',exact:true})).toBeVisible();
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`})).toBeVisible();
		await expect(page.locator('.story-card-featured')).toContainText('Featured story');
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`})).toContainText('Read more');
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`}).locator('time')).not.toHaveText('Publication date unavailable');
		await expect(page.getByRole('button',{name:`Open ${publicStory.title}`})).toContainText('Play video');
		await expect(page.getByRole('button',{name:`Open ${scheduledStory.title}`})).toBeVisible();
		await expect(page.getByRole('button',{name:`Open ${draftStory.title}`})).toHaveCount(0);
		await expect(page.getByRole('button',{name:`Open ${membersStory.title}`})).toHaveCount(0);
		await expect(page.getByRole('button',{name:`Open ${expiredStory.title}`})).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
		await page.getByRole('button',{name:`Open ${publicStory.title}`}).click();
		const storyDialog=page.getByRole('dialog',{name:`Story: ${publicStory.title}`});
		await expect(storyDialog).toBeVisible();
		await expect(storyDialog.getByText(`${publicStory.title} content for the public stories viewer.`)).toBeVisible();
		await storyDialog.getByRole('button',{name:'Next story'}).click();
		const storyVideo=storyDialog.locator('video.story-viewer-media');
		await expect(storyVideo).toHaveAttribute('controls','');
		await expect(storyVideo).toBeVisible();
		await page.waitForTimeout(6_200);
		await expect(storyVideo).toBeVisible();
		await page.getByRole('button',{name:'Close stories'}).click();

		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		const memberFeed=await page.request.get('/api/stories').then(response=>response.json());
		expect(memberFeed).toContainEqual(expect.objectContaining({id:membersStory.id}));
		expect(memberFeed).not.toContainEqual(expect.objectContaining({id:draftStory.id}));
		const forbidden=await page.request.post('/api/admin/stories',{data:{}});
		expect(forbidden.status()).toBe(403);

		const adminLibrary=await adminPage.request.get('/api/admin/stories').then(response=>response.json());
		expect(adminLibrary.stories).toContainEqual(expect.objectContaining({id:publicStory.id,engagement:expect.objectContaining({views:1})}));
		expect(adminLibrary.stories).toContainEqual(expect.objectContaining({id:expiredStory.id,status:'ARCHIVED'}));
		const publicStoryAudit=adminLibrary.stories.find((story:{id:string;auditHistory:Array<{action:string}>})=>story.id===publicStory.id)?.auditHistory;
		expect(publicStoryAudit).toContainEqual(expect.objectContaining({action:'STORY_CREATED'}));
		await adminPage.goto('/admin/stories');
		await waitForStartup(adminPage);
		const managedStory=adminPage.locator('.admin-story-row').filter({hasText:publicStory.title});
		await expect(managedStory.getByText(/Created:/)).toBeVisible();
		await managedStory.getByText(/Audit history/).click();
		await expect(managedStory.getByText('STORY_CREATED')).toBeVisible();
		const deletion=await adminPage.request.delete('/api/admin/stories',{data:{storyId:publicStory.id}});
		expect(deletion.ok()).toBe(true);
		expect(await page.request.get('/api/stories').then(response=>response.json())).not.toContainEqual(expect.objectContaining({id:publicStory.id}));
	}finally{
		for(const id of createdIds)await adminPage.request.delete('/api/admin/stories',{data:{storyId:id}});
		await adminContext.close();
	}
});

test('support fallback gives correct account-mode and funding guidance',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.route('**/api/support/nova',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Support assistant unavailable.'})}));
	await page.goto('/support');
	await page.getByRole('textbox',{name:'Ask Nova AI'}).fill('How do REAL and DEMO account modes work?');
	await page.getByRole('button',{name:'Send question'}).click();
	await expect(page.getByText(/DEMO trades are practice activity/)).toBeVisible();
	await expect(page.getByText(/new REAL account orders use Aurevia Wallet funds and internal simulated execution/)).toBeVisible();
	await expect(page.getByText(/does not send an external payment or payout/)).toBeVisible();
});

test('provider health reports market data and internal REAL execution',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/providers');
	await expect(page.getByRole('heading',{name:'Internal service health'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Live financial services'})).toBeVisible();
	await expect(page.getByText('Primary provider:')).toBeVisible();
	await expect(page.getByText('Internal simulated trade execution')).toBeVisible();
	const liveFinancialServices=page.locator('article').filter({hasText:'Live financial services'});
	await expect(liveFinancialServices.getByText('Live broker execution')).toBeVisible();
	await expect(liveFinancialServices.getByText('DISABLED')).toHaveCount(4);
});

test('Aurevia Verify is first-party and legacy upload flows fail closed',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/kyc');
	await expect(page.getByRole('heading',{name:'REAL mode required'})).toBeVisible();
	const tierState=await page.request.get('/api/tier-requests');
	expect(tierState.ok()).toBe(true);
	await page.goto('/tier');
	await expect(page.getByRole('heading',{name:'Your account tier.'})).toBeVisible();
	await expect(page.getByRole('progressbar',{name:'Account tier progression'})).toBeVisible();
	await selectAccountMode(page,'REAL');
	await page.goto('/kyc');
	await expect(page.getByRole('heading',{name:'First-party verification centre'})).toBeVisible();
	await expect(page.getByText(/OCR, government-source authentication, face comparison.*not available/)).toHaveCount(0);
	await expect(page.getByLabel('Legal name')).toBeVisible();
	await expect(page.getByLabel('Date of birth')).toBeVisible();
	await expect(page.getByLabel('Document expiry date')).toBeVisible();
	const legacySubmission=await page.request.post('/api/kyc',{data:{
		legalName:'Manual submission must be retired',
		dob:'1990-01-01',
		address:'123 Test Street',
		idType:'PASSPORT',
		idNumber:`E2E-${randomUUID()}`,
	}});
	expect(legacySubmission.status()).toBe(410);
	const legacyDocument=await page.request.post('/api/kyc/documents',{multipart:{
		kind:'IDENTITY_DOCUMENT',
		file:{name:'identity.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nManual ID upload must be retired\\n%%EOF\\n')},
	}});
	expect(legacyDocument.status()).toBe(410);
});

test('KYC rejects unsupported identity files before upload',async({page})=>{
	await db.user.update({where:{email:fixture('USER_EMAIL')},data:{accountMode:'REAL'}});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/kyc');
	await page.getByLabel('Document-issuing country').selectOption('US');
	await page.getByLabel('Legal name').fill('File Validation Test');
	await page.getByLabel('Date of birth').fill('1990-01-01');
	await page.getByLabel('Document expiry date').fill('2030-01-01');
	await page.getByRole('button',{name:'Continue'}).click();

	await page.locator('.kyc-evidence-card input[type="file"]').first().setInputFiles({
		name:'identity.pdf',
		mimeType:'application/pdf',
		buffer:Buffer.from('%PDF-1.4'),
	});
	await expect(page.getByText('Choose a JPEG, PNG, or WebP image.',{exact:true})).toBeVisible();
	await expect(page.locator('.kyc-evidence-card').first().getByText('Required')).toBeVisible();
});

test('KYC camera recovers from denied permission and supports front/back/selfie capture through submission',async({page})=>{
	await db.user.update({where:{email:fixture('USER_EMAIL')},data:{accountMode:'REAL'}});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.addInitScript(()=>{
		let requests=0;
		let captures=0;
		const facingModes:string[]=[];
		Object.defineProperty(window,'__aureviaCameraFacingModes',{value:facingModes});
		Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
			getUserMedia:async(constraints:MediaStreamConstraints)=>{
				const video=constraints.video as MediaTrackConstraints;
				const mode=video.facingMode;
				const ideal=mode&&typeof mode==='object'&&!Array.isArray(mode)?mode.ideal:'';
				facingModes.push(typeof mode==='string'?mode:Array.isArray(mode)?mode.join(','):typeof ideal==='string'?ideal:Array.isArray(ideal)?ideal.join(','):'');
				requests++;
				if(requests===1)throw new DOMException('Permission denied','NotAllowedError');
				return new MediaStream();
			},
		}});
		Object.defineProperty(HTMLMediaElement.prototype,'play',{configurable:true,value:()=>Promise.resolve()});
		Object.defineProperty(HTMLVideoElement.prototype,'videoWidth',{configurable:true,get:()=>640});
		Object.defineProperty(HTMLVideoElement.prototype,'videoHeight',{configurable:true,get:()=>480});
		Object.defineProperty(CanvasRenderingContext2D.prototype,'drawImage',{configurable:true,value:function(this:CanvasRenderingContext2D){
			captures++;
			this.fillStyle=`hsl(${captures*71} 45% 45%)`;
			this.fillRect(0,0,640,480);
		}});
	});
	await page.setViewportSize({width:390,height:844});
	await page.goto('/kyc');
	await expect(page.getByRole('heading',{name:'First-party verification centre'})).toBeVisible();
	await page.getByLabel('Document-issuing country').selectOption('US');
	await page.getByLabel('Document type').selectOption('NATIONAL_ID');
	await page.getByLabel('Legal name').fill('Camera Test');
	await page.getByLabel('Date of birth').fill('1990-01-01');
	await page.getByRole('button',{name:'Continue'}).click();
	await expect(page.locator('legend:focus')).toHaveText('Private identity evidence');

	await page.getByRole('button',{name:'Open camera'}).first().click();
	await expect(page.getByText('Camera permission was denied')).toBeVisible();
	await page.getByRole('button',{name:'Open camera'}).first().click();
	await expect(page.getByText('Camera ready')).toBeVisible();
	await page.getByRole('button',{name:'Switch camera'}).click();
	await expect.poll(()=>page.evaluate(()=>(
		window as typeof window & {__aureviaCameraFacingModes?:string[]}
	).__aureviaCameraFacingModes)).toEqual(['environment','environment','user']);
	await page.getByRole('button',{name:'Capture document'}).click();
	await expect(page.getByRole('img',{name:'Document front preview'})).toBeVisible();
	await page.getByRole('button',{name:'Retake with camera'}).click();
	await expect(page.getByText('Camera ready')).toBeVisible();
	await page.getByRole('button',{name:'Capture document'}).click();
	await page.getByRole('button',{name:'Open camera'}).first().click();
	await expect(page.getByText('Camera ready')).toBeVisible();
	await page.getByRole('button',{name:'Capture document'}).click();
	await page.getByRole('button',{name:'Open selfie camera'}).click();
	await expect(page.getByText('Camera ready')).toBeVisible();
	await page.getByRole('button',{name:'Switch camera'}).click();
	await page.getByRole('button',{name:'Switch camera'}).click();
	await page.getByRole('button',{name:'Capture selfie'}).click();
	await expect(page.getByRole('img',{name:'Selfie preview'})).toBeVisible();
	await page.getByRole('button',{name:'Continue'}).click();
	await expect(page.getByText('Review before submission')).toBeVisible();
	await expect(page.locator('legend:focus')).toHaveText('Review before submission');
	await expect(page.getByRole('img',{name:'Document front review'})).toBeVisible();
	await expect(page.getByRole('img',{name:'Document back review'})).toBeVisible();
	await expect(page.getByRole('img',{name:'Selfie review'})).toBeVisible();
	await page.getByRole('checkbox').check();
	const submission=page.waitForResponse(response=>response.url().endsWith('/api/kyc/verification')&&response.request().method()==='POST');
	await page.getByRole('button',{name:'Submit for verification'}).click();
	const response=await submission;
	expect(response.status()).toBe(201);
	expect(await response.json()).toMatchObject({status:'PENDING_REVIEW'});
	await expect(page.getByText('Your submission was received and is awaiting administrator review.')).toBeVisible();
	const storedCase=await db.kycVerification.findFirstOrThrow({
		where:{user:{email:fixture('USER_EMAIL')}},
		orderBy:{createdAt:'desc'},
		select:{status:true,documents:{select:{kind:true,documentSide:true,status:true}}},
	});
	expect(storedCase.status).toBe('PENDING_REVIEW');
	expect(storedCase.documents).toHaveLength(3);
	expect(storedCase.documents.map(document=>document.documentSide).sort()).toEqual(['BACK','FRONT','SELFIE']);
	for(const width of [320,390,768,1440]){
		await page.setViewportSize({width,height:844});
		await expectNoHorizontalOverflow(page);
	}
});

test('market data routes fail closed when no live provider is configured',async({page})=>{
	const quotes=await page.request.get('/api/live-markets?symbols=AAPL,BTC');
	expect(quotes.ok()).toBe(true);
	const quoteData=await quotes.json();
	expect(quoteData.marketDataStatus).toBe('UNAVAILABLE');
	expect(quoteData.quotes).toHaveLength(2);
	for(const quote of quoteData.quotes){
		expect(quote).toHaveProperty('error');
		expect(quote).not.toHaveProperty('source');
		expect(quote).not.toHaveProperty('price');
	}
	const historyResponse=await page.request.get('/api/live-markets/AAPL?timeframe=1d');
	expect(historyResponse.status()).toBe(503);
	expect((await historyResponse.json()).code).toBe('MARKET_HISTORY_UNAVAILABLE');
});

test('signed-in users can ask AI to explain unavailable quote and history sources without substituting data',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	const quoteExplanation=page.getByRole('button',{name:'Quote availability'});
	await expect(quoteExplanation).toBeVisible();
	const requests:Array<{symbol:string;dataType:string;timeframe?:string}>=[];
	await page.route('**/api/market/data-explanation',async route=>{
		const payload=route.request().postDataJSON() as {symbol:string;dataType:'quote'|'history';timeframe?:string};
		requests.push(payload);
		await route.fulfill({json:{
			symbol:payload.symbol,
			dataType:payload.dataType,
			status:'internal_reference',
			explanation:{
				explanation:'Only internal reference data is currently available.',
				recommendedAction:'configure_market_provider',
				caveat:'This AI explanation does not provide live market data or investment advice.',
			},
		}});
	});

	await quoteExplanation.click();
	await expect(page.getByText('Only internal reference data is currently available.')).toBeVisible();
	const historyExplanation=page.getByRole('button',{name:'Chart history'});
	await expect(historyExplanation).toBeVisible();
	await historyExplanation.click();
	await expect(page.getByText('This AI explanation does not provide live market data or investment advice.')).toBeVisible();
	expect(requests).toHaveLength(2);
	expect(requests.map(request=>request.dataType)).toEqual(['quote','history']);
	const displayedSymbol=(await page.locator('.live-symbol-line > span').first().textContent())?.trim();
	expect(displayedSymbol).toBeTruthy();
	expect(requests.every(request=>request.symbol===displayedSymbol)).toBe(true);
});

test('portfolio timeframe controls filter authenticated snapshot history accessibly on mobile',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	const instrument=(await page.request.get('/api/market').then(response=>response.json())).find((item:{price:number})=>Number(item.price)<100);
	if(!instrument)throw new Error('The isolated market fixture has no affordable DEMO instrument.');
	const position=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt||instrument.updatedAt}});
	expect(position.status()).toBe(201);
	const portfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(portfolio.totalValue)).toBeCloseTo(Number(portfolio.cashBalance)+Number(portfolio.positionValue)+Number(portfolio.investmentValue),2);
	expect(Number(portfolio.totalInvested)).toBeCloseTo(portfolio.holdings.reduce((sum:number,item:{invested:string})=>sum+Number(item.invested),0),2);
	expect(Number(portfolio.totalCurrentValue)).toBeCloseTo(portfolio.holdings.reduce((sum:number,item:{value:string})=>sum+Number(item.value),0),2);
	expect(portfolio.allocations.reduce((sum:number,item:{percentage:string})=>sum+Number(item.percentage),0)).toBeCloseTo(100,2);
	await page.goto('/portfolio');
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.locator('.portfolio-page > .account-callout[role="status"]')).toHaveText('This is a virtual practice account. Its balance and trading records are separate from REAL account records.');
	await expect(page.locator('.portfolio-content-grid .account-panel-title .muted')).toHaveText('Practice prices');
	const controls=page.getByRole('group',{name:'Performance timeframe'});
	await controls.getByRole('button',{name:'1W'}).click();
	await expect(controls.getByRole('button',{name:'1W'})).toHaveAttribute('aria-pressed','true');
	await controls.getByRole('button',{name:'All'}).click();
	await expect(controls.getByRole('button',{name:'All'})).toHaveAttribute('aria-pressed','true');
	const holdingSearch=page.getByLabel('Search holdings');
	await expect(holdingSearch).toBeVisible();
	await holdingSearch.fill(instrument.name);
	await expect(page.locator('.portfolio-holding')).toHaveCount(1);
	await holdingSearch.fill('no-matching-holding');
	await expect(page.getByText('No holdings match these filters.')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('desktop 3D emblem renders with a mobile static fallback',async({browser})=>{
	const desktopContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
	await desktopContext.addInitScript(()=>{sessionStorage.setItem('aurevia-startup-complete','1')});
	try{
		const desktopPage=await desktopContext.newPage();
		await desktopPage.goto('/');
		await desktopPage.getByRole('button',{name:'Skip intro'}).click();
		await waitForStartup(desktopPage);
		const canvas=desktopPage.locator('.home-market-depth .market-depth-canvas canvas');
		if(await canvas.count()){
			await expect(canvas).toBeVisible();
			const image=PNG.sync.read(await canvas.screenshot());
			let visiblePixels=0;
			for(let index=0;index<image.data.length;index+=4){
				if(image.data[index+3]>4&&image.data[index]+image.data[index+1]+image.data[index+2]>24)visiblePixels++;
			}
			expect(visiblePixels,'desktop 3D canvas should render visible pixels').toBeGreaterThan(20);
		}else{
			await expect(desktopPage.locator('.home-market-depth .market-depth-fallback')).toBeVisible();
		}
		await expectNoHorizontalOverflow(desktopPage);
	}finally{
		await desktopContext.close();
	}

	const mobileContext=await browser.newContext({viewport:{width:320,height:800},reducedMotion:'reduce'});
	await mobileContext.addInitScript(()=>{sessionStorage.setItem('aurevia-startup-complete','1')});
	try{
		const mobilePage=await mobileContext.newPage();
		await mobilePage.goto('/');
		await expect(mobilePage.locator('.startup-screen')).toHaveCount(0);
		await expect(mobilePage.locator('.home-market-depth .market-depth-fallback')).toBeVisible();
		await expect(mobilePage.locator('.home-market-depth .market-depth-canvas')).toHaveCount(0);
		await expectNoHorizontalOverflow(mobilePage);
	}finally{
		await mobileContext.close();
	}
});

test('floating support launcher can be dragged horizontally and vertically',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.addInitScript(()=>{
		sessionStorage.setItem('aurevia-startup-complete','1');
		localStorage.setItem('aurevia-support-chat-position',JSON.stringify({left:1100,top:650}));
	});
	await page.goto('/');
	await waitForStartup(page);
	const launcher=await revealSupportChat(page);
	const initial=await launcher.boundingBox();
	expect(initial).not.toBeNull();
	if(!initial)return;
	await page.mouse.move(initial.x+28,initial.y+28);
	await page.mouse.down();
	await page.mouse.move(initial.x-292,initial.y-292,{steps:12});
	await page.mouse.up();
	await expect.poll(async()=>{
		const moved=await launcher.boundingBox();
		return moved?Math.abs(moved.x-initial.x):0;
	}).toBeGreaterThan(100);
	await expect.poll(async()=>{
		const moved=await launcher.boundingBox();
		return moved?Math.abs(moved.y-initial.y):0;
	}).toBeGreaterThan(100);
	await expect(launcher).toBeVisible();
});

test('Vercel scheduled market tick requires its secret and advances simulated prices',async({page})=>{
	const unauthorized = await page.request.get('/api/cron/market-tick');
	expect(unauthorized.status()).toBe(401);
	const authorized = await page.request.get('/api/cron/market-tick', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
	expect(authorized.status()).toBe(200);
	expect(await authorized.json()).toMatchObject({ ok: true, updated: expect.any(Number) });
});

test('waitlist form submits and shows a truthful success state',async({page})=>{
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/waitlist');
	await expect(page.locator('.waitlist-page')).toHaveAttribute('data-waitlist-ready', 'true');
	await waitForStartup(page);
	const policyConsent=page.getByRole('dialog',{name:'Review before continuing'});
	if(await policyConsent.isVisible())await policyConsent.getByRole('button',{name:/^Accept terms/}).click();
	const waitlistName = page.locator('.waitlist-form input[autocomplete="name"]');
	const waitlistEmail = page.locator('.waitlist-form input[autocomplete="email"]');
	await waitlistName.fill('Temporary E2E Waitlist');
	await expect(waitlistName).toHaveValue('Temporary E2E Waitlist');
	const email = `waitlist-${randomUUID()}@example.invalid`;
	await waitlistEmail.fill(email);
	await expect(waitlistEmail).toHaveValue(email);
	await page.locator('.waitlist-form select').first().selectOption('US');
	await page.locator('.waitlist-form input[type="checkbox"]').check();
	await page.getByRole('button', { name: /Join (the )?waitlist/i }).click();
	await expect(page.locator('.waitlist-success')).toContainText(/waitlist|access|request/i);
	await expect(page.locator('.waitlist-page')).not.toContainText(/position\s*#?\d+/i);
	await expectNoHorizontalOverflow(page);
});

test('mobile navigation opens and navigates to Login',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	const policyConsent=page.getByRole('dialog',{name:'Review before continuing'});
	if(await policyConsent.isVisible())await policyConsent.getByRole('button',{name:/^Accept terms/}).click();
	await waitForStartup(page);
	await page.getByRole('button',{name:'Open navigation'}).click();
	const nav=page.getByRole('navigation',{name:'Primary navigation'});
	await expect(nav).toBeVisible();
	const firstLink=nav.getByRole('link').first();
	await expect.poll(()=>firstLink.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	await page.getByRole('button',{name:'Close navigation'}).click();
	await expect(page.getByRole('button',{name:'Open navigation'})).toHaveAttribute('aria-expanded','false');
	await page.getByRole('button',{name:'Open navigation'}).click();
	await nav.getByRole('link',{name:'Sign in'}).click();
	await expect(page).toHaveURL(/\/login$/);
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('login and registration fields receive real pointer and keyboard input',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	await waitForStartup(page);
	const identifier=page.getByLabel('Email address');
	const password=page.getByLabel('Password',{exact:true});
	await typeInto(page,identifier,'invalid-user@example.test');
	await typeInto(page,password,'NotARealPassword123!');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await expect(password).toHaveValue('NotARealPassword123!');
	await page.getByRole('button',{name:'Hide password'}).click();
	await page.getByRole('button',{name:'Sign in'}).click();
	await expect(page.getByRole('alert').filter({hasText:'Sign-in details are incorrect.'})).toBeVisible();
	await expect(identifier).toHaveValue('invalid-user@example.test');

	await page.goto('/register');
	await waitForStartup(page);
	await typeInto(page,page.getByRole('textbox',{name:'First name'}),'Browser');
	await typeInto(page,page.getByLabel('Last name'),'Input Test');
	const dateOfBirth=page.getByLabel('Date of birth');
	await dateOfBirth.click();
	await expect.poll(()=>dateOfBirth.evaluate(element=>document.activeElement===element)).toBe(true);
	await dateOfBirth.fill('1990-01-01');
	await expect(dateOfBirth).toHaveValue('1990-01-01');
	await selectRegistrationCountry(page,/country of residence/i,'United States','US','+1');
	await page.getByRole('button',{name:'Continue'}).click();
	await page.getByLabel(/City/).fill('New York');
	await page.getByLabel(/Street address/).fill('123 Test Street');
	await page.getByRole('button',{name:'Continue'}).click();
	await typeInto(page,page.getByLabel('Email address'),'input-test@example.test');
	await page.getByLabel('Account mode').selectOption('DEMO');
	await page.getByRole('button',{name:'Continue'}).click();
	const registrationPassword=page.getByLabel(/^Password/);
	await typeInto(page,registrationPassword,'ValidPassword123!');
	await page.getByRole('button',{name:'Show password'}).first().click();
	await expect(registrationPassword).toHaveAttribute('type','text');
	await page.getByRole('button',{name:'Hide password'}).first().click();
	await expect(registrationPassword).toHaveAttribute('type','password');
	await typeInto(page,page.getByLabel('Confirm password'),'ValidPassword123!');
	await page.getByRole('button',{name:'Continue'}).click();
	const legalCheckboxes=page.locator('.registration-legal-list .registration-legal-item input[type="checkbox"]');
	const acceptAllPolicies=page.getByRole('checkbox',{name:/accept all required policies/i});
	await expect(acceptAllPolicies).toBeVisible();
	await acceptAllPolicies.check();
	for(let index=0;index<await legalCheckboxes.count();index++)await expect(legalCheckboxes.nth(index)).toBeChecked();
	await legalCheckboxes.first().uncheck();
	await expect(acceptAllPolicies).not.toBeChecked();
	await legalCheckboxes.first().check();
	await expect(acceptAllPolicies).toBeChecked();
	await page.getByRole('button',{name:'Continue'}).click();
	await expect(page.getByRole('heading',{name:'Final review'})).toBeVisible();
	await page.setViewportSize({width:320,height:844});
	await expectNoHorizontalOverflow(page);
});

test('password recovery stays private and usable across mobile and desktop widths',async({page})=>{
	await page.route('**/api/password-reset/request',route=>route.fulfill({
		status:202,
		contentType:'application/json',
		body:JSON.stringify({message:'If an eligible account matches, recovery instructions may be emailed. If no email arrives, contact support.'}),
	}));
	await page.route('**/api/password-reset/confirm',async route=>{
		const body=route.request().postDataJSON() as {token:string;password:string};
		expect(body.token).toBe('R'.repeat(43));
		expect(body.password).toBe('ChangedPassword1');
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true})});
	});

	await page.setViewportSize({width:320,height:800});
	await page.goto('/forgot-password');
	await waitForStartup(page);
	await page.getByLabel('Email address').fill('person@example.invalid');
	await page.getByRole('button',{name:'Continue recovery'}).click();
	await expect(page.getByRole('status')).toContainText('If an eligible account matches');
	await expectNoHorizontalOverflow(page);

	const resetResponse=await page.goto(`/reset-password#token=${'R'.repeat(43)}`);
	expect(resetResponse?.headers()['referrer-policy']).toBe('no-referrer');
	const newPassword=page.getByRole('textbox',{name:'New password',exact:true});
	const confirmPassword=page.getByRole('textbox',{name:'Confirm new password',exact:true});
	await expect(newPassword).toBeVisible();
	await expect(page).toHaveURL(/\/reset-password$/);
	for(const width of [320,390,768,1440,1920]){
		await page.setViewportSize({width,height:900});
		await expectNoHorizontalOverflow(page);
	}
	await newPassword.fill('ChangedPassword1');
	await confirmPassword.fill('ChangedPassword1');
	await page.getByRole('button',{name:'Change password'}).click();
	await expect(page.getByRole('status')).toContainText('Password changed');
});

test('password reset consumes a database token and changes the account password',async({page})=>{
	const user=await createIsolatedDemoUser('password-reset');
	const record=await db.user.findUniqueOrThrow({where:{email:user.email},select:{id:true}});
	const token=`${randomUUID()}${randomUUID()}`;
	const tokenHash=createHash('sha256').update(token).digest('hex');
	const reset=await db.passwordResetToken.create({data:{
		userId:record.id,
		tokenHash,
		expiresAt:new Date(Date.now()+30*60_000),
	}});
	const response=await page.request.post('/api/password-reset/confirm',{
		data:{token,password:'ChangedPassword1'},
	});

	expect(response.status()).toBe(200);
	expect(await response.json()).toEqual({ok:true});
	const updatedUser=await db.user.findUniqueOrThrow({where:{id:record.id},select:{passwordHash:true,activeSessionId:true}});
	expect(await bcrypt.compare('ChangedPassword1',updatedUser.passwordHash)).toBe(true);
	expect(updatedUser.activeSessionId).toBeNull();
	expect((await db.passwordResetToken.findUniqueOrThrow({where:{id:reset.id}})).consumedAt).not.toBeNull();
	expect((await page.request.post('/api/password-reset/confirm',{data:{token,password:'ChangedPassword1'}})).status()).toBe(400);

	await page.goto('/wallet/transactions?tab=history');
	await expect(page).toHaveURL(/\/login\?callbackUrl=/);
	await waitForStartup(page);
	await page.getByLabel('Email address').fill(user.email);
	await page.getByLabel('Password',{exact:true}).fill('ChangedPassword1');
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(url=>url.pathname==='/wallet/transactions'&&url.searchParams.get('tab')==='history');
	await expect(page.getByRole('heading',{level:1,name:'Transaction history',exact:true})).toBeVisible();
	const policyAcceptance=await page.request.get('/api/policy-consent').then(response=>response.json());
	if(!policyAcceptance.accepted){
		const accepted=await page.request.post('/api/policy-consent',{data:{version:policyAcceptance.version,accepted:true}});
		expect(accepted.status()).toBe(200);
		await page.reload();
	}
	await page.getByRole('button',{name:'View history'}).click();
	await expect(page.getByRole('heading',{name:'Funding requests'})).toBeVisible();
});

test('dashboard hierarchy remains usable and contained at mobile and desktop widths',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const profile=await page.request.get('/api/profile').then(response=>response.json());
	await page.goto('/dashboard');
	for(const width of [320,375,390,430,1440]){
		await page.setViewportSize({width,height:900});
		if(width<=760){
			await expect(page.locator('.mobile-home-greeting')).toBeVisible();
			await expect(page.locator('.mobile-home-greeting .account-tier-badge')).toHaveText(profile.label);
			await expect(page.locator('.mobile-balance-card')).toBeVisible();
			await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
			await expect(page.locator('.user-activity-disclosure summary')).toContainText('Recent activity');
			const avatar=page.locator('.mobile-home-avatar');
			const avatarStyle=await avatar.evaluate(element=>{
				const style=getComputedStyle(element);
				const bounds=element.getBoundingClientRect();
				return {width:bounds.width,height:bounds.height,borderRadius:style.borderRadius,overflow:style.overflow,flexShrink:style.flexShrink};
			});
			expect(avatarStyle).toEqual({width:44,height:44,borderRadius:'50%',overflow:'hidden',flexShrink:'0'});
			const avatarImage=avatar.locator('img');
			if(await avatarImage.count()){
				const imageSize=await avatarImage.evaluate(image=>{
					const bounds=image.getBoundingClientRect();
					const container=image.parentElement?.getBoundingClientRect();
					return {width:bounds.width,height:bounds.height,containerWidth:container?.width??0,containerHeight:container?.height??0};
				});
				expect(imageSize.width).toBeGreaterThan(0);
				expect(imageSize.height).toBeGreaterThan(0);
				expect(imageSize.width).toBeLessThanOrEqual(imageSize.containerWidth);
				expect(imageSize.height).toBeLessThanOrEqual(imageSize.containerHeight);
				expect(imageSize.width).toBeCloseTo(imageSize.height,1);
				await expect(avatarImage).toHaveCSS('object-fit','cover');
				await expect(avatarImage).toHaveCSS('object-position','50% 50%');
			}
		}else{
			await expect(page.getByRole('heading',{name:/Welcome back/})).toBeVisible();
			await expect(page.locator('.dashboard-sidebar-profile .account-tier-badge')).toHaveText(profile.label);
			await expect(page.locator('.user-tier-progress')).toHaveCount(0);
			await expect(page.getByRole('heading',{name:'Market watch'})).toBeVisible();
			await expect(page.getByRole('heading',{name:'My portfolio'})).toBeVisible();
			await expect(page.locator('.dashboard-profile-panel')).toHaveCount(0);
		}
		await expectNoHorizontalOverflow(page);
		if(width>760){
			const layout=await page.evaluate(()=>{
				const dashboard=document.querySelector('.user-dashboard-columns');
				const panels=[...document.querySelectorAll('.user-dashboard-columns > div')].map(panel=>{
					const rect=panel.getBoundingClientRect();
					return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
				});
				return {columns:getComputedStyle(dashboard!).gridTemplateColumns.split(' ').length,panels};
			});
			expect(layout.columns).toBe(2);
			for(let index=0;index<layout.panels.length;index++){
				for(let other=index+1;other<layout.panels.length;other++){
					const a=layout.panels[index],b=layout.panels[other];
					const overlaps=a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1;
					expect(overlaps,`portfolio panels ${index} and ${other} overlap at ${width}px`).toBe(false);
				}
			}
		}
	}
	await expect(page.locator('.user-topbar-identity .account-tier-badge')).toHaveText(profile.label);
	await page.setViewportSize({width:390,height:844});
	await page.getByRole('navigation',{name:'Primary account navigation'}).getByRole('button',{name:'More navigation'}).click();
	await expect(page.locator('.user-more-profile .account-tier-badge')).toHaveText(profile.label);
	await page.goto('/settings#profile');
	await expect(page.locator('.account-profile-identity .account-tier-badge')).toHaveText(profile.label);
});

test('opening the dashboard from the wallet avoids loading its chart before overview data',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.setViewportSize({width:390,height:844});
	await page.goto('/wallet');
	let dashboardNavigationStarted=false;
	let overviewResolved=false;
	let chartRequestedBeforeOverview=false;
	page.on('response',response=>{
		if(new URL(response.url()).pathname==='/api/dashboard/overview')overviewResolved=true;
	});
	page.on('request',request=>{
		const path=new URL(request.url()).pathname;
		if(dashboardNavigationStarted&&!overviewResolved&&path.startsWith('/api/live-markets/'))chartRequestedBeforeOverview=true;
	});
	dashboardNavigationStarted=true;
	await page.locator('a[href="/dashboard"]:visible').first().click();
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	expect(chartRequestedBeforeOverview).toBe(false);
});

test('dashboard loading surface follows the active theme on mobile',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.setViewportSize({width:390,height:844});
	let releaseOverview!:()=>void;
	const overviewGate=new Promise<void>(resolve=>{releaseOverview=resolve});
	await page.route('**/api/dashboard/overview',async route=>{
		await overviewGate;
		await route.continue();
	});

	try{
		await page.goto('/dashboard');
		const loadingPage=page.locator('main.user-dashboard-page--loading');
		await expect(loadingPage).toBeVisible();
		const colors=await loadingPage.evaluate(element=>{
			document.documentElement.dataset.themeName='forest-green';
			return {
				background:getComputedStyle(element).backgroundColor,
				body:getComputedStyle(document.body).backgroundColor,
			};
		});
		expect(colors.background).toBe(colors.body);
		expect(colors.background).not.toBe('rgb(249, 251, 253)');
	}finally{
		releaseOverview();
	}
});

test('authenticated bottom navigation stays fixed across viewports and More destinations',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const navigation=page.getByRole('navigation',{name:'Primary account navigation'});
	const moreButton=navigation.getByRole('button',{name:'More navigation'});
	for(const viewport of [{width:320,height:800},{width:390,height:844},{width:768,height:1024}]){
		await page.setViewportSize(viewport);
		await page.goto('/dashboard');
		await expect(navigation).toBeVisible();
		await expect(page.getByRole('button',{name:'More account navigation'})).toBeHidden();
		const geometry=await navigation.evaluate(element=>{
			const rect=element.getBoundingClientRect();
			return {position:getComputedStyle(element).position,left:rect.left,right:rect.right,bottom:rect.bottom,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight};
		});
		expect(geometry.position).toBe('fixed');
		expect(geometry.left).toBeGreaterThanOrEqual(0);
		expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
		for(const [name,href] of [['Dashboard','/dashboard'],['Markets','/markets'],['Trade markets','/trade'],['Portfolio','/portfolio']] as const){
			await expect(navigation.getByRole('link',{name,exact:true})).toHaveAttribute('href',href);
		}
		await expect(navigation.getByRole('button',{name:'More navigation'})).toBeVisible();
		await expect(navigation.getByRole('link',{name:'Dashboard',exact:true})).toHaveAttribute('aria-current','page');
		await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
		await expect(navigation).toBeInViewport();
		await expectNoHorizontalOverflow(page);
	}
	for(const viewport of [{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await page.goto('/dashboard');
		const sidebar=page.locator('.dashboard-sidebar');
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByRole('link',{name:'Overview'})).toHaveAttribute('href','/dashboard');
		await expect(sidebar.getByRole('link',{name:'Markets'})).toHaveAttribute('href','/markets');
	}
	expect(await page.getByRole('navigation',{name:'Administrator navigation'}).count()).toBe(0);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/dashboard');
	await expect(navigation.getByRole('link',{name:'Dashboard',exact:true})).toHaveClass(/is-active/);
	await expect(moreButton).toBeVisible();
	await selectAccountMode(page,'REAL');
	await moreButton.click();
	const moreMenu=page.getByRole('dialog',{name:'More'});
	await expect(moreMenu).toBeVisible();
	for(const label of ['Markets','Trade','Portfolio','Investments','Orders','Wallet','Deposits','Withdrawals','Transaction history','Notifications','Identity verification / KYC','Digital cards','Profile','Account settings','Security','Help and support','Tax services','Tier / membership','Testimonials','Logout']){
		await expect(moreMenu.getByRole('link',{name:label}).or(moreMenu.getByRole('button',{name:label}))).toBeVisible();
	}
	await moreMenu.getByRole('link',{name:'Transaction history'}).click();
	await expect(page).toHaveURL(/\/wallet\/transactions/);
	await expect(moreButton).toHaveAttribute('aria-expanded','false');
	await expect(moreButton).toHaveClass(/is-active/);
	await selectAccountMode(page,'DEMO');
	await page.goto('/dashboard');
	await moreButton.click();
	const demoMoreMenu=page.getByRole('dialog',{name:'More'});
	for(const label of ['Investments','Deposits','Withdrawals','Transaction history','Currency conversion','Identity verification / KYC','Digital cards','Tax services']){
		await expect(demoMoreMenu.getByRole('link',{name:label})).toHaveCount(0);
	}
	for(const label of ['Markets','Trade','Portfolio','Orders','Wallet','Account activity']){
		await expect(demoMoreMenu.getByRole('link',{name:label})).toBeVisible();
	}
});

test('mobile account menu follows the forest green theme',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const response=await page.request.patch('/api/theme-preference',{data:{theme:'forest-green'}});
	expect(response.ok()).toBeTruthy();
	await page.setViewportSize({width:390,height:844});
	await page.goto('/dashboard');
	await expect(page.locator('html')).toHaveAttribute('data-theme-name','forest-green');
	await page.getByRole('navigation',{name:'Primary account navigation'}).getByRole('button',{name:'More navigation'}).click();
	const menu=page.getByRole('dialog',{name:'More'});
	await expect(menu).toHaveCSS('background-color','rgb(16, 27, 21)');
	await expect(menu.locator('.user-more-group a').first()).toHaveCSS('background-color','rgb(18, 32, 25)');
});

test('authenticated home market uses REAL provider candles and keeps account navigation off the homepage',async({page})=>{
	const homeUser=await createIsolatedDemoUser('home-market');
	await loginAs(page,homeUser.email,homeUser.password);
	await expect(page.locator('.user-dashboard-metrics')).toBeVisible();
	await selectAccountMode(page,'REAL');
	const quote={
		asset:{id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},
		price:67000,bid:66999,ask:67001,change:420,changePercent:0.63,marketStatus:'OPEN',
		previousClose:66580,open:66580,volume:1200,dayLow:66000,dayHigh:67500,
		fiftyTwoWeekLow:42000,fiftyTwoWeekHigh:73000,updatedAt:new Date().toISOString(),
		isStale:false,sparkline:[],source:'Twelve Data',
	};
	await page.route('**/api/live-markets**',async route=>{
		const url=new URL(route.request().url());
		if(url.pathname==='/api/live-markets/BTC'){
			await route.fulfill({json:{
				quote,candles:[
					{time:1_794_000_000,open:66500,high:66800,low:66400,close:66700,volume:100},
					{time:1_794_003_600,open:66700,high:67100,low:66600,close:67000,volume:120},
				],timeframe:'1d',interval:'1h',source:'Twelve Data',
			}});
			return;
		}
		if(url.pathname==='/api/live-markets'){
			await route.fulfill({json:{quotes:[quote],marketDataStatus:'LIVE'}});
			return;
		}
		await route.continue();
	});

	await page.goto('/');
	await expect(page.getByRole('group',{name:'Account mode'})).toBeVisible();
	await expect(page.locator('.site-nav-user-shell .notification-bell-button')).toBeVisible();
	await expect(page.locator('.user-market-search')).toHaveCount(0);
	await expect(page.getByRole('navigation',{name:'Primary account navigation'})).toHaveCount(0);
	await expect(page.locator('.user-topbar-identity')).toHaveCount(0);
	await expect(page.getByRole('img',{name:'Interactive live market candlestick and volume chart'})).toBeVisible();
	await expect(page.getByRole('group',{name:'Chart timeframe'}).getByRole('button',{name:'1D'})).toBeVisible();

	await page.setViewportSize({width:390,height:844});
	await page.locator('.site-nav-user-shell .brand').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.user-market-search')).toHaveCount(0);
	await expect(page.getByRole('navigation',{name:'Primary account navigation'})).toHaveCount(0);
});

test('REAL home market keeps history unavailable and permits a retry without provider data',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	let historyRequests=0;
	await page.route('**/api/live-markets**',async route=>{
		const url=new URL(route.request().url());
		if(url.pathname==='/api/live-markets/BTC'){
			historyRequests++;
			await route.fulfill({status:503,json:{error:'Historical market data is temporarily unavailable.'}});
			return;
		}
		if(url.pathname==='/api/live-markets'){
			await route.fulfill({json:{quotes:[],marketDataStatus:'UNAVAILABLE'}});
			return;
		}
		await route.continue();
	});

	await page.goto('/');
	const historyError=page.locator('.market-chart-empty[role="alert"]');
	await expect(historyError).toContainText('Historical market data is temporarily unavailable.');
	const failedRequestsBeforeRetry=historyRequests;
	expect(failedRequestsBeforeRetry).toBeGreaterThan(0);
	await page.getByRole('button',{name:'Retry history'}).click();
	await expect.poll(()=>historyRequests).toBeGreaterThan(failedRequestsBeforeRetry);
	await expect(historyError).toContainText('Historical market data is temporarily unavailable.');
	await expect(page.getByRole('img',{name:'Interactive live market candlestick and volume chart'})).toHaveCount(0);
});

test('global chat support persists its position and exchanges private admin messages',async({browser,page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/login');
	await waitForStartup(page);
	await expect(page.getByRole('button',{name:'Show chat support'})).toBeVisible();
	const launcher=await revealSupportChat(page);
	await expect(launcher).toBeVisible();
	await launcher.click();
	await expect(page.getByText('Sign in to send a private message to admin support.')).toBeVisible();
	await page.getByRole('button',{name:'Close chat support'}).click();
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.evaluate(()=>localStorage.setItem('aurevia-support-chat-position',JSON.stringify({left:220,top:500})));
	await page.reload();
	const floatingLauncher=await revealSupportChat(page);
	const before=await floatingLauncher.boundingBox();
	expect(before).not.toBeNull();
	const startX=before!.x+before!.width/2;
	const startY=before!.y+before!.height/2;
	await page.mouse.move(startX,startY);
	await page.mouse.down();
	await page.mouse.move(startX-120,startY-120,{steps:8});
	await page.mouse.up();
	await expect.poll(async()=>{
		const moved=await floatingLauncher.boundingBox();
		return moved?Math.abs(moved.x-before!.x)+Math.abs(moved.y-before!.y):0;
	}).toBeGreaterThan(40);
	const savedPosition=await page.evaluate(()=>{
		const value=localStorage.getItem('aurevia-support-chat-position');
		return value?JSON.parse(value) as {left:number;top:number}:null;
	});
	expect(savedPosition).not.toBeNull();
	await page.goto('/markets');
	const restoredLauncher=await revealSupportChat(page);
	await expect.poll(async()=>{
		const afterNavigation=await restoredLauncher.boundingBox();
		return afterNavigation?{x:Math.round(afterNavigation.x),y:Math.round(afterNavigation.y)}:null;
	}).toEqual({x:Math.round(savedPosition!.left),y:Math.round(savedPosition!.top)});
	await (await revealSupportChat(page)).click();
	const subject=`Floating support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Please have an administrator reply to this private support request.');
	await page.getByRole('button',{name:'Send to admin'}).click();
	await expect(page.locator('.floating-support-notice')).toContainText('sent to the admin support inbox');
	const conversations=await page.request.get('/api/support').then(response=>response.json());
	const conversation=conversations.find((item:{subject:string})=>item.subject===subject);
	expect(conversation).toBeTruthy();
	const adminContext=await browser.newContext();
	let publishedStoryId:string|undefined;
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await adminPage.goto('/admin');
		await expect(adminPage.locator('.floating-support')).toHaveCount(0);
		await expect(adminPage.locator('.admin-topbar-icon .admin-unread-dot')).toBeVisible();
		await adminPage.getByRole('link',{name:/View notifications and audit activity/}).click();
		await expect(adminPage).toHaveURL(/\/admin\/audit-logs/);
		await expect(adminPage.locator('.admin-topbar-icon .admin-unread-dot')).toHaveCount(0);
		const storyResponse=await adminPage.request.post('/api/admin/client-stories',{data:{
			displayName:'Aurevia editorial testimonial',
			title:'A simpler way to manage my finances',
			quote:'The platform gives me a clear view of my account.',
			rating:5,
			imageReference:'/client-stories/e2e-portrait.png',
			consentConfirmed:true,
			publicationStatus:'PUBLISHED',
			source:'admin',
		}});
		expect(storyResponse.status()).toBe(201);
		const story=await storyResponse.json();
		publishedStoryId=story.id;
		expect(story).toMatchObject({userId:null,title:'A simpler way to manage my finances',rating:5,publicationStatus:'PUBLISHED',verifiedClient:false});
		const publicStories=await adminPage.request.get('/api/client-stories').then(response=>response.json());
		expect(publicStories).toContainEqual(expect.objectContaining({id:story.id,title:story.title,rating:5,verifiedClientStory:false}));
		await page.setViewportSize({width:390,height:844});
		const missingPortrait=page.waitForResponse(response=>response.url().includes('/client-stories/e2e-portrait.png'));
		await page.goto('/client-stories');
		const testimonial=page.locator('.client-testimonial-card').filter({hasText:story.displayName});
		await expect(testimonial).toBeVisible();
		await expect(testimonial.getByRole('heading',{name:story.title})).toBeVisible();
		await expect(testimonial.getByText(story.quote)).toBeVisible();
		expect((await missingPortrait).status()).toBe(404);
		await expect(testimonial.locator('.client-testimonial-monogram')).toHaveText('A');
		await expect(testimonial.getByRole('img',{name:`Portrait for ${story.displayName}`})).toHaveCount(0);
		for(const viewport of [{width:390,height:844},{width:1280,height:800}]){
			await page.setViewportSize(viewport);
			await expectNoHorizontalOverflow(page);
			const portraitBox=await testimonial.locator('.client-testimonial-photo').boundingBox();
			expect(portraitBox?.width).toBeGreaterThan(80);
			expect(portraitBox?.height).toBeGreaterThan(100);
		}
		const hiddenStory=await adminPage.request.patch('/api/admin/client-stories',{data:{storyId:story.id,publicationStatus:'DRAFT'}});
		expect(hiddenStory.ok()).toBe(true);
		publishedStoryId=undefined;
		expect(await adminPage.request.get('/api/client-stories').then(response=>response.json())).not.toContainEqual(expect.objectContaining({id:story.id}));
		const inbox=await adminPage.request.get('/api/admin/support').then(response=>response.json());
		expect(inbox.some((item:{id:string})=>item.id===conversation.id)).toBe(true);
		const response=await adminPage.request.patch('/api/admin/support',{data:{action:'reply',conversationId:conversation.id,message:'Admin reply from the isolated end-to-end test.'}});
		expect(response.ok()).toBe(true);
	}finally{
		if(publishedStoryId)await adminContext.request.patch('/api/admin/client-stories',{data:{storyId:publishedStoryId,publicationStatus:'DRAFT'}});
		await adminContext.close();
	}
	const openChat=page.getByRole('button',{name:'Open chat support, new messages'});
	if(await openChat.count())await openChat.click();
	const closeChat=page.getByRole('button',{name:'Close chat support'});
	if(await closeChat.count())await closeChat.click();
	await expect(page.locator('.floating-support-unread-dot')).toBeVisible({timeout:15_000});
	await (await revealSupportChat(page)).click();
	await expect(page.locator('.floating-support-unread-dot')).toHaveCount(0);
	await expect(page.locator('.floating-support-messages')).toContainText('Admin reply from the isolated end-to-end test.');
	await expectNoHorizontalOverflow(page);
});

test('language selection persists Arabic RTL direction and remains responsive',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	await waitForStartup(page);
	const languageTrigger=page.getByRole('button',{name:/Select language:/});
	await languageTrigger.click();
	await page.getByRole('menuitemradio',{name:/العربية/}).click();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expect.poll(()=>page.evaluate(()=>localStorage.getItem('aurevia-locale'))).toBe('ar');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('lang','ar');
	await expect(page.locator('html')).toHaveAttribute('dir','rtl');
	await expectNoHorizontalOverflow(page);
});

test('language selector supports keyboard navigation, outside dismissal, and focus restoration',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	await waitForStartup(page);
	const trigger=page.getByRole('button',{name:/Select language:/});
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	const menu=page.getByRole('menu',{name:/Languages/});
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitemradio').first()).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.locator('body').click({position:{x:5,y:5}});
	await expect(menu).toBeHidden();
	await expect(trigger).not.toBeFocused();
	await expectNoHorizontalOverflow(page);
});

test('startup releases page interaction if session initialization is delayed',async({page})=>{
	let releaseSession!:()=>void;
	const sessionGate=new Promise<void>(resolve=>{releaseSession=resolve});
	await page.route('**/api/auth/session',async route=>{
		await sessionGate;
		await route.fulfill({status:200,contentType:'application/json',body:'{}'});
	});
	await page.goto('/login');
	await waitForStartup(page);
	const startup=page.getByRole('status',{name:'Loading Aurevia Exchange'});
	await expect(startup).toHaveCount(0);
	const email=page.getByLabel('Email address');
	await email.fill('qa@example.invalid');
	await expect(email).toHaveValue('qa@example.invalid');
	await expect(page.locator('.scene-content > div[inert]')).toHaveCount(0);
	releaseSession();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.getByRole('navigation',{name:'Website navigation'}).getByRole('link',{name:'Create an account'}).click();
	await expect(page.getByRole('heading',{name:'Welcome to Aurevia Exchange.'})).toBeVisible();
	await expect(startup).toBeHidden();
	await page.goBack();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await page.reload();
	await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expect(startup).toBeHidden();
});

test('market refresh runs in place without reloading the page',async({page})=>{
	let documentRequests=0;
	let quoteRequests=0;
	let historyRequests=0;
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	page.on('request',request=>{if(request.resourceType()==='document')documentRequests++});
	await page.route(/\/api\/live-markets\?symbols=/,route=>{
		quoteRequests++;
		return route.fulfill({status:200,contentType:'application/json',body:'{"quotes":[],"source":"isolated UI test"}'});
	});
	await page.route(/\/api\/live-markets\/[^?]+\?timeframe=/,async route=>{
		const timeframe=new URL(route.request().url()).searchParams.get('timeframe');
		historyRequests++;
		await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({quote:null,candles:[],timeframe,interval:'1m'})});
	});
	await page.goto('/markets');
	await waitForStartup(page);
	const beforeRetry=documentRequests;
	await expect.poll(()=>historyRequests).toBeGreaterThan(0);
	const priorQuotes=quoteRequests;
	const priorHistory=historyRequests;
	await page.getByRole('button',{name:/Refresh quotes|Actualizar cotizaciones/i}).click();
	await expect.poll(()=>quoteRequests).toBeGreaterThan(priorQuotes);
	await expect.poll(()=>historyRequests).toBeGreaterThan(priorHistory);
	expect(documentRequests).toBe(beforeRetry);
});

test('quote-feed failures do not show chart errors and failed history refresh preserves loaded candles',async({page})=>{
	let historyRequests=0;
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.route(/\/api\/live-markets\?symbols=/,route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:'not-json',
	}));
	await page.route(/\/api\/live-markets\/[^?]+\?timeframe=/,async route=>{
		historyRequests++;
		if(historyRequests===1){
			return route.fulfill({
				status:200,
				contentType:'application/json',
				body:JSON.stringify({
					source:'Twelve Data',
					timeframe:'1m',
					interval:'1m',
					quote:null,
					candles:[{
						time:Math.floor(Date.now()/60_000)*60,
						open:41_900,high:42_100,low:41_800,close:42_000,volume:125,
					}],
				}),
			});
		}
		return route.fulfill({
			status:200,
			contentType:'application/json',
			body:JSON.stringify({error:'Historical market data is temporarily unavailable.'}),
		});
	});

	await page.goto('/markets');
	await waitForStartup(page);
	await expect(page.locator('.live-chart-readout')).toContainText('O 41,900.00');
	await expect(page.locator('.live-data-alert[role="alert"]')).toHaveCount(0);

	await page.getByRole('button',{name:/Refresh quotes|Actualizar cotizaciones/i}).click();
	await expect(page.getByRole('button',{name:'Retry chart history'})).toBeVisible();
	await expect(page.locator('.live-chart-readout')).toContainText('O 41,900.00');
	expect(historyRequests).toBeGreaterThan(1);
});

test('watchlists persist across refresh and remain isolated between accounts',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	const sidebar=page.getByRole('complementary',{name:/Watchlists|Listas de seguimiento/i});
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await page.getByRole('button',{name:/Create watchlist|Crear lista de seguimiento/i}).click();
	await page.getByLabel(/New watchlist name|Nombre de la nueva lista/i).fill('User A private list');
	await page.getByRole('button',{name:/Save watchlist|Guardar lista/i}).click();
	await page.getByRole('button',{name:/Add symbol|Añadir símbolo/i}).click();
	await page.getByLabel(/Search for a symbol to add|Buscar símbolo para añadir/i).fill('AAPL');
	await page.locator('.live-symbol-results').getByRole('button').filter({hasText:'AAPL'}).click();
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
	await page.reload();
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();

	await logout(page);
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(0);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toHaveCount(0);

	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/markets');
	await expect(sidebar).toHaveAttribute('aria-busy','false');
	await expect(page.locator('#watchlist-select option',{hasText:'User A private list'})).toHaveCount(1);
	await expect(page.locator('.live-watch-row').filter({hasText:'AAPL'})).toBeVisible();
});

test('country selector searches Nigeria and United Kingdom and shows their dialing codes',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	await waitForStartup(page);
	await page.getByRole('textbox',{name:'First name'}).fill('Country');
	await page.getByRole('textbox',{name:'Last name'}).fill('Selector');
	await page.locator('input[type="date"]').fill('1990-01-01');
	await selectRegistrationCountry(page,/country of residence/i,'United States','US','+1');
	await page.getByRole('button',{name:'Continue'}).click();
	await page.getByLabel(/City/).fill('New York');
	await page.getByLabel(/Street address/).fill('123 Test Street');
	await page.getByRole('button',{name:'Continue'}).click();
	const picker=page.getByRole('button',{name:/phone country and calling code/i});
	await expect(picker).toHaveAttribute('aria-label',/United States \+1/);
	await picker.click();
	const dialog=page.getByRole('dialog',{name:'Select phone country and calling code'});
	await expect(dialog).toBeVisible();
	await expectNoHorizontalOverflow(page);
	const search=dialog.getByRole('searchbox');
	await search.fill('Nigeria');
	const nigeria=dialog.getByRole('option',{name:/Nigeria.*NG.*\+234/});
	await expect(nigeria).toBeVisible();
	await search.press('ArrowDown');
	await expect(nigeria).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(picker).toHaveAttribute('aria-label',/Nigeria \+234/);
	await picker.click();
	const ukDialog=page.getByRole('dialog',{name:'Select phone country and calling code'});
	await ukDialog.getByRole('searchbox').fill('United Kingdom');
	const uk=ukDialog.getByRole('option',{name:/United Kingdom.*GB.*\+44/});
	await expect(uk).toBeVisible();
	await uk.click();
	await expect(picker).toHaveAttribute('aria-label',/United Kingdom \+44/);
	await expectNoHorizontalOverflow(page);
});

test('mobile date entry is calendar-backed and future dates are blocked',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/register');
	const date=page.locator('input[type="date"]:visible');
	await expect(date).toHaveCount(1);
	await expect(date).toHaveAttribute('type','date');
	await expect(date).toHaveAttribute('max',new Date().toISOString().slice(0,10));
	const future=new Date();future.setUTCDate(future.getUTCDate()+1);
	const futureDate=future.toISOString().slice(0,10);
	const futureConstraint=await date.evaluate((input:HTMLInputElement,value)=>{
		input.value=value;
		return {value:input.value,rangeOverflow:input.validity.rangeOverflow};
	},futureDate);
	expect(futureConstraint).toEqual({value:futureDate,rangeOverflow:true});
	await expectNoHorizontalOverflow(page);
});

test('sign-in password visibility, recovery link, and account link are accessible on mobile',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/login');
	await waitForStartup(page);
	const password=page.getByLabel('Password',{exact:true});
	await password.fill('ExamplePassword123');
	await page.getByRole('button',{name:'Show password'}).click();
	await expect(password).toHaveAttribute('type','text');
	await page.getByRole('button',{name:'Hide password'}).click();
	await expect(password).toHaveAttribute('type','password');
	await expect(page.getByRole('link',{name:'Forgot password?'})).toHaveAttribute('href','/forgot-password');
	await expect(page.getByRole('link',{name:'Create an account'})).toHaveAttribute('href','/register');
	await expectNoHorizontalOverflow(page);
});

test('signup recovers from a lost registration response and automatically signs in without phone OTP',async({page})=>{
	const email=`aurevia-e2e-immediate-signup-${randomUUID()}@example.invalid`;
	let registrationRequests=0;
	const registrationRequestIds:string[]=[];
	const registrationPayloads:Record<string,unknown>[]=[];
	await page.addInitScript(()=>{
		const originalFetch=window.fetch.bind(window);
		let failedRegistrationRequest=false;
		window.fetch=async(input,init)=>{
			const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
			const isRegistrationRequest=new URL(url,location.href).pathname==='/api/register';
			if(isRegistrationRequest){
				const headers=new Headers(init?.headers);
				const requestIds=JSON.parse(window.sessionStorage.getItem('registration-request-ids')||'[]') as string[];
				requestIds.push(headers.get('x-aurevia-request-id')||'');
				window.sessionStorage.setItem('registration-request-ids',JSON.stringify(requestIds));
			}
			const response=await originalFetch(input,init);
			if(isRegistrationRequest&&!failedRegistrationRequest){
				failedRegistrationRequest=true;
				await response.arrayBuffer();
				throw new TypeError('Failed to fetch');
			}
			return response;
		};
	});
	page.on('request',request=>{
		if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/register'){
			registrationRequests++;
			registrationRequestIds.push(request.headers()['x-aurevia-request-id']);
			registrationPayloads.push(request.postDataJSON() as Record<string,unknown>);
		}
	});
	await page.setViewportSize({width:390,height:844});
	await page.goto('/register');
	await waitForStartup(page);
	await completeRegistrationToReview(page,{email});
	await page.getByRole('checkbox',{name:/I confirm that the information supplied/}).check();
	const createAccount=page.getByRole('button',{name:'Create account'});
	await expect(createAccount).toBeEnabled();
	await page.locator('form.registration-wizard-form').evaluate((form:HTMLFormElement)=>{
		form.requestSubmit();
		form.requestSubmit();
	});
	await page.waitForURL(url=>url.pathname==='/dashboard');
	await expect(page.getByRole('heading',{name:'My assets'})).toBeVisible();
	expect(registrationRequests).toBe(2);
	const attemptedRegistrationIds=await page.evaluate(()=>JSON.parse(window.sessionStorage.getItem('registration-request-ids')||'[]'));
	expect(attemptedRegistrationIds).toEqual([registrationRequestIds[0],registrationRequestIds[0]]);

	const signedIn=await page.request.get('/api/auth/session').then(response=>response.json());
	expect(signedIn.user.email).toBe(email);
	const registeredUser=await db.user.findUniqueOrThrow({where:{email},select:{id:true,status:true,phone:true,phoneVerified:true,phoneVerifiedAt:true,gender:true}});
	expect(registeredUser).toMatchObject({
		status:'ACTIVE',phone:null,phoneVerified:false,phoneVerifiedAt:null,
	});
	expect(await db.kycProfile.findUnique({where:{userId:registeredUser.id},select:{dob:true}})).toEqual({dob:new Date('2000-02-29T00:00:00.000Z')});
	expect(await db.ledgerAccount.findMany({where:{userId:registeredUser.id},select:{accountMode:true},orderBy:{accountMode:'asc'}})).toEqual([
		{accountMode:'DEMO'},
		{accountMode:'REAL'},
	]);
	expect(await db.notification.findUnique({where:{dedupeKey:`registration:${registeredUser.id}:created`},select:{userId:true}})).toEqual({userId:registeredUser.id});
	expect(await db.user.count({where:{email}})).toBe(1);
	expect(await db.registrationAttempt.findUnique({where:{email}})).toBeNull();
	expect(registrationPayloads).toHaveLength(2);
	expect(registrationPayloads[0]).not.toHaveProperty('verificationToken');
	expect(registrationPayloads[0]).not.toHaveProperty('captchaToken');
	expect(registrationPayloads[0].website).toBe('');
});

test('three card designs preserve proportions and support keyboard, pointer, and touch flips',async({browser,browserName,page})=>{
	await db.user.update({where:{email:fixture('USER_EMAIL')},data:{accountMode:'REAL'}});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/cards/apply');
	await expect(page.getByRole('radio')).toHaveCount(3);
	for(const name of ['Aurevia Signature','Aurevia Gold','Aurevia Black']){
		await expect(page.getByText(name,{exact:true}).first()).toBeVisible();
	}

	for(const width of [320,375,430,768,1440,1920]){
		await page.setViewportSize({width,height:width<600?844:900});
		for(const [index,tier] of ['signature','gold','black'].entries()){
			await page.getByRole('radio').nth(index).check();
			const card=page.locator(`.aurevia-card--${tier}`);
			await expect(card).toBeVisible();
			const dimensions=await card.evaluate(element=>{
				const {width:cardWidth,height:cardHeight}=element.getBoundingClientRect();
				return {width:cardWidth,height:cardHeight};
			});
			expect(Math.abs(dimensions.width/dimensions.height-1.586)).toBeLessThan(0.02);
			expect(dimensions.width).toBeLessThanOrEqual(width);

			await card.focus();
			await page.keyboard.press('Enter');
			await expect(card).toHaveAttribute('aria-pressed','true');
			await expect(card.locator('.aurevia-card-face-back')).toHaveAttribute('aria-hidden','false');
			await expect(card).toContainText('Virtual account card · For in-platform use only');
			await page.getByRole('button',{name:'Show front'}).click();
			await expect(card).toHaveAttribute('aria-pressed','false');

			await page.emulateMedia({reducedMotion:'no-preference'});
			const bounds=await card.boundingBox();
			expect(bounds).not.toBeNull();
			await page.mouse.move(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);
			await expect.poll(()=>card.evaluate(element=>new DOMMatrix(getComputedStyle(element).transform).m42)).toBeCloseTo(-4,0);
			await page.mouse.move(0,0);
			await card.click();
			await expect(card).toHaveAttribute('aria-pressed','true');
			await page.getByRole('button',{name:'Show front'}).click();
		}
		await expectNoHorizontalOverflow(page);
	}

	if(browserName!=='firefox'){
		const mobileContext=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
		try{
			const mobilePage=await mobileContext.newPage();
			await loginAs(mobilePage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
			await mobilePage.goto('/cards/apply');
			await mobilePage.getByRole('radio').nth(1).check();
			const card=mobilePage.locator('.aurevia-card--gold');
			await card.scrollIntoViewIfNeeded();
			await card.tap();
			await expect(card).toHaveAttribute('aria-pressed','true');
			await expectNoHorizontalOverflow(mobilePage);
		}finally{
			await mobileContext.close();
		}
	}
});

test('registration layout has no horizontal overflow at target viewport widths',async({page})=>{
	for(const width of [320,375,390,430,768,1024,1440,1920]){
		await page.setViewportSize({width,height:width<600?844:900});
		await page.goto('/register');
		await expect(page.getByRole('heading',{name:'Personal information'})).toBeVisible();
		await expectNoHorizontalOverflow(page);
		if(width<=430){
			const fontSizes=await page.locator('input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=color]):not([type=hidden]),select,textarea').evaluateAll(elements=>elements.map(element=>Number.parseFloat(getComputedStyle(element).fontSize)));
			expect(fontSizes.length).toBeGreaterThan(0);
			expect(fontSizes.every(fontSize=>fontSize>=16)).toBe(true);
			const viewport=await page.locator('meta[name="viewport"]').getAttribute('content');
			expect(viewport).not.toMatch(/maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i);
		}
	}
});

test('ten concurrent signups with phone numbers complete without transaction timeouts',async({page})=>{
	const phonePrefix=randomInt(10000,100000);
	const registrations=await Promise.all(Array.from({length:10},(_,index)=>validRegistrationPayload(
		`aurevia-e2e-concurrent-signup-${randomUUID()}@example.invalid`,
		'SecureTestPassword1',
		{name:`Concurrent Signup ${index+1}`,firstName:'Concurrent',lastName:`Signup ${index+1}`,country:'United Kingdom',countryCode:'GB',phone:`+447400${phonePrefix}${index}`,address:{countryCode:'GB',line1:'123 Test Street',city:'London'}},
	)));
	const responses=await Promise.all(registrations.map((data,index)=>page.request.post('/api/register',{
		data,
		headers:{'x-forwarded-for':`192.0.2.${index+10}`},
	})));
	expect(responses.map(response=>response.status())).toEqual(Array(10).fill(201));

	const users=await db.user.findMany({
		where:{email:{in:registrations.map(registration=>registration.email)}},
		select:{id:true,email:true,phone:true},
	});
	expect(users).toHaveLength(registrations.length);
	for(const user of users){
		expect(await db.kycProfile.findUnique({where:{userId:user.id},select:{id:true}})).not.toBeNull();
		expect(await db.ledgerAccount.count({where:{userId:user.id,accountMode:{in:['DEMO','REAL']}}})).toBe(2);
	}
});

test('duplicate signup offers sign-in with the typed email prefilled',async({page})=>{
	const email=`duplicate-signup-${randomUUID()}@example.invalid`;
	await page.route('**/api/register',route=>route.fulfill({
		status:409,
		contentType:'application/json',
		body:JSON.stringify({
			code:'ACCOUNT_ACCESS_REQUIRED',
			error:'Sign in or reset your password if you already have an account.',
			requestId:'e75c6069-6dc9-4de5-8a58-e8257d8f8e03',
		}),
	}));
	await page.goto('/register');
	await waitForStartup(page);
	await completeRegistrationToReview(page,{email});
	await page.getByRole('checkbox',{name:/I confirm that the information supplied/}).check();
	await page.getByRole('button',{name:'Create account'}).click();
	await expect(page.locator('.registration-field-error[role="alert"]')).toHaveText(/Sign in or reset your password/);
	await page.locator('.registration-existing-account').getByRole('link',{name:'Sign in'}).click();
	await page.waitForURL(/\/login$/);
	await expect(page.getByLabel('Email address')).toHaveValue(email);
});

test('account closure anonymizes login identity and retains financial and regulatory records',async()=>{
	const user=await db.user.create({data:{
		email:`aurevia-e2e-delete-${randomUUID()}@example.invalid`,
		passwordHash:'not-a-real-password-hash',
	}});
	try{
		await db.notification.create({data:{userId:user.id,type:'SYSTEM',title:'Test notice',message:'Delete with user',dedupeKey:`delete-test:${user.id}`}});
		await db.passwordResetToken.create({data:{userId:user.id,tokenHash:`delete-test:${user.id}`,expiresAt:new Date(Date.now()+60_000)}});
		await db.kycDocument.create({data:{userId:user.id,kind:'IDENTITY_DOCUMENT',filename:'test.pdf',storageKey:`${user.id}/00000000-0000-4000-8000-000000000001.pdf`,mimeType:'application/pdf',size:1}});
		await db.ledgerAccount.create({data:{userId:user.id,accountMode:'DEMO',code:`USER:${user.id}:DEMO:USD`,name:'Disposable test wallet',currency:'USD'}});
		await db.fundingRequest.create({data:{userId:user.id,type:'DEPOSIT',method:'E2E completed deposit',amount:10,currency:'USD',accountMode:'DEMO',status:'COMPLETED',idempotencyKey:`delete-test-funding:${user.id}`}});
		await db.$transaction(tx=>deleteAccountData(tx,{userId:user.id,actorId:null,confirmationEmail:user.email,reason:'Disposable test account closure',idempotencyKey:randomUUID()}));

		expect(await db.user.findUnique({where:{id:user.id},select:{status:true,email:true,passwordHash:true}})).toMatchObject({status:'CLOSED'});
		expect((await db.user.findUniqueOrThrow({where:{id:user.id},select:{email:true}})).email).toMatch(/^deleted\+.*@deleted\.invalid$/);
		expect(await db.notification.count({where:{userId:user.id}})).toBe(0);
		expect(await db.passwordResetToken.count({where:{userId:user.id}})).toBe(0);
		expect(await db.kycDocument.count({where:{userId:user.id}})).toBe(1);
		expect(await db.ledgerAccount.count({where:{userId:user.id}})).toBe(1);
		expect(await db.fundingRequest.count({where:{userId:user.id,status:'COMPLETED'}})).toBe(1);
	}catch(error){
		await db.user.deleteMany({where:{id:user.id}});
		throw error;
	}
});

test('existing account can sign in without signup verification',async({page})=>{
	await loginAs(page,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Notifications/})).toBeVisible();
});

test('sign-in returns to the protected dashboard requested before authentication',async({page})=>{
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/login\?callbackUrl=/);
	await waitForStartup(page);
	await page.getByRole('checkbox',{name:'Remember my email on this device'}).check();
	await page.getByLabel('Email address').fill(fixture('LEGACY_USER_EMAIL'));
	await page.getByLabel('Password',{exact:true}).fill(fixture('LEGACY_USER_PASSWORD'));
	const documentTimeOrigin=await page.evaluate(()=>performance.timeOrigin);
	await page.getByRole('button',{name:'Sign in'}).click();
	await page.waitForURL(url=>url.pathname==='/dashboard');
	expect(await page.evaluate(()=>performance.timeOrigin)).toBe(documentTimeOrigin);
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	const rememberedEmailStorage=await page.evaluate(async()=>{
		const database=await new Promise<IDBDatabase>((resolve,reject)=>{
			const request=indexedDB.open('aurevia-encrypted-local-data',1);
			request.onsuccess=()=>resolve(request.result);
			request.onerror=()=>reject(request.error);
		});
		try{
			const transaction=database.transaction(['encryption-keys','encrypted-values'],'readonly');
			const [key,record]=await Promise.all([
				new Promise<{key:CryptoKey}|undefined>((resolve,reject)=>{
					const request=transaction.objectStore('encryption-keys').get('device-aes-256-gcm');
					request.onsuccess=()=>resolve(request.result as {key:CryptoKey}|undefined);
					request.onerror=()=>reject(request.error);
				}),
				new Promise<{iv:number[];ciphertext:ArrayBuffer}|undefined>((resolve,reject)=>{
					const request=transaction.objectStore('encrypted-values').get('aurevia-signin-remembered-email');
					request.onsuccess=()=>resolve(request.result as {iv:number[];ciphertext:ArrayBuffer}|undefined);
					request.onerror=()=>reject(request.error);
				}),
			]);
			return {
				plaintext:localStorage.getItem('aurevia-signin-remembered-email'),
				keyExtractable:key?.key.extractable,
				ivLength:record?.iv.length,
				ciphertext:Array.from(new Uint8Array(record?.ciphertext||new ArrayBuffer(0))),
			};
		}finally{database.close()}
	});
	expect(rememberedEmailStorage.plaintext).toBeNull();
	expect(rememberedEmailStorage.keyExtractable).toBe(false);
	expect(rememberedEmailStorage.ivLength).toBe(12);
	expect(new TextDecoder().decode(new Uint8Array(rememberedEmailStorage.ciphertext))).not.toContain(fixture('LEGACY_USER_EMAIL'));
	await page.goto('/login');
	await expect(page.getByLabel('Email address')).toHaveValue(fixture('LEGACY_USER_EMAIL'));
});

test('administrator sign-in returns to the protected admin page requested before authentication',async({page})=>{
	await page.goto('/admin/command-center');
	await expect(page).toHaveURL(/\/admin\/login\?callbackUrl=/);
	await waitForStartup(page);
	await page.getByLabel('Admin username or email').fill(fixture('ADMIN_EMAIL'));
	await page.getByLabel('Admin password').fill(fixture('ADMIN_PASSWORD'));
	await page.getByRole('button',{name:'Enter control center'}).click();
	await page.waitForURL(url=>url.pathname==='/admin/command-center');
	await expect(page.getByRole('heading',{name:'AI & API command center'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'AI provider health'})).toBeVisible();
});

test('multiple sessions can be reviewed and other sessions revoked server-side',async({page,browser})=>{
	const user=await createIsolatedDemoUser('multiple-sessions');
	const {email,password}=user;
	await loginAs(page,email,password);
	await page.reload();
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	const otherContext=await browser.newContext();
	try{
		const otherDevice=await otherContext.newPage();
		await loginAs(otherDevice,email,password);
		expect((await page.request.get('/api/security/sessions').then(response=>response.json())).sessions).toHaveLength(2);
		expect((await otherDevice.request.get('/api/dashboard')).status()).toBe(200);
		const revoke=await page.request.post('/api/security/sessions',{data:{action:'logout-others',password}});
		expect(revoke.status()).toBe(200);
		const response=await page.request.get('/api/dashboard');
		expect(response.status()).toBe(200);
		await expect.poll(async()=> (await otherDevice.request.get('/api/dashboard')).status()).toBe(401);
	}finally{await otherContext.close();}
});

for(const viewport of viewports){
	test(`authenticated routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
		test.setTimeout(300_000);
		await page.setViewportSize(viewport);
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'REAL');
		for(const theme of themes){
			const save=await page.request.patch('/api/theme-preference',{data:{theme}});
			expect(save.status(),'account theme preference').toBe(200);
			for(const route of authenticatedRoutes){
				await test.step(`${route} in ${theme}`,async()=>{
					const path=concreteRoutePath(route);
					const response=await page.goto(path);
					expect(response?.status(),route).toBe(200);
					await expect(page.locator('html'),`${route} (${theme})`).toHaveAttribute('data-theme-name',theme);
					await expect(page.locator('main').first(),route).toBeVisible();
					if(await page.locator('h1:visible').count())await expect(page.locator('h1:visible').first(),route).toBeVisible();
					if(route==='/dashboard'&&viewport.width<=640)await expect(page.locator('.mobile-home-greeting'),route).toBeVisible();
					if(route==='/activity'){
						await expect(page.getByLabel('Search activity')).toBeVisible();
						await expect(page.getByLabel('From')).toBeVisible();
						await expect(page.getByLabel('To',{exact:true})).toBeVisible();
					}
					if(route==='/dashboard'){
						const expectedPage=theme==='forest-green'?'#07110d':'#f7f8f5';
						const expectedPanel=theme==='forest-green'?'rgb(18, 32, 25)':'rgb(255, 255, 255)';
						await expect(page.locator('html')).toHaveCSS('--theme-page',expectedPage);
						await expect(page.locator('.user-dashboard-panel').first()).toHaveCSS('background-color',expectedPanel);
						await expect(page.locator('.user-dashboard-panel-heading h2').first()).toHaveCSS('color',theme==='forest-green'?'rgb(243, 244, 237)':'rgb(23, 37, 29)');
						const realAccount=await page.locator('.user-mode-pill').evaluate(element=>element.classList.contains('real'));
						const expectedModeDot=realAccount
							?(theme==='forest-green'?'rgb(52, 211, 153)':'rgb(20, 115, 78)')
							:(theme==='forest-green'?'rgb(197, 164, 95)':'rgb(128, 95, 50)');
						await expect(page.locator('.user-mode-pill i')).toHaveCSS('background-color',expectedModeDot);
					}
					await expectNoHorizontalOverflow(page);
				});
			}
		}
		await page.request.patch('/api/theme-preference',{data:{theme:'forest-green'}});
	});
}

test('notifications bell, unread state, mark one/all, and history persist',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	await waitForStartup(page);
	const bell=page.getByRole('button',{name:/Notifications/});
	await expect(bell).toContainText(/\d/);
	await bell.click();
	const dialog=page.getByRole('dialog',{name:'Notifications'});
	await expect(dialog).toBeVisible();
	const notificationZoomPrevented=await page.evaluate(()=>{
		const event=new KeyboardEvent('keydown',{key:'-',ctrlKey:true,cancelable:true});
		document.dispatchEvent(event);
		return event.defaultPrevented;
	});
	expect(notificationZoomPrevented).toBe(false);
	const popoverBounds=await dialog.boundingBox();
	expect(popoverBounds?.height).toBeLessThan(844*.7);
	expect(popoverBounds?.width).toBeLessThan(390);
	const closeButton=dialog.getByRole('button',{name:'Close notifications'});
	await expect.poll(()=>closeButton.evaluate(element=>{
		const bounds=element.getBoundingClientRect();
		const target=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		return target===element||element.contains(target);
	})).toBe(true);
	const rows=page.locator('.notification-row.is-unread');
	await expect.poll(()=>rows.count()).toBeGreaterThan(0);
	const first=rows.first();
	await expect(first).toBeVisible();
	const firstTitle=await first.locator('.notification-copy b').innerText();
	const notificationResponse=await page.request.get('/api/notifications?limit=100');
	expect(notificationResponse.ok()).toBe(true);
	const notificationData=await notificationResponse.json();
	const selectedNotification=notificationData.notifications.find((item:{title:string;isRead:boolean})=>item.title===firstTitle&&!item.isRead);
	expect(selectedNotification).toBeTruthy();
	const destination=selectedNotification.actionUrl?new URL(selectedNotification.actionUrl,page.url()).href:null;
	const markRead=page.waitForResponse(response=>response.url().endsWith('/api/notifications')&&response.request().method()==='PATCH'&&response.request().postData()?.includes('"action":"read"')===true);
	await first.click();
	await markRead;
	if(destination)await expect(page).toHaveURL(destination);
	else await expect(first).toHaveClass(/is-read/);
	await page.waitForLoadState('load');
	await page.goto('/notifications');
	await expect(page.getByRole('heading',{name:'Notifications'})).toBeVisible();
	await expect(page.locator('.notification-history-item').filter({hasText:firstTitle}).first()).toHaveClass(/is-read/);
	await page.getByRole('button',{name:'Mark all read'}).click();
	await expect(page.getByText('All caught up')).toBeVisible();
	await page.reload();
	await expect(page.getByText('All caught up')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('account-mode changes initialize and isolate wallet, trade, history, and support state',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const mode=page.locator('.user-mode-control');
	const demoMode=mode.getByRole('button',{name:'Demo',exact:true});
	const realMode=mode.getByRole('button',{name:'Real',exact:true});
	await page.goto('/wallet?action=DEPOSIT');
	await expect(page.locator('.wallet-page-heading .wallet-eyebrow')).toContainText('DEMO ACCOUNT');
	await expect(page.locator('.wallet-page-heading .status-pill')).toContainText('DEMO');
	let releaseModeUpdate!:()=>void;
	const modeUpdateGate=new Promise<void>(resolve=>{releaseModeUpdate=resolve});
	await page.route('**/api/account/mode',async route=>{await modeUpdateGate;await route.continue()});
	const modeUpdateResponse=page.waitForResponse(response=>response.url().endsWith('/api/account/mode')&&response.request().method()==='PATCH');
	await selectAccountMode(page,'REAL',{waitForCompletion:false});
	await expect(demoMode).toBeDisabled();
	releaseModeUpdate();
	expect((await modeUpdateResponse).ok()).toBeTruthy();
	await page.unroute('**/api/account/mode');
	await expect(realMode).toHaveAttribute('aria-pressed','true');
	await expect(page.locator('.wallet-page-heading .wallet-eyebrow')).toContainText('REAL ACCOUNT');
	await expect(page.locator('.wallet-page-heading .status-pill')).toContainText('REAL');
	await expect(page.locator('.wallet-balance-value')).toHaveText('$0.00');
	await page.goto('/wallet/transactions');
	await expect(page.locator('.account-heading .status-pill')).toContainText('REAL ACCOUNT');
	await page.getByRole('button',{name:'View history'}).click();
	await expect(page.getByText('No transactions yet')).toBeVisible();
	await selectAccountMode(page,'DEMO');
	await expect(page.locator('.account-heading .status-pill')).toContainText('DEMO ACCOUNT');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My portfolio'})).toBeVisible();
	await expect(page.locator('.user-mode-pill')).toContainText('DEMO MODE');
	await page.goto('/portfolio');
	await expect(page.locator('.portfolio-heading-actions .status-pill')).toContainText('DEMO ACCOUNT');
	await selectAccountMode(page,'REAL');
	await expect(page.locator('.portfolio-heading-actions .status-pill')).toContainText('REAL ACCOUNT');
	await page.goto('/dashboard');
	await expect(page.getByText('REAL funding is credited only through existing administrator-approved requests. Balances shown are internal Aurevia ledger records.')).toHaveCount(0);
	for(const viewport of [{width:375,height:812},{width:1440,height:900}]){
		test.setTimeout(300_000);
		await page.setViewportSize(viewport);
		await page.goto('/dashboard');
		await expectNoHorizontalOverflow(page);
	}
	await page.goto('/trade');
	await selectAccountMode(page,'REAL');
	await expect(page.locator('.account-heading .status-pill')).toContainText('REAL');
	const realInstrumentButtons=page.locator('.trade-market-select button[data-asset-type]');
	await expect.poll(()=>realInstrumentButtons.evaluateAll(buttons=>buttons.every(button=>['STOCK','CRYPTO'].includes(button.getAttribute('data-asset-type')||'')))).toBe(true);
	const cryptoInstrument=page.locator('.trade-market-select button[data-asset-type="CRYPTO"]').first();
	if(await cryptoInstrument.count()){
		const orderType=page.locator('.trade-ticket-card select');
		await orderType.selectOption('STOP');
		await cryptoInstrument.click();
		await expect(orderType).toHaveValue('MARKET');
	}
	for(const viewport of [{width:375,height:812},{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await expect(page.getByText('Aurevia internal simulated execution',{exact:true})).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}
	const realOrderButton=page.getByRole('button',{name:'Place BUY order'});
	await expect(page.getByText('Quote unavailable',{exact:true})).toBeVisible();
	await expect(realOrderButton).toBeDisabled();
	await page.goto('/orders');
	for(const viewport of [{width:375,height:812},{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await expectNoHorizontalOverflow(page);
	}
	await page.goto('/portfolio');
	for(const viewport of [{width:375,height:812},{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await expect(page.locator('.portfolio-heading-actions .status-pill')).toContainText('REAL ACCOUNT');
		await expectNoHorizontalOverflow(page);
	}
	await selectAccountMode(page,'DEMO');
	await expect(page.locator('.account-heading .status-pill')).toContainText('DEMO');
	await page.goto('/trade');
	await expect(page.getByRole('button',{name:'Place BUY order'})).toBeEnabled();
	await page.goto('/support');
	await page.getByRole('button',{name:'Contact Admin'}).click();
	const subject=`Mode-scoped support ${randomUUID().slice(0,8)}`;
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Temporary DEMO support isolation test.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
	await selectAccountMode(page,'REAL');
	await expect(page.getByRole('button').filter({hasText:subject})).toHaveCount(0);
	await selectAccountMode(page,'DEMO');
	await expect(page.getByRole('button').filter({hasText:subject})).toBeVisible();
});

test('REAL trade chart displays provider candles and falls back to a verified quote',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	let historyAvailable=false;
	await page.route('**/api/live-markets**',async route=>{
		const url=new URL(route.request().url());
		if(url.pathname==='/api/live-markets'){
			return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({quotes:[{
				asset:{id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},
				price:42_000,bid:41_990,ask:42_010,change:100,changePercent:0.24,
				previousClose:41_900,open:41_900,volume:100,dayLow:41_800,dayHigh:42_100,
				fiftyTwoWeekLow:null,fiftyTwoWeekHigh:null,updatedAt:new Date().toISOString(),
				isStale:false,sparkline:[],source:'Twelve Data',
			}]})});
		}
		if(url.pathname==='/api/live-markets/BTC'){
			if(!historyAvailable)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Provider candle history is unavailable.'})});
			return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
				source:'Twelve Data',
				candles:[{
					time:Math.floor(Date.now()/60_000)*60,
					open:41_900,high:42_100,low:41_800,close:42_000,volume:125,
				}],
			})});
		}
		return route.continue();
	});
	await page.route('**/api/orderbook**',route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify({kind:'TOP_OF_BOOK',symbol:'BTC/USD',last:42_000,bid:41_990,ask:42_010,spread:20,depthAvailable:false}),
	}));
	await page.goto('/trade');
	await expect(page.getByRole('button',{name:/BTC\/USD/})).toBeVisible();
	await page.getByRole('button',{name:/BTC\/USD/}).click();
	await expect(page.locator('.live-chart-data-status')).toContainText('QUOTE ONLY · Twelve Data');
	await expect(page.locator('.live-chart-canvas')).toHaveAttribute('aria-hidden','false');
	await expect(page.locator('.live-chart-readout')).toContainText('Latest provider quote 42,000.00');
	await expect(page.locator('.live-chart-message')).toContainText('Historical candles unavailable. Showing the latest verified provider quote only.');

	historyAvailable=true;
	await page.getByRole('button',{name:'5m',exact:true}).click();
	await expect(page.locator('.live-chart-data-status')).toContainText('CURRENT · Twelve Data');
	await expect(page.locator('.live-chart-readout')).toContainText('O 41,900.00');
	await expect(page.locator('.live-chart-readout')).toContainText('H 42,100.00');
	await expect(page.locator('.live-chart-message')).toHaveCount(0);
});

test('REAL funding remains internal and orders fail closed without market data',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	expect((await page.request.get('/api/admin/providers/status')).status()).toBe(403);
	await selectAccountMode(page,'REAL');
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);
	const previousGbpRate=await db.exchangeRate.findUnique({where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}}});
	try{
		await db.exchangeRate.upsert({
			where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}},
			create:{baseCurrency:'USD',quoteCurrency:'GBP',rate:'0.8',source:'E2E configured rate',observedAt:new Date()},
			update:{rate:'0.8',source:'E2E configured rate',observedAt:new Date()},
		});
		await page.request.patch('/api/currency-preference',{data:{currency:'GBP'}});
		const configuredRate=await page.request.get('/api/currency-rates?to=GBP').then(response=>response.json());
		expect(configuredRate).toMatchObject({
			rate:'0.8',
			source:process.env.AUREVIA_E2E_TWELVE_DATA_MOCK==='1'?'Twelve Data':'E2E configured rate',
			status:'CURRENT',
		});
		await page.goto('/wallet');
		await page.locator('details.wallet-settings > summary').click();
		await expect(page.getByText('Approximate display · USD ledger · 1 USD = 0.8 GBP.')).toBeVisible();
		await expect(page.locator('.wallet-balance-value')).toHaveText('Unavailable');
	}finally{
		await page.request.patch('/api/currency-preference',{data:{currency:'USD'}});
		if(previousGbpRate)await db.exchangeRate.update({where:{baseCurrency_quoteCurrency:{baseCurrency:'USD',quoteCurrency:'GBP'}},data:{rate:previousGbpRate.rate,source:previousGbpRate.source,observedAt:previousGbpRate.observedAt}});
		else await db.exchangeRate.deleteMany({where:{baseCurrency:'USD',quoteCurrency:'GBP'}});
	}
	const appleInstrument=await db.instrument.findUniqueOrThrow({where:{symbol:'AAPL'}});
	const initialQuoteResponse=await page.request.get('/api/live-markets?symbols=AAPL');
	const initialMarket=await initialQuoteResponse.json();
	expect(initialMarket.quotes?.some((quote:{asset?:{id?:string};source?:string})=>quote.asset?.id==='AAPL'&&quote.source==='Twelve Data')).toBe(false);
	const isolatedOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{
		instrumentId:appleInstrument.id,side:'BUY',type:'LIMIT',quantity:1,price:0.01,
		expectedPrice:Number(appleInstrument.price),observedAt:appleInstrument.updatedAt.toISOString(),
	}});
	expect(isolatedOrder.status()).toBe(503);
	expect((await isolatedOrder.json()).error).toContain('Twelve Data market quote is unavailable');
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);

	const adminContext=await browser.newContext();
	const reviewerContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		const reviewerPage=await reviewerContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(reviewerPage,fixture('REVIEWER_EMAIL'),fixture('REVIEWER_PASSWORD'));
		const statusResponse=await adminPage.request.get('/api/admin/providers/status');
		expect(statusResponse.ok()).toBe(true);
		const status=await statusResponse.json();
		expect(status.internalSimulation).toMatchObject({adminAuthorization:'AVAILABLE',externalBrokerExecution:'DISABLED',externalPaymentProcessing:'DISABLED',externalInvestmentSettlement:'DISABLED',externalMoneyMovement:'DISABLED'});
		expect(status.internalSimulation.accountLedger).toBe('AVAILABLE');
		expect(status.internalSimulation.simulatedDepositsAndWithdrawals).toBe('AVAILABLE');
		expect(status.marketData.usedForOrderExecution).toBe(false);
		expect(JSON.stringify(status)).not.toContain('://');

		const prooflessDepositInitiated=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_NO_PROOF_ID'),decision:'APPROVED'}});
		expect(prooflessDepositInitiated.status()).toBe(202);
		const prooflessDepositApproval=await reviewerPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_NO_PROOF_ID'),decision:'APPROVED'}});
		expect(prooflessDepositApproval.status()).toBe(200);
		expect(Number((await prooflessDepositApproval.json()).creditedAmount)).toBe(67.5);
		expect(Number((await prooflessDepositApproval.json()).feeAmount)).toBe(7.5);
		const depositInitiated=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(depositInitiated.status()).toBe(202);
		const depositApproval=await reviewerPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(depositApproval.status()).toBe(200);
		expect(Number((await depositApproval.json()).creditedAmount)).toBe(112.5);
		expect(Number((await depositApproval.json()).feeAmount)).toBe(12.5);
		const withdrawalApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_WITHDRAWAL_ID'),decision:'APPROVED'}});
		expect(withdrawalApproval.status()).toBe(409);
		expect((await withdrawalApproval.json()).error).toContain('audited approve, process, and externally confirmed completion workflow');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${fixture('REAL_WITHDRAWAL_ID')}:APPROVED`}})).toBeNull();
		expect(await db.fundingRequest.findUniqueOrThrow({where:{id:fixture('REAL_WITHDRAWAL_ID')},select:{status:true}})).toMatchObject({status:'PENDING_REVIEW'});
		const duplicateApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:fixture('REAL_DEPOSIT_ID'),decision:'APPROVED'}});
		expect(duplicateApproval.status()).toBe(409);
		const fundingHistory=await adminPage.request.get('/api/admin/funding?history=true').then(response=>response.json());
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_DEPOSIT_ID'))).toMatchObject({status:'APPROVED',accountMode:'REAL',amount:'125',creditedAmount:'112.5',feeAmount:'12.5'});
		expect(fundingHistory.find((row:{id:string})=>row.id===fixture('REAL_WITHDRAWAL_ID'))).toMatchObject({status:'PENDING_REVIEW',accountMode:'REAL'});
	}finally{await Promise.all([adminContext.close(),reviewerContext.close()]);}

	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(180);
	await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).withdrawableBalance)).toBe(155);
	const executionQuoteResponse=await page.request.get('/api/live-markets?symbols=AAPL');
	const executionMarket=await executionQuoteResponse.json();
	expect(executionMarket.quotes?.some((quote:{asset?:{id?:string};source?:string})=>quote.asset?.id==='AAPL'&&quote.source==='Twelve Data')).toBe(false);
	const walletBeforeUnavailableOrder=await page.request.get('/api/wallet').then(response=>response.json());
	const ordersBeforeUnavailableOrder=await page.request.get('/api/orders').then(response=>response.json());
	const positionsBeforeUnavailableOrder=await page.request.get('/api/positions').then(response=>response.json());
	const unavailableOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{
		instrumentId:appleInstrument.id,side:'BUY',type:'MARKET',quantity:1,
		expectedPrice:Number(appleInstrument.price),observedAt:appleInstrument.updatedAt.toISOString(),
	}});
	expect(unavailableOrder.status()).toBe(503);
	expect((await unavailableOrder.json()).error).toContain('Twelve Data market quote is unavailable');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(walletBeforeUnavailableOrder.balance));
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(ordersBeforeUnavailableOrder.length);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(positionsBeforeUnavailableOrder.length);
	await selectAccountMode(page,'DEMO');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(5000);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	await selectAccountMode(page,'REAL');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(walletBeforeUnavailableOrder.balance));
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(ordersBeforeUnavailableOrder.length);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(positionsBeforeUnavailableOrder.length);
});

test('Wallet shows the internal funding workflow only in REAL Mode and survives API failures',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await page.setViewportSize({width:390,height:844});
		const walletUser=await createIsolatedDemoUser('wallet-workflow');
		await loginAs(page,walletUser.email,walletUser.password);
		await selectAccountMode(page,'DEMO');
		await page.goto('/wallet');
		await expect(page.getByRole('heading',{name:/wallet|funding/i}).first()).toBeVisible();
		await expect(page.locator('.wallet-signature-brand')).toContainText('AUREVIA');
		await expect(page.locator('.wallet-signature-brand')).toContainText('ACCOUNT WALLET');
		await expect(page.locator('.wallet-card-art')).toBeVisible();
		await expect(page.locator('.wallet-signature-card')).toContainText('Available balance');
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await expect(page.locator('.wallet-page-heading')).toContainText('DEMO · VIRTUAL');
		await expect(page.locator('.wallet-balance-foot')).toContainText('Practice account · no real funds');
		await expect(page.getByLabel('Payment method')).toHaveCount(0);
		await expect(page.locator('.wallet-type-switch')).toHaveCount(0);
		await expect(page.getByLabel('Amount',{exact:true})).toHaveCount(0);
		await page.getByRole('button',{name:'Hide balance'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('•••••• USD');
		await expect(page.getByRole('button',{name:'Show balance'})).toBeVisible();
		await page.getByRole('button',{name:'Show balance'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await page.route('**/api/payment-methods',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Payment methods are temporarily unavailable.'})}));
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await expect(page.locator('.wallet-page-heading')).toContainText('DEMO · VIRTUAL');
		await expect(page.locator('.wallet-balance-foot')).toContainText('Practice account · no real funds');
		await page.unroute('**/api/payment-methods');
		await page.route('**/api/wallet',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Wallet data is temporarily unavailable.'})}));
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.getByText('Loading wallet data…')).toHaveCount(0);
		await expect(page.locator('.wallet-balance-value')).toHaveText('Unavailable');
		await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable.'})).toBeVisible();
		await expect(page.getByLabel('Amount',{exact:true})).toHaveCount(0);
		await page.unroute('**/api/wallet');
		await page.getByRole('button',{name:'Refresh wallet'}).click();
		await expect(page.locator('.wallet-balance-value')).toHaveText('$5,000.00');
		await selectAccountMode(page,'REAL');
		await page.goto('/wallet?action=DEPOSIT');
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({methods:[],fundingStatus:'AVAILABLE',simulationAvailable:true,realFundingAvailable:true,realWithdrawalAvailable:true,manualDepositReviewAvailable:true,externalPaymentProcessing:'DISABLED',internalLedgerOnly:true});
		await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
		await expect(page.getByLabel('Amount',{exact:true})).toBeVisible();
		await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
		await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
		await expect(page.getByLabel('Bitcoin transaction reference')).toHaveCount(0);
		await expect(page.locator('input[type="file"]')).toHaveCount(1);
		await expect(page.getByLabel('Amount',{exact:true})).toHaveAttribute('required','');
		await expect(page.getByRole('button',{name:'Submit internal credit request'})).toBeEnabled();
		await expect(page.getByRole('alert').filter({hasText:'Wallet data is temporarily unavailable'})).toHaveCount(0);
		for(const width of [320,375,390,430,1440]){
			await page.setViewportSize({width,height:900});
			await expectNoHorizontalOverflow(page);
		}
	}finally{
		if(await page.request.get('/api/auth/session').then(response=>response.ok()))await page.request.patch('/api/account/mode',{data:{accountMode:'DEMO'}});
		await adminContext.close();
	}
});

test('DEMO trading supports cash-backed buy and owned-unit sell execution',async({browser,page})=>{
	const demoUser=await createIsolatedDemoUser('market-order');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	const symbol=fixture('INSTRUMENT_B');
	await page.goto('/markets');
	await expect(page.getByRole('heading',{name:'Markets',exact:true})).toBeVisible();
	await expect(page.getByText(/Proveedor no disponible|Se muestra el último precio recibido|Provider quote timestamp is older than five minutes/i)).toHaveCount(0);
	const marketPageUrl=page.url();
	const tradePage=await page.context().newPage();
	try{
		await tradePage.goto('/trade');
		const instrument=tradePage.getByRole('button',{name:new RegExp(symbol.replace('/','\\/'))});
		await expect(instrument).toBeVisible();
		await instrument.click();
		await expect(tradePage.locator('.live-chart-data-status')).toContainText('SIMULATED · Aurevia DEMO');
		await expect(tradePage.locator('.live-chart-canvas')).toHaveAttribute('aria-hidden','false');
		await expect(tradePage.getByText('Simulated DEMO chart data is independent of order execution.')).toBeVisible();
		const orderResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place BUY order'}).click();
		await expect(tradePage.locator('.trade-message')).toContainText('Order filled.');
		const orderResponse=await orderResponsePromise;
		expect(orderResponse.ok()).toBeTruthy();
		const order=await orderResponse.json();
		expect(order.status).toBe('FILLED');
		expect(order.executions).toHaveLength(1);
		await tradePage.getByRole('button',{name:'Sell',exact:true}).click();
		const sellResponsePromise=tradePage.waitForResponse(response=>response.url().endsWith('/api/orders')&&response.request().method()==='POST');
		await tradePage.getByRole('button',{name:'Place SELL order'}).click();
		await expect(tradePage.locator('.trade-message')).toContainText('Order filled.');
		const sellResponse=await sellResponsePromise;
		expect(sellResponse.ok()).toBeTruthy();
		expect((await sellResponse.json()).status).toBe('FILLED');
		const openPositions=await tradePage.request.get('/api/positions');
		expect(await openPositions.json()).toHaveLength(0);
		const freshMarkets=await tradePage.request.get('/api/market').then(response=>response.json());
		const freshInstrument=freshMarkets.find((item:{symbol:string})=>item.symbol===symbol);
		const oversell=await tradePage.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:freshInstrument.id,side:'SELL',type:'MARKET',quantity:1,expectedPrice:Number(freshInstrument.price),observedAt:freshInstrument.lastUpdatedAt}});
		expect(oversell.status()).toBe(409);
		expect((await oversell.json()).error).toBe('The sell quantity exceeds the available position or wallet asset balance.');
		const privateActivity=await tradePage.request.get('/api/market/activity').then(response=>response.json());
		expect(privateActivity.source).toBe('DEMO practice activity records');
		expect(privateActivity.activity.filter((event:{instrument:string;accountMode:string})=>event.instrument===symbol&&event.accountMode==='DEMO')).toHaveLength(2);
		const unrelatedUser=await createIsolatedDemoUser('unrelated-activity');
		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,unrelatedUser.email,unrelatedUser.password);
			const unrelatedActivity=await unrelatedPage.request.get('/api/market/activity').then(response=>response.json());
			expect(unrelatedActivity.activity).toHaveLength(0);
		}finally{await unrelatedContext.close();}
		expect(page.url()).toBe(marketPageUrl);
		await selectAccountMode(page,'REAL');
		await expect.poll(async()=>{
			const response=await tradePage.request.get('/api/market/activity');
			return (await response.json()).activity;
		}).toHaveLength(0);
		await selectAccountMode(page,'DEMO');
		await expectNoHorizontalOverflow(page);
	}finally{if(!tradePage.isClosed())await tradePage.close();}
});

test('dashboard presents the current account portfolio hub',async({page})=>{
	const demoUser=await createIsolatedDemoUser('dashboard-hub');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'My Portfolio'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Market watch'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Positions'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Open orders'})).toBeVisible();
	await expect(page.getByRole('link',{name:/Deposit/})).toHaveCount(0);
	await expect(page.getByRole('link',{name:'Order history'})).toHaveAttribute('href','/orders');
	await expect(page.getByRole('button',{name:'1D'})).toBeVisible();
	await expect(page.getByRole('button',{name:'5Y',exact:true})).toBeVisible();
});

test('closing a DEMO position records a sell execution, reconciles portfolio, and notifies',async({page})=>{
	const demoUser=await createIsolatedDemoUser('position-close');
	await loginAs(page,demoUser.email,demoUser.password);
	await selectAccountMode(page,'DEMO');
	const initialWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(initialWallet.balance)).toBeGreaterThan(0);
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===fixture('INSTRUMENT_A'));
	expect(instrument).toBeTruthy();
	const buy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt}});
	expect(buy.ok()).toBeTruthy();
	expect((await buy.json()).status).toBe('FILLED');
	const afterBuyWallet=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(afterBuyWallet.balance)).toBeLessThan(Number(initialWallet.balance));
	const positions=await page.request.get('/api/positions').then(response=>response.json());
	expect(positions).toHaveLength(1);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);

	const close=await page.request.post('/api/positions',{data:{positionId:positions[0].id}});
	expect(close.ok()).toBeTruthy();
	expect((await page.request.get('/api/positions').then(response=>response.json()))).toHaveLength(0);
	const orders=await page.request.get('/api/orders').then(response=>response.json());
	const closeOrder=orders.find((order:{side:string;instrumentId:string;status:string})=>order.side==='SELL'&&order.instrumentId===instrument.id&&order.status==='FILLED');
	expect(closeOrder).toBeTruthy();
	expect(closeOrder.executions).toHaveLength(1);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(closedPortfolio.realizedPnl).not.toBeNull();
	const notificationResponse=await page.request.get('/api/notifications?limit=100').then(response=>response.json());
	expect(notificationResponse.notifications.some((item:{title:string;relatedId:string|null})=>item.relatedId===closeOrder.id&&item.title==='DEMO position closed')).toBe(true);
});

test('Bitcoin conversion stays unavailable without a provider and disabled in DEMO',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const walletBefore=await page.request.get('/api/wallet').then(response=>response.json());
	const ordersBefore=await page.request.get('/api/orders').then(response=>response.json());
	const positionsBefore=await page.request.get('/api/positions').then(response=>response.json());
	const preview=await page.request.get('/api/wallet/convert-bitcoin?direction=BUY&amount=100.00');
	expect(preview.status()).toBe(503);
	await selectAccountMode(page,'DEMO');
	const initial=await page.request.get('/api/wallet').then(response=>response.json());
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const cashBefore=Number(initial.balance);
	const attemptStartedAt=new Date();
	const conversion=await page.request.post('/api/wallet/convert-bitcoin',{headers:{'Idempotency-Key':randomUUID()},data:{direction:'BUY',amount:'100.00',confirmed:true,referencePrice:'1.00',observedAt:new Date().toISOString()}});
	expect(conversion.status()).toBe(403);
	const afterDemoAttempt=await page.request.get('/api/wallet').then(response=>response.json());
	expect(Number(afterDemoAttempt.balance)).toBe(cashBefore);
	expect(afterDemoAttempt.balances.map((item:{currency:string})=>item.currency)).toEqual(['USD']);
	const conversions=await db.ledgerTransaction.findMany({where:{reference:{startsWith:`DEMO:BTC:CONVERSION:${userId}:`},createdAt:{gte:attemptStartedAt}}});
	expect(conversions).toHaveLength(0);
	await selectAccountMode(page,'REAL');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(walletBefore.balance));
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(ordersBefore.length);
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(positionsBefore.length);
});

test('administrative balance adjustments require authorization and confirmation data, and are idempotent',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const initialDemo=await page.request.get('/api/wallet').then(response=>response.json());
	const beforeDemo=Number(initialDemo.balance);
	const unauthorized=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved training allocation',idempotencyKey:randomUUID()}});
	expect(unauthorized.status()).toBe(403);
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const search=await adminPage.request.get(`/api/admin/users?search=${encodeURIComponent(fixture('INVESTOR_EMAIL'))}`);
		expect(search.ok()).toBeTruthy();
		expect((await search.json()).some((user:{id:string})=>user.id===userId)).toBe(true);
		const key=randomUUID();
		const payload={userId,accountMode:'DEMO',currency:'USD',amount:'25.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved training allocation',idempotencyKey:key};
		const credited=await adminPage.request.post('/api/admin/balances',{data:payload});
		expect(credited.status()).toBe(201);
		const first=await credited.json();
		expect(first).toMatchObject({replayed:false,previousBalance:String(beforeDemo),newBalance:String(beforeDemo+25)});
		expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
		const replay=await adminPage.request.post('/api/admin/balances',{data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).reference).toBe(first.reference);
		const reused=await adminPage.request.post('/api/admin/balances',{data:{...payload,amount:'26.00'}});
		expect(reused.status()).toBe(409);
		const debit=await adminPage.request.post('/api/admin/balances',{data:{...payload,idempotencyKey:randomUUID(),direction:'DEBIT',category:'CORRECTION',amount:'5.00',reason:'Correct duplicate training allocation'}});
		expect(debit.status()).toBe(201);
		const debitResult=await debit.json();
		const insufficient=await adminPage.request.post('/api/admin/balances',{data:{...payload,idempotencyKey:randomUUID(),direction:'DEBIT',amount:'99999999.00',reason:'Rejected excessive debit'}});
		expect(insufficient.status()).toBe(409);
		const audit=await db.auditLog.findMany({where:{entity:'LEDGER_TRANSACTION',entityId:{in:[first.transactionId,debitResult.transactionId]}}});
		expect(audit).toHaveLength(2);
		const notifications=await page.request.get('/api/notifications?limit=100').then(response=>response.json());
		expect(notifications.notifications.some((item:{message:string})=>item.message.includes(first.reference)&&item.message.includes('25.00 USD'))).toBe(true);
		await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(beforeDemo+20);

		const receiptUser=await createIsolatedDemoUser('admin-fund-receipt');
		await adminPage.goto('/admin/users');
		await adminPage.locator('.admin-users-page').getByPlaceholder('Search accounts').fill(receiptUser.email);
		const receiptUserCard=adminPage.locator('article').filter({hasText:receiptUser.email}).first();
		await expect(receiptUserCard).toBeVisible();
		await receiptUserCard.getByText('Account controls, verification, and ledger').click();
		await receiptUserCard.getByLabel('Amount',{exact:true}).fill('5.25');
		await receiptUserCard.getByLabel('Reason',{exact:true}).fill('E2E printable admin funding receipt');
		await receiptUserCard.getByRole('button',{name:'Record ledger adjustment'}).click();
		await expect(receiptUserCard.getByRole('heading',{name:'Direct funding receipt'})).toBeVisible();
		await expect(receiptUserCard.getByText('OFFICIAL RECEIPT')).toBeVisible();
		await expect(receiptUserCard.getByText('DEMO · VIRTUAL ACCOUNT RECORD')).toBeVisible();
		const receiptDownload=adminPage.waitForEvent('download');
		await receiptUserCard.getByRole('button',{name:'Download PDF'}).click();
		expect((await receiptDownload).suggestedFilename()).toContain('credit-completed');
	}
	finally{await adminContext.close();}
});

test('DEMO accounts cannot access investments while REAL investments remain internal without market data',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const priorBitcoinAddress=await db.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const clearedBitcoinAddress=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:''}});
		expect(clearedBitcoinAddress.status()).toBe(200);
		const opportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E internal opportunity',category:'Test allocation',description:'Disposable investment terms for isolated Playwright coverage.',assetSymbol:null,minimumAmount:100,maximumAmount:10000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:false,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(opportunityResponse.status()).toBe(201);
		const opportunity=await opportunityResponse.json();
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const initialDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		const initialDemoBalance=Number(initialDemoWallet.balance);
		expect((await page.request.get('/api/investments')).status()).toBe(403);
		const forbiddenDemoSubmission=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:100}});
		expect(forbiddenDemoSubmission.status()).toBe(403);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialDemoBalance);
		await page.goto('/investments');
		await expect(page).toHaveURL(/\/dashboard/);
		await expect(page.getByRole('link',{name:/Investments/i})).toHaveCount(0);

		const unrelatedContext=await browser.newContext();
		try{
			const unrelatedPage=await unrelatedContext.newPage();
			await loginAs(unrelatedPage,fixture('LEGACY_USER_EMAIL'),fixture('LEGACY_USER_PASSWORD'));
			expect((await unrelatedPage.request.get('/api/investments')).status()).toBe(403);
			expect((await unrelatedPage.request.get('/api/admin/investments')).status()).toBe(403);
		}finally{await unrelatedContext.close();}

		await selectAccountMode(page,'REAL');
		const initialRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const investorId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		await seedRealWalletForTest(investorId,'1000.00');
		const realWalletAfterAllocation=await page.request.get('/api/wallet').then(response=>response.json());
		expect(realWalletAfterAllocation.balance).toBe(String(initialRealBalance+1000));
			const unavailableMethods=await page.request.get('/api/payment-methods').then(response=>response.json());
				expect(unavailableMethods).toMatchObject({methods:[],fundingStatus:'AVAILABLE',simulationAvailable:true,realFundingAvailable:true,realWithdrawalAvailable:true,manualDepositReviewAvailable:true,internalLedgerOnly:true});
			const existingFunding=await page.request.get('/api/wallet').then(response=>response.json());
			const blockedFunding=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',paymentMethodId:'not-configured',amount:10,currency:'USD',transactionReference:`E2E-${randomUUID()}`}));
			expect(blockedFunding.status()).toBe(400);
			expect((await blockedFunding.json()).error).toContain('External payment methods are disabled');
			expect(await page.request.get('/api/wallet').then(async response=>(await response.json()).transactions.length)).toBe(existingFunding.transactions.length);
			const nonUsdDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:0.001,currency:'BTC'}});
			expect(nonUsdDeposit.status()).toBe(400);
			expect((await nonUsdDeposit.json()).error).toContain('USD');
			await page.goto('/wallet');
			await page.getByRole('link',{name:'Deposit'}).click();
			await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
			await expect(page.getByLabel('Amount',{exact:true})).toBeVisible();
			await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
			await expect(page.getByLabel('BTC address')).toHaveCount(0);
			await expect(page.getByLabel('Optional supporting attachment')).toBeVisible();
		await page.goto('/investments');
		await expect(page.getByText('Internal allocations only. Funds are reserved until settlement; modeled returns are not guaranteed.')).toBeVisible();
		const selectedTheme=await page.locator('html').getAttribute('data-theme-name');
		await expect(page.locator('.investment-disclosure-banner')).toHaveCSS('color',selectedTheme==='premium-dashboard'?'rgb(100, 113, 104)':'rgb(161, 175, 164)');
		const realRequestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:500}});
		expect(realRequestResponse.status()).toBe(201);
		const realRequest=await realRequestResponse.json();
		expect(realRequest.status).toBe('ACTIVE');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBeCloseTo(initialRealBalance+500,2);
		const hideOpportunity=await adminPage.request.patch('/api/admin/investments',{data:{action:'update-opportunity',id:opportunity.id,status:'CLOSED'}});
		expect(hideOpportunity.status()).toBe(200);
		const hiddenOffers=await page.request.get('/api/investments').then(response=>response.json());
		expect(hiddenOffers.opportunities).not.toEqual(expect.arrayContaining([expect.objectContaining({id:opportunity.id})]));
		expect(hiddenOffers.requests).toEqual(expect.arrayContaining([expect.objectContaining({id:realRequest.id,status:'ACTIVE'})]));
		await db.investmentRequest.update({where:{id:realRequest.id},data:{maturesAt:new Date(Date.now()-1000)}});
		await settleMaturedSimulatedInvestments();
		await settleMaturedSimulatedInvestments();
		const userInvestments=await page.request.get('/api/investments').then(response=>response.json());
		const settledRealRequest=userInvestments.requests.find((item:{id:string})=>item.id===realRequest.id);
		expect(settledRealRequest).toMatchObject({status:'SETTLED',settlementReference:`REAL-AUTO-PAYOUT:${realRequest.id}`,simulatedPayout:'540'});
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${realRequest.id}:PAYOUT`}})).toBe(1);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBeCloseTo(initialRealBalance+1040,2);
		const tradeableInstrument=await db.instrument.findUniqueOrThrow({where:{symbol:'AAPL'}});
		const liveMarketResponse=await page.request.get('/api/live-markets?symbols=AAPL');
		const liveMarket=await liveMarketResponse.json();
		expect(liveMarket.quotes?.some((quote:{asset?:{id?:string};source?:string})=>quote.asset?.id==='AAPL'&&quote.source==='Twelve Data')).toBe(false);
		const walletBeforeRealOrder=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const realOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:tradeableInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(tradeableInstrument.price),observedAt:tradeableInstrument.updatedAt.toISOString()}});
		const realOrderResult=await realOrder.json();
		expect(realOrder.status(),JSON.stringify(realOrderResult)).toBe(503);
		expect(realOrderResult.error).toContain('Twelve Data market quote is unavailable');
		const realPositionsAfterOrder=await page.request.get('/api/positions').then(response=>response.json());
		expect(realPositionsAfterOrder).toHaveLength(0);
		const realPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
		expect(realPortfolio.positions).toHaveLength(0);
		const finalRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		expect(finalRealBalance).toBe(walletBeforeRealOrder);
		expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);

		await selectAccountMode(page,'DEMO');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialDemoBalance);
			expect((await page.request.get('/api/investments')).status()).toBe(403);
			await expect(page).toHaveURL(/\/dashboard/);
			await expect(page.getByRole('button',{name:'More account navigation'})).toBeVisible();
			await logout(page);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		const persistedDemoWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(persistedDemoWallet.balance)).toBe(initialDemoBalance);
		await selectAccountMode(page,'REAL');
			await expect.poll(async()=>Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(finalRealBalance);
		await expectNoHorizontalOverflow(page);
	}finally{
		if(adminPage.isClosed()===false){
			await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:priorBitcoinAddress?.value||''}}).catch(()=>undefined);
		}
		await adminContext.close();
	}
});

test('admin investment initiation reserves once, honors withdrawal reservations, and activates on schedule',async({browser,page})=>{
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		await requestRealBalanceAdjustment(browser,adminPage,{userId,accountMode:'REAL',currency:'USD',amount:'2000.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Isolated investment lifecycle test funding',idempotencyKey:randomUUID()});
		const initialBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const opportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E admin allocation',category:'Scheduled test',description:'Administrator-initiated simulated investment for ledger reconciliation.',assetSymbol:null,minimumAmount:100,maximumAmount:100000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:false,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(opportunityResponse.status()).toBe(201);
		const opportunity=await opportunityResponse.json();
		const startsAt=new Date(Date.now()+3_600_000);
		const maturesAt=new Date(startsAt.getTime()+30*86_400_000);
		const idempotencyKey=randomUUID();
		const payload={action:'initiate',userId,opportunityId:opportunity.id,accountMode:'REAL',amount:500,targetReturnPercent:null,startsAt:startsAt.toISOString(),maturesAt:maturesAt.toISOString()};
		const initiated=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(initiated.status()).toBe(201);
		const investment=await initiated.json();
		expect(investment).toMatchObject({userId,opportunityId:opportunity.id,status:'APPROVED',amount:'500',targetReturnPercent:'8'});
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-500);
		const secondOpportunityResponse=await adminPage.request.post('/api/admin/investments',{data:{title:'E2E second allocation',category:'Scheduled test',description:'A second independent opportunity for concurrent allocation coverage.',assetSymbol:null,minimumAmount:100,maximumAmount:100000,targetReturnPercent:null,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'LOW',status:'AVAILABLE',demoEligible:false,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
		expect(secondOpportunityResponse.status()).toBe(201);
		const secondOpportunity=await secondOpportunityResponse.json();
		const secondRequestResponse=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,opportunityId:secondOpportunity.id,amount:250,targetReturnPercent:null}});
		expect(secondRequestResponse.status()).toBe(201);
		const secondRequest=await secondRequestResponse.json();
		const simultaneousRequests=await db.investmentRequest.findMany({where:{userId},select:{id:true}});
		expect(simultaneousRequests.map(item=>item.id)).toEqual(expect.arrayContaining([investment.id,secondRequest.id]));
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);
		const reserveReference=`INVESTMENT:${investment.id}:RESERVE`;
		expect(await db.ledgerTransaction.count({where:{reference:reserveReference}})).toBe(1);
		const replay=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).id).toBe(investment.id);
		expect(await db.ledgerTransaction.count({where:{reference:reserveReference}})).toBe(1);
		const mismatchedReplay=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,amount:501}});
		expect(mismatchedReplay.status()).toBe(409);

		await db.fundingRequest.create({data:{userId,type:FundingType.WITHDRAWAL,method:'E2E reserved withdrawal',amount:9000,currency:'USD',accountMode:'REAL',status:FundingStatus.PENDING_REVIEW,idempotencyKey:`e2e:${randomUUID()}`}});
		const blocked=await adminPage.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:91000}});
		expect(blocked.status()).toBe(400);
		expect((await blocked.json()).error).toBe('insufficient simulated balance');
		expect(await db.investmentRequest.count({where:{userId,opportunityId:opportunity.id}})).toBe(1);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);

		await settleMaturedSimulatedInvestments(new Date(startsAt.getTime()+1000));
		expect((await db.investmentRequest.findUniqueOrThrow({where:{id:investment.id}})).status).toBe('ACTIVE');
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(initialBalance-750);
		const activationNotification=await db.notification.findFirst({where:{userId,relatedEntity:'INVESTMENT',relatedId:investment.id,title:'REAL investment started'},select:{accountMode:true}});
		expect(activationNotification).toMatchObject({accountMode:'REAL'});
	}finally{await adminContext.close();}
});

test('admin can target an offer to multiple users and closing it preserves accepted expiry settlement',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const targeted=await createIsolatedDemoUser('targeted-investment-a');
	const secondTarget=await createIsolatedDemoUser('targeted-investment-b');
	const notTargeted=await createIsolatedDemoUser('untargeted-investment');
	const targetContext=await browser.newContext();
	const secondContext=await browser.newContext();
	const outsiderContext=await browser.newContext();
	try{
		const targetPage=await targetContext.newPage();
		const secondPage=await secondContext.newPage();
		const outsiderPage=await outsiderContext.newPage();
		await loginAs(targetPage,targeted.email,targeted.password);
		await loginAs(secondPage,secondTarget.email,secondTarget.password);
		await loginAs(outsiderPage,notTargeted.email,notTargeted.password);
		await selectAccountMode(targetPage,'REAL');
		await selectAccountMode(secondPage,'REAL');
		await selectAccountMode(outsiderPage,'REAL');
		const targetUserId=await targetPage.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		const secondUserId=await secondPage.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		for(const userId of [targetUserId,secondUserId])await seedRealWalletForTest(userId,'500.00');
		const create=await page.request.post('/api/admin/investments',{data:{
			title:'Targeted internal expiry plan',category:'Targeted test',description:'Targeted opportunity verifies recipients, user acceptance, and expiry settlement.',
			assetSymbol:null,minimumAmount:10,maximumAmount:500,targetReturnPercent:10,durationDays:7,startsAt:null,maturesAt:null,
			riskLevel:'LOW',status:'AVAILABLE',demoEligible:false,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null,
			audience:'TARGETED',recipientUserIds:[targetUserId,secondUserId],
		}});
		expect(create.status()).toBe(201);
		const opportunity=await create.json();
		for(const userPage of [targetPage,secondPage]){
			const offers=await userPage.request.get('/api/investments').then(response=>response.json());
			expect(offers.opportunities).toEqual(expect.arrayContaining([expect.objectContaining({id:opportunity.id})]));
		}
		const outsiderOffers=await outsiderPage.request.get('/api/investments').then(response=>response.json());
		expect(outsiderOffers.opportunities).not.toEqual(expect.arrayContaining([expect.objectContaining({id:opportunity.id})]));
		const unauthorizedAcceptance=await outsiderPage.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:10}});
		expect(unauthorizedAcceptance.status()).toBe(409);
		const startingBalance=Number((await targetPage.request.get('/api/wallet').then(response=>response.json())).balance);
		const accepted=await targetPage.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:opportunity.id,amount:100}});
		expect(accepted.status()).toBe(201);
		const investment=await accepted.json();
		expect(investment.status).toBe('ACTIVE');
		expect(Number((await targetPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance-100);
		const notificationCount=await db.notification.count({where:{userId:{in:[targetUserId,secondUserId]},relatedEntity:'INVESTMENT_OPPORTUNITY',relatedId:opportunity.id}});
		expect(notificationCount).toBe(2);
		const closed=await page.request.patch('/api/admin/investments',{data:{action:'update-opportunity',id:opportunity.id,status:'CLOSED'}});
		expect(closed.status()).toBe(200);
		const afterClose=await targetPage.request.get('/api/investments').then(response=>response.json());
		expect(afterClose.opportunities).not.toEqual(expect.arrayContaining([expect.objectContaining({id:opportunity.id})]));
		expect(afterClose.requests).toEqual(expect.arrayContaining([expect.objectContaining({id:investment.id,status:'ACTIVE'})]));
		await db.investmentRequest.update({where:{id:investment.id},data:{maturesAt:new Date(Date.now()-1000)}});
		await settleMaturedSimulatedInvestments();
		await settleMaturedSimulatedInvestments();
		const settled=await db.investmentRequest.findUniqueOrThrow({where:{id:investment.id}});
		expect(settled.status).toBe('SETTLED');
		expect(settled.simulatedPayout?.toFixed(2)).toBe('110.00');
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${investment.id}:PAYOUT`}})).toBe(1);
		expect(Number((await targetPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance+10);
		expect((await targetPage.request.get('/api/investments').then(response=>response.json())).requests).toEqual(expect.arrayContaining([expect.objectContaining({id:investment.id,status:'SETTLED'})]));
		expect(await db.investmentOpportunity.findUnique({where:{id:opportunity.id}})).not.toBeNull();
	}finally{
		await Promise.all([targetContext.close(),secondContext.close(),outsiderContext.close()]);
	}
});

test('Nova escalation reaches admin and admin response appears with notification',async({page})=>{
	const subject=`E2E support ${randomUUID().slice(0,8)}`;
	const reply='Temporary Playwright admin response.';
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
	const wallet=await page.request.get('/api/wallet').then(response=>response.json());
	const novaResponse=await page.request.post('/api/support/nova',{data:{question:'What is my wallet balance?',conversationId:randomUUID()}});
	expect(novaResponse.status()).toBe(200);
	expect((await novaResponse.json()).answer).toContain(String(wallet.balance));
	const portfolioReply=await page.request.post('/api/support/nova',{data:{question:'What are my positions and order history?',conversationId:randomUUID(),userId:'another-user-id'}});
	expect(portfolioReply.status()).toBe(200);
	expect((await portfolioReply.json()).answer).toContain('DEMO account');
	expect((await portfolioReply.json()).answer).toContain('order history contains');
	const watchlistReply=await page.request.post('/api/support/nova',{data:{question:'What is my watchlist?',conversationId:randomUUID()}});
	expect((await watchlistReply.json()).answer).toContain('cannot read a saved watchlist from the server');
	const notificationReply=await page.request.post('/api/support/nova',{data:{question:'How many unread notifications do I have?',conversationId:randomUUID()}});
	expect((await notificationReply.json()).answer).toMatch(/\d+ unread notification/);
	const investmentReply=await page.request.post('/api/support/nova',{data:{question:'What are my investment requests and available plans?',conversationId:randomUUID()}});
	expect(investmentReply.status()).toBe(200);
	expect((await investmentReply.json()).answer).toContain('Investment allocations are not available in DEMO mode');
	const paymentReply=await page.request.post('/api/support/nova',{data:{question:'How do I make a deposit?',conversationId:randomUUID()}});
	expect((await paymentReply.json()).answer).toContain('DEMO');
	expect((await paymentReply.json()).answer).toContain('DEMO funds are virtual and remain separate from REAL account balances.');
	const supportContact=await page.request.get('/api/support/contact').then(response=>response.json());
	if(supportContact.email)await expect(page.getByRole('link',{name:new RegExp(supportContact.email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))})).toBeVisible();
	else await expect(page.getByText('Direct email is not configured. Authenticated support tickets remain available.')).toBeVisible();
	await page.getByRole('button',{name:'Contact Admin'}).click();
	await page.getByLabel('Category').selectOption('FUNDING');
	await page.getByLabel('Subject').fill(subject);
	await page.getByRole('textbox',{name:'Message',exact:true}).fill('Please review this disposable browser test ticket.');
	await page.getByRole('button',{name:'Create support ticket'}).click();
	await expect(page.getByRole('status').filter({hasText:/created\./i})).toBeVisible();
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/support');
	await page.getByRole('button',{name:new RegExp(subject)}).click();
	const priority=page.locator('.admin-support-ticket-controls select').nth(1);
	await priority.selectOption('HIGH');
	await expect(priority).toHaveValue('HIGH');
	await page.getByLabel('Admin response').fill(reply);
	await page.getByRole('button',{name:'Send response'}).click();
	await expect(page.getByRole('status')).toContainText('Response sent to the user');
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/notifications');
	const replyNotification=page.locator('.notification-history-item').filter({hasText:subject});
	await expect(replyNotification.getByText('Admin replied to your support ticket',{exact:true})).toBeVisible();
	await page.goto('/support');
	const ticket=page.getByRole('button').filter({hasText:subject});
	await ticket.click();
	await expect(page.getByText(reply)).toBeVisible();
	const conversationId=await page.request.get('/api/support').then(async response=>{
		expect(response.ok()).toBe(true);
		const tickets=await response.json();
		return tickets.find((item:{subject:string})=>item.subject===subject).id as string;
	});
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const closed=await page.request.patch('/api/admin/support',{data:{action:'status',conversationId,status:'CLOSED'}});
	expect(closed.ok()).toBe(true);
	await logout(page);
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/support');
	await page.getByRole('button').filter({hasText:subject}).click();
	await expect(page.getByText(/CLOSED/)).toBeVisible();
	await expect(page.getByRole('textbox',{name:'Reply to support ticket'})).toHaveCount(0);
	const replyToClosed=await page.request.post('/api/support',{data:{action:'reply',conversationId,message:'Reply to a closed ticket.'}});
	expect(replyToClosed.status()).toBe(409);
});

test('profile completion and administrator identity review progress the account through all tiers',async({browser,page})=>{
	const user=await createIsolatedDemoUser('tier-progression');
	await loginAs(page,user.email,user.password);
	await db.user.update({where:{email:user.email},data:{phone:'+14155552671',phoneVerified:true,phoneVerifiedAt:new Date()}});
	const profileUpdate=await page.request.patch('/api/profile',{data:{name:'Profile Complete User',country:'United States',address:'123 Test Street, Test City'}});
	expect(profileUpdate.ok()).toBe(true);
	const forgedTier=await page.request.patch('/api/profile',{data:{name:'Profile Complete User',approvedTier:3}});
	expect(forgedTier.ok()).toBe(true);
	expect((await forgedTier.json()).label).toBe('TIER 2');
	await page.goto('/dashboard');
	await expect(page.locator('.user-dashboard-profile-line').getByLabel('Current account tier: TIER 2')).toBeVisible();
	await page.setViewportSize({width:320,height:800});
	await page.goto('/tier');
	await expect(page.getByRole('heading',{name:'Your account tier.'})).toBeVisible();
	await expect(page.getByRole('region',{name:'Current tier progress'})).toContainText('TIER 2');
	await expect(page.locator('.tier-step.is-current')).toContainText('Current');
	await expectNoHorizontalOverflow(page);
	const state=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(state.currentTier).toBe(2);
	expect(state.permissions.tierBenefits).toBe(true);
	expect(state.permissions.realMoneyServices).toBe(false);
	const demoRequest=await page.request.post('/api/tier-requests',{data:{message:'Should not be accepted in DEMO mode.'}});
	expect(demoRequest.status()).toBe(403);
	await page.setViewportSize({width:1280,height:900});
	await page.goto('/dashboard');
	await selectAccountMode(page,'REAL');
	const blockedRequest=await page.request.post('/api/tier-requests',{data:{message:'KYC is not submitted for this isolated profile.'}});
	expect(blockedRequest.status()).toBe(409);
	const denied=await page.request.patch('/api/admin/tier-requests',{data:{id:'not-a-real-request',status:'APPROVED',reason:'Should be denied for a user.'}});
	expect(denied.status()).toBe(403);

	const isolated=await db.user.findUniqueOrThrow({where:{email:user.email},select:{id:true}});
	const submittedAt=new Date();
	await db.user.update({where:{id:isolated.id},data:{phoneVerified:true,phoneVerifiedAt:submittedAt}});
	await db.$transaction(async tx=>{
		await tx.user.update({where:{id:isolated.id},data:{kycStatus:'APPROVED',verifiedAt:submittedAt}});
	});
	const documentBytes=Buffer.from('%PDF-1.4\n% KYC E2E document\n');
	const documentUpload=await page.request.post('/api/kyc/documents',{multipart:{
		kind:'PROOF_OF_ADDRESS',
		file:{name:'proof-of-address.pdf',mimeType:'application/pdf',buffer:documentBytes},
	}});
	expect(documentUpload.status()).toBe(201);
	const eligibility=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(eligibility.canRequest).toBe(true);
	expect(eligibility.requirements.identityApproved).toBe(true);
	expect(eligibility.requirements.identityDocumentApproved).toBe(false);
	const submittedRequest=await page.request.post('/api/tier-requests',{data:{message:'Isolated tier progression review.'}});
	expect(submittedRequest.status()).toBe(201);
	const requestRecord=await submittedRequest.json();

	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const prematureApproval=await adminPage.request.patch('/api/admin/tier-requests',{data:{id:requestRecord.id,status:'APPROVED',reason:'Must wait for evidence review.'}});
	expect(prematureApproval.status()).toBe(409);
	const informationNeeded=await adminPage.request.patch('/api/admin/tier-requests',{data:{id:requestRecord.id,status:'NEEDS_INFORMATION',reason:'Please confirm the approved identity review.'}});
	expect(informationNeeded.ok()).toBe(true);
	const userReply=await page.request.patch('/api/tier-requests',{data:{id:requestRecord.id,message:'The administrator-approved identity review is accurate.'}});
	expect(userReply.ok()).toBe(true);
	await db.$transaction(async tx=>{
		await tx.kycProfile.update({where:{userId:isolated.id},data:{reviewedAt:submittedAt}});
		await tx.kycDocument.updateMany({where:{userId:isolated.id,status:'SUBMITTED'},data:{status:'APPROVED',reviewedAt:submittedAt}});
	});
	const approved=await adminPage.request.patch('/api/admin/tier-requests',{data:{id:requestRecord.id,status:'APPROVED',reason:'Identity decision and proof of address reviewed in the isolated test.'}});
	expect(approved.ok()).toBe(true);
	await adminPage.goto('/admin/tiers');
	await expect(adminPage.getByRole('heading',{name:'Tier management'})).toBeVisible();
	const directory=await adminPage.request.get(`/api/admin/tier-requests?search=${encodeURIComponent(user.email)}`);
	expect(directory.ok()).toBe(true);
	const directoryData=await directory.json();
	expect(directoryData.accounts).toEqual(expect.arrayContaining([expect.objectContaining({email:user.email,currentTier:3})]));
	await adminPage.setViewportSize({width:390,height:844});
	await adminPage.goto('/admin/tiers');
	await expectNoHorizontalOverflow(adminPage);
	await adminPage.setViewportSize({width:1280,height:900});
	await expectNoHorizontalOverflow(adminPage);
	await adminPage.setViewportSize({width:390,height:844});
	await adminPage.getByLabel('Search name, email, or account ID').fill(user.email);
	await adminPage.locator('.admin-tier-filters').getByRole('button',{name:'Search'}).click();
	const tierAccount=adminPage.locator('.admin-tier-account').filter({hasText:user.email});
	await expect(tierAccount).toBeVisible();
	await tierAccount.locator('summary').click();
	await expect(tierAccount.getByRole('link',{name:/Permanent deletion controls/})).toHaveAttribute('href',new RegExp(`/admin/users\\?search=${encodeURIComponent(isolated.id)}`));
	await tierAccount.getByRole('button',{name:'Hide from this list'}).click();
	await expect(tierAccount).toHaveCount(0);
	await adminPage.getByRole('button',{name:/Show hidden accounts/}).click();
	await expect(tierAccount).toBeVisible();
	await tierAccount.locator('summary').click();
	await tierAccount.getByRole('button',{name:'Unhide'}).click();
	await adminPage.getByRole('button',{name:'Show accounts'}).click();
	await expect(tierAccount).toBeVisible();
	await tierAccount.locator('summary').click();
	adminPage.once('dialog',dialog=>dialog.accept());
	await tierAccount.getByRole('button',{name:'Move to Deleted Items'}).click();
	await expect(tierAccount).toHaveCount(0);
	const deletedDirectory=await adminPage.request.get(`/api/admin/tier-requests?search=${encodeURIComponent(user.email)}&status=DELETED`).then(response=>response.json());
	expect(deletedDirectory.accounts).toEqual(expect.arrayContaining([expect.objectContaining({id:isolated.id,status:'DELETED'})]));
	await adminPage.goto(`/admin/users?search=${encodeURIComponent(isolated.id)}&showDeleted=true`);
	await expect(adminPage.getByRole('button',{name:'Restore'})).toBeVisible();
	await adminPage.getByRole('button',{name:'Restore'}).click();
	await expect.poll(()=>db.user.findUniqueOrThrow({where:{id:isolated.id},select:{status:true}}).then(account=>account.status)).toBe('ACTIVE');
	await adminContext.close();
	const updated=await page.request.get('/api/tier-requests').then(response=>response.json());
	expect(updated.currentTier).toBe(3);
	await page.setViewportSize({width:320,height:800});
	await page.goto('/tier');
	await expect(page.locator('.tier-step.is-current')).toContainText('Current');
	await expectNoHorizontalOverflow(page);
	const instrument=(await page.request.get('/api/market').then(response=>response.json()))[0];
	const walletBeforeOrder=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const realOrder=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt||instrument.updatedAt}});
	expect(realOrder.status()).toBe(503);
	expect((await realOrder.json()).error).toContain('Twelve Data market quote is unavailable');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(walletBeforeOrder);
	expect(await page.request.get('/api/orders').then(response=>response.json())).toHaveLength(0);
});

test('administrator email sign-in persists through refresh and logout removes admin access',async({page})=>{
	await page.goto('/admin/login');
	await waitForStartup(page);
	await page.getByLabel('Admin username').fill(fixture('ADMIN_EMAIL'));
	await page.getByLabel('Admin password',{exact:true}).fill(fixture('ADMIN_PASSWORD'));
	await page.getByRole('checkbox',{name:/Replace another active Aurevia session/}).check();
	await page.getByRole('button',{name:'Enter control center'}).click();
	await page.waitForURL(/\/admin$/);
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await expect(page.getByRole('navigation',{name:'Administrator navigation'}).getByRole('link',{name:'CRM Dashboard'})).toBeVisible();
	await page.setViewportSize({width:390,height:844});
	const adminNavigation=page.getByRole('navigation',{name:'Administrator navigation'});
	await expect(adminNavigation.getByRole('link',{name:'CRM Dashboard'})).toBeVisible();
	await expect(adminNavigation.getByRole('link',{name:'Verified accounts'})).toBeVisible();
	await expect(adminNavigation.getByRole('link',{name:'Funding'})).toBeVisible();
	expect(await page.getByRole('navigation',{name:'Primary navigation'}).count()).toBe(0);
	await page.reload();
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await page.setViewportSize({width:1440,height:900});
	await logout(page);
	await expect(page).toHaveURL(/\/login/);
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/login/);
});

test('account navigation exposes learning, news, activity, conversion, and Nova assistant',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	await page.setViewportSize({width:390,height:844});
	await page.getByRole('navigation',{name:'Primary account navigation'}).getByRole('button',{name:'More navigation'}).click();
	const menu=page.getByRole('dialog',{name:'More'});
	await expect(menu.getByRole('link',{name:'Investment education'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'News & updates'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'Account activity'})).toBeVisible();
	await expect(menu.getByRole('link',{name:'Currency conversion'})).toBeVisible();
	await menu.getByRole('link',{name:'AI Assistant'}).click();
	await expect(page).toHaveURL(/\/support#nova$/);
	await expect(page.locator('#nova')).toBeInViewport();
});

test('admin ledger adjustments update isolated DEMO and REAL accounts with audit and idempotency',async({browser,page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const before=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'REAL');
	const beforeRealBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await selectAccountMode(page,'DEMO');
	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const unverifiedCustomer=await db.user.findUniqueOrThrow({where:{email:fixture('USER_EMAIL')},select:{id:true,kycStatus:true}});
	expect(unverifiedCustomer.kycStatus).toBe('PENDING');
	const unverifiedRealAccount=await db.ledgerAccount.findUnique({where:{code:`USER:${unverifiedCustomer.id}:REAL:USD`},select:{id:true}});
	const unverifiedRealBalance=unverifiedRealAccount?await ledgerBalance(db,unverifiedRealAccount.id):new Prisma.Decimal(0);
	await requestRealBalanceAdjustment(browser,page,{userId:unverifiedCustomer.id,accountMode:'REAL',currency:'USD',amount:'10.00',direction:'CREDIT',category:'PROMOTIONAL',reason:'Free simulated account allocation',idempotencyKey:randomUUID()});
	const unverifiedRealAccountAfter=await db.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${unverifiedCustomer.id}:REAL:USD`},select:{id:true}});
	expect(Number(await ledgerBalance(db,unverifiedRealAccountAfter.id))).toBeCloseTo(Number(unverifiedRealBalance)+10,2);
	expect(await db.auditLog.count({where:{action:'BANK_OPERATION_POSTED',entity:'BANK_OPERATION'}})).toBeGreaterThan(0);
	const creditKey=randomUUID();
	const demoCredit=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved simulated training allocation',idempotencyKey:creditKey}});
	expect(demoCredit.status()).toBe(201);
	expect((await demoCredit.json()).newBalance).toBe(String(before+25.5));
	const duplicateDemoCredit=await page.request.post('/api/admin/balances',{data:{userId,accountMode:'DEMO',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Approved simulated training allocation',idempotencyKey:creditKey}});
	expect(duplicateDemoCredit.status()).toBe(200);
	const realKey=randomUUID();
	const realCredit=await requestRealBalanceAdjustment(browser,page,{userId,accountMode:'REAL',currency:'USD',amount:'25.50',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Administrator-recorded allocation pending external settlement',idempotencyKey:realKey});
	expect(realCredit.request.status).toBe('PENDING');
	await page.goto('/admin/users');
	await page.getByRole('textbox',{name:'Search users by Aurevia ID, internal ID, name, or email'}).fill(fixture('INVESTOR_EMAIL'));
	const investorAccount=page.locator('article').filter({hasText:fixture('INVESTOR_EMAIL')}).first();
	await expect(investorAccount).toBeVisible();
	await investorAccount.getByText('Account controls, verification, and ledger').click();
	const adjustmentForm=investorAccount.locator('form').first();
	await adjustmentForm.getByLabel('Account').selectOption('REAL');
	await adjustmentForm.getByLabel('Amount').fill('2500.00');
	await adjustmentForm.getByLabel('Reason').fill('Approved administrator-recorded allocation pending settlement');
	await adjustmentForm.getByRole('button',{name:'Record ledger adjustment'}).click();
	await expect(page.getByRole('status')).toContainText('Submitted REAL wallet credit request');
	const pendingOperation=(await page.request.get('/api/admin/bank').then(response=>response.json())).pendingOperations.find((operation:{userId:string;reason:string})=>operation.userId===userId&&operation.reason==='Approved administrator-recorded allocation pending settlement');
	expect(pendingOperation).toBeTruthy();
	await approveBankOperation(browser,pendingOperation.id);
	await logout(page);
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const realWallet=await page.request.get('/api/wallet').then(response=>response.json());
	const realBalance=Number(realWallet.balance);
	expect(realBalance).toBeCloseTo(beforeRealBalance+2525.5,2);
	const realActivity=await page.request.get('/api/bank/transactions?search=Approved%20administrator-recorded%20allocation%20pending%20settlement').then(response=>response.json());
	expect(realActivity.transactions.some((item:{entries:Array<{type:string;amount:string}>})=>item.entries.some(entry=>entry.type==='CREDIT'&&Number(entry.amount)===2500))).toBe(true);
	await selectAccountMode(page,'DEMO');
	const after=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(after).toBeCloseTo(before+25.5,2);
});

test('a normal customer cannot access the administrator dashboard',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/dashboard$/);
	expect((await page.request.get('/api/admin/verified-accounts')).status()).toBe(403);
});

test('administrator sessions stay in the isolated console and cannot use customer APIs',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/dashboard');
	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	await expect(page.getByRole('link',{name:'User portal'})).toHaveCount(0);
	expect((await page.request.get('/api/profile')).status()).toBe(403);
	await page.goto('/wallet');
	await expect(page).toHaveURL(/\/admin$/);
});

test('completed personal details remain read-only during the 60-day lock window',async({page})=>{
	const user=await db.user.findUniqueOrThrow({where:{email:fixture('USER_EMAIL')},select:{id:true,name:true,kycStatus:true,verifiedAt:true,profileDetailsLastEditedAt:true}});
	const profileDetailsLastEditedAt=new Date(Date.now()-30*24*60*60*1000);
	try{
		await db.user.update({where:{id:user.id},data:{kycStatus:'APPROVED',verifiedAt:new Date(),profileDetailsLastEditedAt}});
		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'REAL');
		await page.goto('/settings');
		await expect(page.getByRole('status').filter({hasText:'Verified profile details are locked'})).toBeVisible();
		await expect(page.getByLabel('First name')).toBeDisabled();
		const avatarInput=page.getByLabel('Choose profile photo');
		await expect(avatarInput).toBeEnabled();
		await avatarInput.setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:PNG.sync.write(new PNG({width:1,height:1}))});
		await expect(page.getByRole('button',{name:'Upload photo'})).toBeEnabled();
		await page.getByRole('button',{name:'Upload photo'}).click();
		const uploadedAvatar=page.locator('.profile-avatar img');
		await expect(uploadedAvatar).toBeVisible();
		await expect.poll(()=>uploadedAvatar.evaluate(image=>{
			const style=getComputedStyle(image);
			return {borderRadius:style.borderRadius,clipPath:style.clipPath,objectFit:style.objectFit};
		})).toEqual({borderRadius:'50%',clipPath:'circle(50%)',objectFit:'cover'});
		await expect(page.getByRole('button',{name:'Save profile'})).toBeDisabled();
		const update=await page.request.patch('/api/profile',{data:{name:'Changed Name',country:'Test',address:'Changed address'}});
		expect(update.status()).toBe(423);
		expect((await update.json()).error).toContain('locked');
		expect((await db.user.findUniqueOrThrow({where:{id:user.id},select:{name:true}})).name).toBe(user.name);
		const topbarAvatar=page.locator('.user-topbar-identity .user-topbar-avatar img');
		await expect(topbarAvatar).toBeVisible();
		await expect.poll(()=>topbarAvatar.evaluate(image=>{
			const style=getComputedStyle(image);
			return {borderRadius:style.borderRadius,clipPath:style.clipPath,objectFit:style.objectFit};
		})).toEqual({borderRadius:'50%',clipPath:'circle(50%)',objectFit:'cover'});
		await page.setViewportSize({width:390,height:844});
		await page.goto('/dashboard');
		const mobileAvatar=page.locator('.mobile-home-avatar img');
		await expect(mobileAvatar).toBeVisible();
		await expect.poll(()=>mobileAvatar.evaluate(image=>{
			const style=getComputedStyle(image);
			return {borderRadius:style.borderRadius,clipPath:style.clipPath,objectFit:style.objectFit};
		})).toEqual({borderRadius:'50%',clipPath:'circle(50%)',objectFit:'cover'});
		await page.goto('/');
		const homeAvatar=page.locator('.home-profile-link img');
		await expect(homeAvatar).toBeVisible();
		await expect.poll(()=>homeAvatar.evaluate(image=>getComputedStyle(image).objectFit)).toBe('cover');
	}finally{
		await db.user.update({where:{id:user.id},data:{kycStatus:user.kycStatus,verifiedAt:user.verifiedAt,profileDetailsLastEditedAt:user.profileDetailsLastEditedAt}});
	}
});

test('administrator user and KYC actions persist and report protected actions',async({page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin');
	await expect(page.getByRole('heading',{name:'CRM Dashboard'})).toBeVisible();
	const shortcuts=page.getByRole('navigation',{name:'Administrator dashboard shortcuts'});
	for(const label of ['Users','KYC verification','Funding','Investments','Orders and ledger','Settings'])await expect(shortcuts.getByRole('link',{name:label})).toBeVisible();
	const users=await page.request.get('/api/admin/users').then(response=>response.json());
	const user=users.find((item:{email:string})=>item.email===fixture('USER_EMAIL'));
	const investor=users.find((item:{email:string})=>item.email===fixture('INVESTOR_EMAIL'));
	expect(user).toBeTruthy();
	expect(investor).toBeTruthy();
	expect(users.some((item:{role:string})=>item.role==='ADMIN')).toBe(false);
	await db.user.update({where:{id:investor.id},data:{status:'ACTIVE',accountMode:'DEMO',approvedTier:1,kycStatus:'PENDING',verifiedAt:null}});
	const selfId=await page.request.get('/api/auth/session').then(response=>response.json().then(session=>session.user.id as string));
	const selfDemotion=await page.request.patch('/api/admin/users',{data:{userId:selfId,role:'USER'}});
	expect(selfDemotion.status()).toBe(409);
	expect((await selfDemotion.json()).error).toContain('roles are managed separately');
	const frozen=await page.request.patch('/api/admin/users',{data:{userId:user.id,status:'FROZEN'}});
	expect(frozen.ok()).toBeTruthy();
	await page.route('**/api/admin/users**',async route=>{
		if(route.request().method()!=='GET')return route.continue();
		const response=await route.fetch();
		const accounts=await response.json() as Array<{id:string;hasAvatar:boolean}>;
		await route.fulfill({status:response.status(),json:accounts.map(account=>account.id===user.id?{...account,hasAvatar:true}:account)});
	});
	await page.route(/\/api\/profile\/avatar\?userId=/,route=>{
		const requestedId=new URL(route.request().url()).searchParams.get('userId');
		if(requestedId!==user.id)return route.continue();
		return route.fulfill({json:{url:'/aurevia-logo.png'}});
	});
	await page.goto('/admin/users');
	await expect(page.getByRole('heading',{name:'User accounts'})).toBeVisible();
	const userRow=page.locator('article').filter({hasText:fixture('USER_EMAIL')}).first();
	await expect(userRow.getByRole('button',{name:'Reactivate Account'})).toBeVisible();
	await userRow.getByRole('button',{name:'Reactivate Account'}).click();
	await expect(userRow.getByRole('button',{name:'Suspend Account'})).toBeVisible();
	await expect(userRow.getByRole('img',{name:`${user.name||'User'} profile photo`})).toBeVisible();
	await expect(userRow.getByRole('button',{name:/Make (?:admin|user)/})).toHaveCount(0);
	const userRoleChange=await page.request.patch('/api/admin/users',{data:{userId:user.id,role:'ADMIN'}});
	expect(userRoleChange.status()).toBe(409);
	expect((await page.request.get('/api/admin/users').then(response=>response.json())).find((item:{id:string})=>item.id===user.id)?.role).toBe('USER');
	const controls=userRow.getByText('Account controls, verification, and ledger');
	await controls.click();
	await userRow.getByRole('button',{name:'Disable deposits'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.depositEnabled}).toBe(false);
	await userRow.getByRole('button',{name:'Enable deposits'}).click();
	await userRow.getByRole('button',{name:'Disable withdrawals'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.withdrawalEnabled}).toBe(false);
	await userRow.getByRole('button',{name:'Enable withdrawals'}).click();
	await userRow.getByLabel('Restriction reason').fill('E2E account review');
	await userRow.getByRole('button',{name:'Restrict account'}).click();
	await expect.poll(async()=>{const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());return refreshed.find((item:{id:string})=>item.id===user.id)?.accountRestricted}).toBe(true);
	await userRow.getByRole('button',{name:'Remove account restriction'}).click();
	const adjustmentForm=userRow.locator('form');
	await adjustmentForm.getByRole('combobox').nth(0).selectOption('DEMO');
	await adjustmentForm.getByRole('combobox').nth(1).selectOption('CREDIT');
	await adjustmentForm.getByRole('combobox').nth(2).selectOption('ADMIN_ALLOCATION');
	await adjustmentForm.getByRole('combobox').nth(3).selectOption('USD');
	await adjustmentForm.locator('input[type="number"]').fill('10');
	await adjustmentForm.locator('input[minlength="3"]').fill('E2E simulated account allocation');
	await adjustmentForm.getByRole('button',{name:'Record ledger adjustment'}).click();
	await expect(page.getByRole('status')).toContainText('Recorded credit of 10.00 USD in DEMO');
	expect(await db.ledgerTransaction.count({where:{description:{contains:'E2E simulated account allocation'}}})).toBe(1);
	await db.user.update({where:{id:investor.id},data:{accountMode:'REAL'}});
	const createPendingKycCase=async(supersedesId?:string)=>{
		const now=new Date();
		return db.kycVerification.create({data:{
			userId:investor.id,status:'PENDING_REVIEW',documentCountry:'US',documentType:'PASSPORT',
			registryVersion:kycRegistryVersion,consentVersion:kycConsentVersion,consentAt:now,submittedAt:now,processedAt:now,
			supersedesId,assessment:createManualReviewAssessment(),
			documents:{create:['FRONT','SELFIE'].map(side=>({
				userId:investor.id,kind:side==='SELFIE'?'SELFIE':'IDENTITY_DOCUMENT',documentSide:side,
				filename:`e2e-${randomUUID()}-${side.toLowerCase()}.png`,storageKey:`${investor.id}/${randomUUID()}.png`,
				mimeType:'image/png',size:128,status:'SUBMITTED',
			}))},
			events:{create:[
				{actorId:investor.id,fromStatus:'DRAFT',toStatus:'SUBMITTED',action:'USER_SUBMITTED'},
				{fromStatus:'SUBMITTED',toStatus:'PROCESSING',action:'BASIC_FILE_VALIDATION'},
				{fromStatus:'PROCESSING',toStatus:'PENDING_REVIEW',action:'AUTOMATED_ASSESSMENT_UNAVAILABLE'},
			]},
		},select:{id:true,documents:{select:{id:true,documentSide:true,filename:true}}}});
	};
	await page.goto('/admin/kyc');
	const kycPanel=page.getByRole('region',{name:'Verification operations centre'});
	const createAndOpenCase=async(supersedesId?:string)=>{
		const verification=await createPendingKycCase(supersedesId);
		await kycPanel.getByRole('button',{name:'Refresh'}).click();
		const openCase=kycPanel.getByRole('button',{name:'Open case'}).first();
		await expect(openCase).toBeVisible();
		await openCase.click();
		const caseDetail=kycPanel.locator('article').filter({hasText:`CASE ${verification.id}`}).first();
		await expect(caseDetail).toBeVisible();
		return {verification,caseDetail};
	};
	const rejectionCase=await createAndOpenCase();
	await rejectionCase.caseDetail.getByLabel('Customer-facing explanation or correction').fill('E2E manual review rejection.');
	await rejectionCase.caseDetail.getByLabel(/I independently reviewed this evidence/).check();
	await rejectionCase.caseDetail.getByRole('button',{name:'Reject',exact:true}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('REJECTED');
	const resubmissionCase=await createAndOpenCase();
	const frontEvidence=resubmissionCase.verification.documents.find(document=>document.documentSide==='FRONT');
	if(!frontEvidence)throw new Error('The E2E KYC case is missing its front document.');
	await resubmissionCase.caseDetail.getByLabel('Customer-facing explanation or correction').fill('Please replace the front image.');
	await resubmissionCase.caseDetail.getByLabel(`FRONT · ${frontEvidence.filename}`).check();
	await resubmissionCase.caseDetail.getByLabel(/I independently reviewed this evidence/).check();
	await resubmissionCase.caseDetail.getByRole('button',{name:'Request resubmission'}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('NEEDS_CHANGES');
	await db.$transaction(async tx=>{
		const changed=await tx.kycVerification.updateMany({where:{id:resubmissionCase.verification.id,status:'RESUBMISSION_REQUIRED'},data:{status:'CANCELLED'}});
		expect(changed.count).toBe(1);
		await tx.kycVerificationEvent.create({data:{verificationId:resubmissionCase.verification.id,actorId:investor.id,fromStatus:'RESUBMISSION_REQUIRED',toStatus:'CANCELLED',action:'SUPERSEDED_BY_RESUBMISSION'}});
	});
	const approvalCase=await createAndOpenCase(resubmissionCase.verification.id);
	await approvalCase.caseDetail.getByLabel(/I independently reviewed this evidence/).check();
	await approvalCase.caseDetail.getByRole('button',{name:'Approve case'}).click();
	await expect.poll(async()=>{
		const refreshed=await page.request.get('/api/admin/users').then(response=>response.json());
		return refreshed.find((item:{id:string})=>item.id===investor.id)?.kycStatus;
	}).toBe('APPROVED');
	const approvedInvestor=await db.user.findUniqueOrThrow({where:{id:investor.id},select:{verifiedAt:true}});
	expect(approvedInvestor.verifiedAt).toBeInstanceOf(Date);
	const caseHistory=await db.kycVerification.findMany({where:{id:{in:[rejectionCase.verification.id,resubmissionCase.verification.id,approvalCase.verification.id]}},select:{id:true,status:true,supersedesId:true}});
	expect(caseHistory).toEqual(expect.arrayContaining([
		{id:rejectionCase.verification.id,status:'REJECTED',supersedesId:null},
		{id:resubmissionCase.verification.id,status:'CANCELLED',supersedesId:null},
		{id:approvalCase.verification.id,status:'APPROVED',supersedesId:resubmissionCase.verification.id},
	]));
	expect(await db.auditLog.count({where:{actorId:selfId,entityId:{in:[rejectionCase.verification.id,resubmissionCase.verification.id,approvalCase.verification.id]},action:{in:['KYC_VERIFICATION_REJECT','KYC_VERIFICATION_RESUBMISSION_REQUIRED','KYC_VERIFICATION_APPROVE']}}})).toBe(3);
	const verifiedResponse=await page.request.get(`/api/admin/verified-accounts?search=${encodeURIComponent(fixture('INVESTOR_EMAIL'))}&tier=2&status=ACTIVE`);
	expect(verifiedResponse.ok()).toBe(true);
	const verifiedResults=await verifiedResponse.json();
	expect(verifiedResults.total).toBe(1);
	expect(verifiedResults.items[0]).toMatchObject({id:investor.id,email:fixture('INVESTOR_EMAIL'),kycStatus:'APPROVED',approvedTier:2,approval:{reviewedBy:{email:fixture('ADMIN_EMAIL')}}});
	await page.goto('/admin/verified-accounts');
	await expect(page.getByRole('heading',{name:'Verified Accounts'})).toBeVisible();
	await page.getByRole('textbox',{name:'Search',exact:true}).fill(fixture('INVESTOR_EMAIL'));
	await expect(page.getByText(fixture('INVESTOR_EMAIL'),{exact:true})).toBeVisible();
	await page.getByText(fixture('INVESTOR_EMAIL'),{exact:true}).click();
	await expect(page.getByText(fixture('ADMIN_EMAIL'),{exact:false})).toBeVisible();
	const softDelete=await page.request.patch('/api/admin/users',{data:{userId:user.id,status:'DELETED'}});
	expect(softDelete.ok()).toBeTruthy();
	expect((await softDelete.json()).status).toBe('DELETED');
	expect((await page.request.get('/api/admin/users').then(response=>response.json())).some((item:{id:string})=>item.id===user.id)).toBe(false);
	expect((await page.request.get('/api/admin/users?showDeleted=true').then(response=>response.json())).some((item:{id:string;status:string})=>item.id===user.id&&item.status==='DELETED')).toBe(true);
	await page.goto('/admin/users');
	await page.getByLabel('Show deleted accounts').check();
	const deletedUserRow=page.locator('article').filter({hasText:fixture('USER_EMAIL')}).first();
	await expect(deletedUserRow.getByRole('button',{name:'Restore'})).toBeVisible();
	await deletedUserRow.getByRole('button',{name:'Restore'}).click();
	await expect.poll(async()=>db.user.findUniqueOrThrow({where:{id:user.id},select:{status:true}}).then(account=>account.status)).toBe('ACTIVE');
});

test('Nova activity is redacted and visible only to administrators',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/auth/session').then(async response=>(await response.json()).user.id as string);
	const question='What is my balance? e2e-private-question-marker';
	const novaResponse=await page.request.post('/api/support/nova',{data:{question}});
	expect(novaResponse.status()).toBe(200);
	const calculation=await page.request.post('/api/support/nova',{data:{question:'calculate position size: risk $100, entry $50, stop $45, target $60, long'}});
	expect(calculation.status()).toBe(200);
	expect(await calculation.json()).toMatchObject({answer:expect.stringContaining('20 units')});
	const forbidden=await page.request.get('/api/admin/nova-activity');
	expect(forbidden.status()).toBe(403);

	const symbol=fixture('INSTRUMENT_A');
	const beforeOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	await page.goto('/support');
	await page.getByLabel('Ask Nova AI').fill(`prepare demo order: buy 2 ${symbol}`);
	await page.getByRole('button',{name:'Send question'}).click();
	const confirmOrder=page.getByRole('button',{name:'Confirm DEMO order'});
	await expect(confirmOrder).toBeVisible();
	const previewOrders=await page.request.get('/api/orders').then(response=>response.json() as Promise<Array<{id:string}>>);
	expect(previewOrders.map(order=>order.id)).toEqual(beforeOrders.map(order=>order.id));
	await confirmOrder.click();
	await expect(page.getByText(/Your explicitly confirmed DEMO order/)).toBeVisible();
	const ordersResponse=await page.request.get('/api/orders');
	const afterOrders=await ordersResponse.json() as Array<{id:string;instrument:{symbol:string};side:string;quantity:string;status:string}>;
	const confirmation=await page.locator('.nova-message').last().innerText();
	const orderId=confirmation.match(/Order reference: ([A-Za-z0-9]+)/)?.[1];
	const confirmed=afterOrders.find(order=>order.id===orderId);
	expect(confirmed).toBeTruthy();
	expect(confirmed).toMatchObject({instrument:{symbol},side:'BUY',status:'FILLED'});
	expect(Number(confirmed?.quantity)).toBe(2);
	const unsupportedOrder=await page.request.post('/api/support/nova',{data:{question:`prepare limit order: buy 1 ${symbol} at $10`}});
	expect(unsupportedOrder.status()).toBe(200);
	expect(await unsupportedOrder.json()).toMatchObject({answer:expect.stringContaining('market-order previews only')});
	await selectAccountMode(page,'REAL');
	const realDraft=await page.request.post('/api/support/nova',{data:{question:`prepare demo order: buy 1 ${symbol}`}});
	expect(realDraft.status()).toBe(200);
	expect(await realDraft.json()).toMatchObject({answer:expect.stringContaining('REAL trading is not available through Nova')});
	await selectAccountMode(page,'DEMO');

	await logout(page);
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const report=await page.request.get('/api/admin/nova-activity');
	expect(report.status()).toBe(200);
	const events=await report.json();
	const event=events.find((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('WALLET_BALANCE_LOOKUP'));
	expect(event).toBeTruthy();
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('TRADE_PLAN_CALCULATED'))).toBe(true);
	expect(events.some((item:{userId:string;eventTypes:string[]})=>item.userId===userId&&item.eventTypes.includes('DEMO_ORDER_PREPARED'))).toBe(true);
	expect(JSON.stringify(events)).not.toContain('e2e-private-question-marker');
});

test('admin news editor previews HLS media before publishing',async({page})=>{
	const mediaUrl='https://cdn.example.test/live.m3u8';
	await page.route('https://cdn.example.test/**',route=>route.fulfill({
		status:200,
		contentType:'application/vnd.apple.mpegurl',
		headers:{'access-control-allow-origin':'*'},
		body:'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST',
	}));
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	await page.goto('/admin/news-feed');
	await expect(page.getByRole('heading',{name:'Editorial links'})).toBeVisible();
	const manifestRequest=page.waitForRequest(request=>request.url()===mediaUrl);
	await page.getByLabel('HTTPS link').fill(mediaUrl);
	await expect(page.locator('.admin-news-media-preview video')).toBeVisible();
	await manifestRequest;
});

for(const viewport of viewports){
	test(`admin routes render the desktop layout at ${viewport.width}px`,async({page})=>{
		await page.setViewportSize(viewport);
		const loginResponse=await page.goto('/admin/login');
		expect(loginResponse?.status(),'/admin/login').toBe(200);
		await expect(page.locator('h1:visible').first(),'/admin/login').toBeVisible();
		if(viewport.width>=1280)await expectNoHorizontalOverflow(page);

		await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		for(const theme of themes){
			const save=await page.request.patch('/api/theme-preference',{data:{theme}});
			expect(save.status(),'administrator theme preference').toBe(200);
			for(const route of adminRoutes){
				await test.step(`${route} in ${theme}`,async()=>{
					const path=concreteRoutePath(route);
					const currentUrl=new URL(page.url());
					const response=currentUrl.pathname===path?await page.request.get(path):await page.goto(path);
					expect(response?.status(),route).toBe(200);
					await expect(page.locator('html'),`${route} (${theme})`).toHaveAttribute('data-theme-name',theme);
					await expect(page.locator('main').first(),route).toBeVisible();
					if(await page.locator('h1:visible').count())await expect(page.locator('h1:visible').first(),route).toBeVisible();
					await expect(page.getByRole('navigation',{name:'Administrator navigation'}).getByRole('link',{name:'CRM Dashboard',exact:true}),route).toBeVisible();
					await expect(page.locator('.admin-nav-loading'),route).toHaveCount(0);
					await expect(page.locator('.admin-scope'),route).toBeVisible();
					expect(await page.locator('.admin-scope').evaluate(element=>getComputedStyle(element).minWidth),route).toBe('0px');
					if(route==='/admin'&&viewport.width===1280){
						const searchBounds=await page.locator('.admin-global-search').boundingBox();
						const metaBounds=await page.locator('.admin-topbar-meta').boundingBox();
						expect(searchBounds).not.toBeNull();
						expect(metaBounds).not.toBeNull();
						expect(searchBounds!.width).toBeGreaterThanOrEqual(180);
						expect(metaBounds!.x+metaBounds!.width).toBeLessThanOrEqual(viewport.width);
					}
					if(viewport.width<1280)await expect(page.getByRole('button',{name:'Open admin menu'}),route).toBeVisible();
					else await expect(page.getByRole('button',{name:'Open admin menu'}),route).toBeHidden();
					await expectNoHorizontalOverflow(page);
				});
			}
		}
		await page.request.patch('/api/theme-preference',{data:{theme:'forest-green'}});
		if(viewport.width<1280){
			await page.getByRole('button',{name:'Open admin menu'}).click();
			await expect(page.getByRole('button',{name:'Close admin menu'})).toBeVisible();
			await page.getByRole('button',{name:'Close admin menu'}).click();
		}
	});
}

test('admin pages require an administrator session before rendering',async({page})=>{
	const anonymousResponse=await page.request.get('/admin/cards',{maxRedirects:0});
	expect([302,307]).toContain(anonymousResponse.status());

	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const userResponse=await page.request.get('/admin/cards',{maxRedirects:0});
	expect([302,307]).toContain(userResponse.status());
});

for(const width of [375,414]){
	test(`admin navigation opens as a mobile drawer at ${width}px`,async({browser})=>{
		const context=await browser.newContext({
			baseURL:appOrigin,
			viewport:{width,height:812},
			isMobile:true,
			hasTouch:true,
		});
		try{
			const mobilePage=await context.newPage();
			await loginAs(mobilePage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
			const navigation=mobilePage.getByRole('navigation',{name:'Administrator navigation'});
			const openMenu=mobilePage.getByRole('button',{name:'Open admin menu'});
			await expect(openMenu).toBeVisible();
			await openMenu.click();
			await expect(mobilePage.getByRole('button',{name:'Close admin menu'})).toBeVisible();
			for(const group of ['Dashboards','Accounts','Operations','Services','System']){
				await expect(navigation.getByRole('region',{name:group})).toBeVisible();
			}
			expect(await mobilePage.evaluate(()=>window.innerWidth)).toBe(width);
			const layoutBounds=await mobilePage.evaluate(()=>{
				const sidebar=document.querySelector('.admin-sidebar')!.getBoundingClientRect();
				const links=[...document.querySelectorAll('#admin-navigation a')].map(link=>{
					const bounds=link.getBoundingClientRect();
					return {left:bounds.left,right:bounds.right};
				});
				return {sidebarLeft:sidebar.left,sidebarRight:sidebar.right,width:innerWidth,links};
			});
			expect(layoutBounds.sidebarLeft).toBeGreaterThanOrEqual(-1);
			expect(layoutBounds.sidebarRight).toBeLessThanOrEqual(layoutBounds.width+1);
			expect(layoutBounds.links.every(link=>link.left>=layoutBounds.sidebarLeft-1&&link.right<=layoutBounds.sidebarRight+1)).toBe(true);
			const settingsLink=navigation.getByRole('link',{name:'Settings',exact:true});
			await settingsLink.focus();
			await mobilePage.keyboard.press('Enter');
			await expect(mobilePage).toHaveURL(/\/admin\/settings$/);
			await mobilePage.goto('/admin/payments');
			await expect(mobilePage.locator('.account-table-wrap').first()).toBeVisible();
			expect(await mobilePage.locator('.account-table-wrap').first().evaluate(element=>getComputedStyle(element).overflowX)).toBe('auto');
			await expectNoHorizontalOverflow(mobilePage);
		}finally{
			await context.close();
		}
	});
}

test('DEMO order idempotency prevents duplicate fills and user history stays isolated',async({browser,page})=>{
	const demoUser=await createIsolatedDemoUser('order-idempotency');
	await loginAs(page,demoUser.email,demoUser.password);
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(startingBalance).toBe(5000);
	const symbol=fixture('INSTRUMENT_A');
	const instruments=await page.request.get('/api/market').then(response=>response.json());
	const instrument=instruments.find((item:{symbol:string})=>item.symbol===symbol);
	expect(instrument).toBeTruthy();
	const key=randomUUID();
	const payload={instrumentId:instrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(instrument.price),observedAt:instrument.lastUpdatedAt};
	const first=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	const replay=await page.request.post('/api/orders',{headers:{'Idempotency-Key':key},data:payload});
	expect(first.status()).toBe(201);
	expect(replay.status()).toBe(201);
	const firstOrder=await first.json();
	const replayOrder=await replay.json();
	expect(replayOrder.id).toBe(firstOrder.id);
	expect(replayOrder.executions).toHaveLength(1);
	const afterBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(afterBalance).toBeLessThan(startingBalance);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(afterBalance);
	expect(await page.request.get('/api/orders').then(response=>response.json()).then((orders:Array<{id:string}>)=>orders.filter(order=>order.id===firstOrder.id))).toHaveLength(1);
	let position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1);

	const updatedMarket=await page.request.get('/api/market').then(response=>response.json());
	const updatedInstrument=updatedMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const secondBuy=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:updatedInstrument.id,side:'BUY',type:'MARKET',quantity:1,expectedPrice:Number(updatedInstrument.price),observedAt:updatedInstrument.lastUpdatedAt}});
	expect(secondBuy.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(2);
	const openPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(openPortfolio.totalValue)).toBeCloseTo(Number(openPortfolio.cashBalance)+Number(openPortfolio.positionValue),2);
	expect(openPortfolio.positions).toHaveLength(1);
	expect(Number(openPortfolio.positions[0].quantity)).toBe(Number(position.quantity));
	expect(Number(openPortfolio.unrealizedPnl)).toBeCloseTo(Number(openPortfolio.positions[0].unrealizedPnl),2);

	const sellMarket=await page.request.get('/api/market').then(response=>response.json());
	const sellInstrument=sellMarket.find((item:{symbol:string})=>item.symbol===symbol);
	const partialSell=await page.request.post('/api/orders',{headers:{'Idempotency-Key':randomUUID()},data:{instrumentId:sellInstrument.id,side:'SELL',type:'MARKET',quantity:1,expectedPrice:Number(sellInstrument.price),observedAt:sellInstrument.lastUpdatedAt}});
	expect(partialSell.status()).toBe(201);
	position=(await page.request.get('/api/positions').then(response=>response.json()))[0];
	expect(Number(position.quantity)).toBe(1);
	expect(Number(position.realizedPnl)).not.toBe(0);
	const close=await page.request.post('/api/positions',{data:{positionId:position.id}});
	expect(close.ok()).toBeTruthy();
	expect(await page.request.get('/api/positions').then(response=>response.json())).toHaveLength(0);
	const closedPortfolio=await page.request.get('/api/portfolio').then(response=>response.json());
	expect(Number(closedPortfolio.positionValue)).toBe(0);
	expect(Number(closedPortfolio.realizedPnl)).not.toBe(0);

	const otherContext=await browser.newContext();
	try{
		const otherPage=await otherContext.newPage();
		await loginAs(otherPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		const otherOrders=await otherPage.request.get('/api/orders').then(response=>response.json());
		expect(otherOrders.some((order:{id:string})=>order.id===firstOrder.id)).toBe(false);
	}finally{await otherContext.close();}
});

test('DEMO deposits and withdrawals are unavailable in the wallet and rejected by the API',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const user=await page.request.get('/api/profile').then(response=>response.json());
	const walletBefore=await page.request.get('/api/wallet').then(response=>response.json());
	const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
	expect(methods).toMatchObject({btcAddress:null,fundingStatus:'DISABLED',realFundingAvailable:false,realWithdrawalAvailable:false});
	const fundingCount=await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}});
	await page.goto('/wallet?action=DEPOSIT');
	await expect(page.getByRole('status').filter({hasText:'Deposits and withdrawals are available in REAL Mode only.'})).toBeVisible();
	await expect(page.getByRole('button',{name:/Deposit|Withdrawal/})).toHaveCount(0);
	await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
	await page.goto('/dashboard');
	await expect(page.getByRole('link',{name:'Deposit'})).toHaveCount(0);
	await expect(page.getByRole('link',{name:'Request withdrawal'})).toHaveCount(0);
	await page.goto('/wallet');
	const demoWalletActions=page.locator('.wallet-quick-actions-demo');
	await expect(demoWalletActions.getByRole('link',{name:'Transactions'})).toHaveCount(0);
	await expect(demoWalletActions.getByRole('link',{name:'Practice trade'})).toBeVisible();
	await expect(demoWalletActions.getByRole('link',{name:'Activity'})).toBeVisible();
	await expect(page.getByRole('link',{name:'View activity'})).toBeVisible();
	await expect(page.getByText('Pending / reserved')).toHaveCount(0);

	const demoDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:25,currency:'USD',accountMode:'REAL'}});
	expect(demoDeposit.status()).toBe(403);
	expect((await demoDeposit.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
	const demoWithdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD',accountMode:'REAL'}});
	expect(demoWithdrawal.status()).toBe(403);
	expect((await demoWithdrawal.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
	const directRealBitcoin=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:0.001,currency:'BTC',accountMode:'REAL'}});
	expect(directRealBitcoin.status()).toBe(403);
	expect(await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}})).toBe(fundingCount);
	const walletAfter=await page.request.get('/api/wallet').then(response=>response.json());
	expect(walletAfter).toMatchObject({accountMode:'DEMO'});
	expect(Number(walletAfter.balance)).toBe(Number(walletBefore.balance));
});

test('REAL withdrawal requests reserve balance until an attested payout debits once',async({browser,page})=>{
	const isolated=await createIsolatedDemoUser('real-withdrawal');
	const user=await db.user.findUniqueOrThrow({where:{email:isolated.email}});
	await db.user.update({where:{id:user.id},data:{accountMode:'REAL',kycStatus:'APPROVED',verifiedAt:new Date(),depositEnabled:true,withdrawalEnabled:true,accountRestricted:false}});
	await db.$transaction(tx=>initializePaperAccount(tx,user.id,'REAL'));
	await db.kycProfile.create({data:{userId:user.id,legalName:'E2E REAL Withdrawal User',dob:new Date('1990-01-01'),address:'123 Test Street',idType:'PASSPORT',idNumber:`E2E-${randomUUID()}`,submittedAt:new Date()}});
	await db.kycDocument.create({data:{userId:user.id,kind:'IDENTITY_DOCUMENT',filename:'e2e-identity.pdf',storageKey:`${user.id}/${randomUUID()}.pdf`,mimeType:'application/pdf',size:128,status:'APPROVED'}});

	const adminContext=await browser.newContext();
	const reviewerContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		const reviewerPage=await reviewerContext.newPage();
		await loginAs(page,isolated.email,isolated.password);
		await selectAccountMode(page,'REAL');
		await loginAs(reviewerPage,fixture('REVIEWER_EMAIL'),fixture('REVIEWER_PASSWORD'));
		const walletBefore=await page.request.get('/api/wallet').then(response=>response.json());
		expect(walletBefore).toMatchObject({accountMode:'REAL',balance:'0',withdrawableBalance:'0'});
		const destinationResponse=await page.request.post('/api/withdrawal-destinations',{data:{
			type:'BANK_TRANSFER',nickname:'E2E test destination',countryCode:'US',bankName:'Test Bank',
			beneficiaryName:'E2E REAL Withdrawal User',accountNumber:'123456789',accountType:'CHECKING',routingNumber:'123456789',
		}});
		expect(destinationResponse.status()).toBe(201);
		const destination=await destinationResponse.json().then(body=>body.destination);
		const deposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:100,currency:'USD'}});
		expect(deposit.status()).toBe(201);
		const depositRequest=await deposit.json();
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(0);

		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const firstDepositApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:depositRequest.id,decision:'APPROVED',note:'First approval for internal test credit'}});
		expect(firstDepositApproval.status()).toBe(202);
		const depositApproval=await reviewerPage.request.patch('/api/admin/funding',{data:{id:depositRequest.id,decision:'APPROVED',note:'Independent approval for internal test credit'}});
		expect(depositApproval.status()).toBe(200);
		const fundedWallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(fundedWallet.balance)).toBe(90);

		await requestRealBalanceAdjustment(browser,adminPage,{
			userId:user.id,accountMode:'REAL',currency:'USD',amount:'30500.00',direction:'CREDIT',
			category:'ADMIN_ALLOCATION',reason:'Disposable E2E balance for withdrawal policy test',idempotencyKey:randomUUID(),
		});
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(30590);

		await loginAs(page,isolated.email,isolated.password);
		await selectAccountMode(page,'REAL');
		const withdrawalKey=randomUUID();
		const withdrawalPayload={type:'WITHDRAWAL',amount:30000,currency:'USD',withdrawalDestinationId:destination.id,destinationConfirmed:true};
		const unauthorizedSubmission=await page.request.post('/api/wallet',{
			headers:{'Idempotency-Key':withdrawalKey},
			data:withdrawalPayload,
		});
		expect(unauthorizedSubmission.status()).toBe(428);
		const reauthentication=await page.request.post('/api/security/reauth',{data:{password:isolated.password}});
		expect(reauthentication.status()).toBe(200);
		const submission=await page.request.post('/api/wallet',{
			headers:{'Idempotency-Key':withdrawalKey},
			data:withdrawalPayload,
		});
		expect(submission.status()).toBe(201);
		const request=await submission.json();
		expect(request).toMatchObject({type:'WITHDRAWAL',accountMode:'REAL',status:'PENDING_REVIEW'});
		const walletPending=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletPending.balance)).toBe(30590);
		expect(Number(walletPending.withdrawableBalance)).toBe(590);

		const withdrawalQueue=await adminPage.request.get('/api/admin/funding?type=WITHDRAWAL').then(response=>response.json());
		expect(withdrawalQueue.some((item:{id:string})=>item.id===request.id)).toBe(true);
		expect(withdrawalQueue.some((item:{type:string})=>item.type==='DEPOSIT')).toBe(false);
		await adminPage.goto('/admin/payments?type=WITHDRAWAL');
		await expect(adminPage.getByRole('heading',{name:'Withdrawal review'})).toBeVisible();
		const requestRow=adminPage.locator('.admin-funding-row').filter({hasText:user.email});
		await expect(requestRow).toBeVisible();
		await requestRow.getByRole('button',{name:'Approve · reserve funds'}).click();
		await expect(adminPage.getByRole('status').filter({hasText:'First withdrawal approval recorded'})).toBeVisible();
		const secondApproval=await reviewerPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':randomUUID()},data:{id:request.id,action:'APPROVE'}});
		expect(secondApproval.status()).toBe(200);
		const walletReserved=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletReserved.balance)).toBe(30590);
		expect(Number(walletReserved.withdrawableBalance)).toBe(590);

		const processingKey=randomUUID();
		const processing=await adminPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':processingKey},data:{id:request.id,action:'PROCESS'}});
		expect(processing.status()).toBe(200);
		const completionKey=randomUUID();
		const payout={id:request.id,action:'COMPLETE',processingReference:`E2E-${randomUUID()}`,confirmExternalProcessing:true};
		const completionInitiated=await adminPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':completionKey},data:payout});
		expect(completionInitiated.status()).toBe(202);
		expect(await db.ledgerTransaction.count({where:{reference:`FUNDING:${request.id}:EXTERNAL_WITHDRAWAL`}})).toBe(0);
		const finalCompletionKey=randomUUID();
		const completed=await reviewerPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':finalCompletionKey},data:payout});
		expect(completed.status()).toBe(200);
		const replay=await reviewerPage.request.post('/api/admin/funding/withdrawal',{headers:{'Idempotency-Key':finalCompletionKey},data:payout});
		expect(replay.status()).toBe(200);
		expect(await db.ledgerTransaction.count({where:{reference:`FUNDING:${request.id}:EXTERNAL_WITHDRAWAL`}})).toBe(1);
		const walletApproved=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(walletApproved.balance)).toBe(590);
		expect(Number(walletApproved.withdrawableBalance)).toBe(590);
	}finally{
		await reviewerContext.close();
		await adminContext.close();
	}
});

test('DEMO users cannot access configured legacy address details or receipt uploads',async({browser,page})=>{
	const address='bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const configured=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:address}});
		expect(configured.status()).toBe(200);

		await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await selectAccountMode(page,'DEMO');
		const user=await page.request.get('/api/profile').then(response=>response.json());
		const before=await page.request.get('/api/wallet').then(response=>response.json());
		const fundingCount=await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}});
		const inaccessibleRealRequest=await db.fundingRequest.create({data:{userId:user.id,type:'DEPOSIT',method:'E2E REAL funding record',amount:10,currency:'USD',accountMode:'REAL',status:'PENDING_REVIEW',idempotencyKey:randomUUID()}});
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({btcAddress:null,externalPaymentProcessing:'DISABLED',fundingStatus:'DISABLED'});
		await page.goto('/wallet?action=DEPOSIT');
		await expect(page.getByRole('status').filter({hasText:'Deposits and withdrawals are available in REAL Mode only.'})).toBeVisible();
		await expect(page.getByText(address,{exact:true})).toHaveCount(0);
		await expect(page.getByRole('img',{name:'QR code for the administrator-configured Bitcoin address'})).toHaveCount(0);
		await expect(page.locator('input[type="file"]')).toHaveCount(0);
		const realRequestDetail=await page.request.get(`/api/funding/${inaccessibleRealRequest.id}`);
		expect(realRequestDetail.status()).toBe(404);
		const uploadBody=new FormData();
		uploadBody.append('file',new Blob([PNG.sync.write(new PNG({width:1,height:1}))],{type:'image/png'}),'proof.png');
		const receiptUpload=await page.request.post(`/api/wallet/${inaccessibleRealRequest.id}/receipt`,{multipart:uploadBody});
		expect(receiptUpload.status()).toBe(403);
		expect((await receiptUpload.json()).error).toBe('Receipt management is available in REAL mode only.');
		const directDeposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:20,currency:'USD',accountMode:'REAL',simulatedBitcoinAddress:address,simulatedBitcoinAddressAcknowledged:true}));
		expect(directDeposit.status()).toBe(403);
		expect(await db.fundingRequest.count({where:{userId:user.id,accountMode:'DEMO'}})).toBe(fundingCount);
		const after=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(after.balance)).toBe(Number(before.balance));
	}finally{
		const adminPage=adminContext.pages()[0];
		if(adminPage)await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:''}}).catch(()=>undefined);
		await adminContext.close();
	}
});

test('display currency preference persists across account and activity surfaces without changing ledger cash',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const balanceBefore=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect((await page.request.get('/api/currency-preference').then(response=>response.json())).currency).toBe('USD');
	const updated=await page.request.patch('/api/currency-preference',{data:{currency:'GBP'}});
	expect(updated.ok()).toBe(true);
	expect((await updated.json()).currency).toBe('GBP');
	const unavailableRate=await page.request.get('/api/currency-rates?to=GBP');
	expect(unavailableRate.status()).toBe(503);
	expect((await unavailableRate.json()).error).toBe('A verified exchange rate is currently unavailable.');
	await page.goto('/portfolio');
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('GBP');
	await page.getByLabel('Preferred display currency').selectOption('EUR');
	await expect.poll(async()=>(await page.request.get('/api/currency-preference').then(response=>response.json())).currency).toBe('EUR');
	await page.goto('/activity');
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('EUR');
	await page.goto('/wallet/transactions');
	await page.getByRole('button',{name:'View history'}).click();
	await expect(page.getByLabel('Preferred display currency')).toHaveValue('EUR');
	const demoBalanceAfter=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	expect(demoBalanceAfter).toBe(balanceBefore);
	await selectAccountMode(page,'REAL');
	const realBalanceBefore=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	await page.goto('/wallet');
	const walletCurrency=page.getByLabel('Wallet display currency');
	await expect(walletCurrency).toHaveValue('EUR');
	await walletCurrency.selectOption('GBP');
	await expect(page.getByText('REAL GBP BALANCE')).toBeVisible();
	await expect(page.getByText('Approximate · USD ledger')).toBeVisible();
	await expect.poll(async()=>(await page.request.get('/api/currency-preference').then(response=>response.json())).currency).toBe('GBP');
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(realBalanceBefore);
});

test('wallet balance renders before auxiliary page data returns',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'REAL');
	let auxiliaryCompleted=0;
	const auxiliaryPaths=['/api/payment-methods','/api/profile','/api/currency-preference','/api/activity'];
	await page.route(url=>auxiliaryPaths.includes(url.pathname),async route=>{
		await new Promise(resolve=>setTimeout(resolve,3000));
		auxiliaryCompleted+=1;
		await route.continue();
	});
	await page.goto('/wallet');
	const balance=page.locator('.wallet-signature-card .wallet-balance-value');
	await expect(balance).not.toHaveText(/Loading|Unavailable/,{timeout:20_000});
	expect(auxiliaryCompleted).toBe(0);
});

test('administrator market tick is protected, deterministic, and idempotent',async({browser,page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	const unauthorized=await page.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':randomUUID()},data:{symbol:'BTC/USD',direction:'UP',volatilityPercent:1}});
	expect(unauthorized.status()).toBe(403);
	const btc=await db.instrument.findUniqueOrThrow({where:{symbol:'BTC/USD'},select:{id:true,price:true}});
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const idempotencyKey=randomUUID();
		const payload={symbol:'BTC/USD',direction:'UP',volatilityPercent:1};
		const tick=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(tick.status()).toBe(201);
		const first=await tick.json();
		expect(first).toMatchObject({symbol:'BTC/USD',dataMode:'SIMULATED',replayed:false});
		expect(Number(first.previousPrice)).toBeGreaterThan(0);
		expect(Number(first.price)).toBeCloseTo(Number(first.previousPrice)*1.01,8);
		const replay=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect(await replay.json()).toMatchObject({price:first.price,replayed:true});
		const conflict=await adminPage.request.post('/api/admin/market/tick',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,direction:'DOWN'}});
		expect(conflict.status()).toBe(409);
		expect(await db.auditLog.count({where:{action:'SIMULATED_MARKET_TICK',entityId:btc.id}})).toBe(1);
	}finally{await adminContext.close();}
});

test('REAL internal deposit request remains uncredited until administrator approval',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const reviewerContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		const reviewerPage=await reviewerContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(reviewerPage,fixture('REVIEWER_EMAIL'),fixture('REVIEWER_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const before=await page.request.get('/api/wallet').then(response=>response.json());
		await page.goto('/wallet?action=DEPOSIT');
		await expect(page.getByText(/internal REAL ledger credit request/i)).toBeVisible();
		await expect(page.getByRole('heading',{name:'Administrator Review'})).toBeVisible();
		await expect(page.getByText(/no external payment is processed/i)).toBeVisible();
		await expect(page.getByLabel('Bitcoin address')).toHaveCount(0);
		await expect(page.getByRole('img',{name:/Bitcoin address/})).toHaveCount(0);
		await page.getByLabel('Amount',{exact:true}).fill('20.00');
		await page.getByLabel('Request reference (optional)').fill(`E2E-${randomUUID()}`);
		await page.getByRole('button',{name:'Submit internal credit request'}).click();
		await expect(page.getByRole('heading',{name:'Confirm deposit request'})).toBeVisible();
		await expect(page.getByText(/This is an internal ledger request only; no external payment occurs/)).toBeVisible();
		await page.getByRole('button',{name:'Confirm request'}).click();
		await expect(page.getByText(/The ledger has not been posted/)).toBeVisible();
		const after=await page.request.get('/api/wallet').then(response=>response.json());
		const request=after.transactions[0];
		expect(request).toMatchObject({type:'DEPOSIT',status:'PENDING_REVIEW',currency:'USD',amount:'20',hasReceipt:false});
		expect(Number(after.balance)).toBe(Number(before.balance));
		expect(Number(after.withdrawableBalance)).toBe(Number(before.withdrawableBalance));
		const approvalRequest=await adminPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'First approval for internal ledger credit'}});
		expect(approvalRequest.status()).toBe(202);
		expect(await approvalRequest.json()).toMatchObject({approvalRequired:true,status:'PENDING_REVIEW'});
		const unchanged=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(unchanged.balance)).toBe(Number(before.balance));
		const approval=await reviewerPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'Independent approval for internal ledger credit'}});
		expect(approval.status()).toBe(200);
		expect(Number((await approval.json()).creditedAmount)).toBe(18);
		expect(Number((await approval.json()).feeAmount)).toBe(2);
		const credited=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(credited.balance)).toBe(Number(before.balance)+18);
		expect(credited.transactions.find((item:{id:string})=>item.id===request.id)).toMatchObject({status:'APPROVED',amount:'20',creditedAmount:'18',feeAmount:'2',accountMode:'REAL'});
	}finally{
		await reviewerContext.close();
		await adminContext.close();
	}
});

test('REAL internal transaction detail preserves pending review status',async({page})=>{
	await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
	await selectAccountMode(page,'REAL');
	const response=await page.goto(`/wallet/transactions/${fixture('REAL_DETAIL_ID')}`);
	expect(response?.status()).toBe(200);
	await expect(page.getByRole('heading',{name:'Deposit request',exact:true})).toBeVisible();
	await expect(page.getByText(/No payment processor, broker, bank, or cryptocurrency network is contacted/i)).toBeVisible();
	await expect(page.getByText(/This request awaits administrator review/i)).toBeVisible();
	await expect(page.getByText(/User-submitted information for administrator review; not independently verified/i)).toBeVisible();
});

test('external payment methods cannot be configured or exposed to users',async({browser,page})=>{
	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const created=await adminPage.request.post('/api/admin/payment-methods',{data:{name:`E2E Bitcoin ${randomUUID()}`,enabled:true,demoOnly:false,depositEnabled:true,withdrawalEnabled:false,requiresNetwork:true,currencies:['BTC'],destination:'bc1qexampleaddress',instructions:'Use the Bitcoin network.',minimumAmount:0,maximumAmount:null,processingNotes:null,displayOrder:999}});
		expect(created.status()).toBe(409);
		expect((await created.json()).error).toContain('External payment processing is disabled');
		expect(await adminPage.request.get('/api/admin/payment-methods').then(response=>response.json())).toEqual([]);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		await page.goto('/wallet?action=DEPOSIT');
		const methods=await page.request.get('/api/payment-methods').then(response=>response.json());
		expect(methods).toMatchObject({methods:[],externalPaymentProcessing:'DISABLED'});
		await expect(page.getByLabel('Request reference (optional)')).toBeVisible();
		await expect(page.getByLabel('Optional supporting attachment')).toBeVisible();
		await expect(page.getByLabel('Bitcoin transaction reference')).toHaveCount(0);
		await expect(page.getByText(/no external payment is processed/i)).toBeVisible();
	}finally{await adminContext.close();}
});

test('DEMO funding stays disabled regardless of user deposit and withdrawal permissions',async({browser,page})=>{
	const fundingUser=await createIsolatedDemoUser('funding-permissions');
	const adminContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const priorBitcoinAddress=await db.systemSetting.findUnique({where:{key:SIMULATED_BTC_ADDRESS_SETTING},select:{value:true}});
	const bitcoinAddress='bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
	try{
		await loginAs(page,fundingUser.email,fundingUser.password);
		const userProfile=await page.request.get('/api/profile').then(response=>response.json());
		const methods=await page.request.get('/api/payment-methods').then(async response=>(await response.json()).methods);
		expect(methods).toHaveLength(0);
		const startingWallet=await page.request.get('/api/wallet').then(response=>response.json());
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const configured=await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:bitcoinAddress}});
		expect(configured.status()).toBe(200);
		const disabled=await adminPage.request.patch('/api/admin/users',{data:{userId:userProfile.id,depositEnabled:false,withdrawalEnabled:false}});
		expect(disabled.ok()).toBeTruthy();
		expect(await disabled.json()).toMatchObject({depositEnabled:false,withdrawalEnabled:false});
		const accessPanel=adminPage.getByRole('heading',{name:'User deposit and withdrawal access'});
		await adminPage.goto('/admin/kyc');
		await expect(accessPanel).toBeVisible();
		await expect(adminPage.getByRole('button',{name:`Enable deposits for ${userProfile.email}`})).toBeVisible();
		const blockedDeposit=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'DEPOSIT',amount:25,currency:'USD'}});
		expect(blockedDeposit.status()).toBe(403);
		expect((await blockedDeposit.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
		const blockedWithdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD'}});
		expect(blockedWithdrawal.status()).toBe(403);
		expect((await blockedWithdrawal.json()).error).toBe('Deposits and withdrawals are available in REAL Mode only.');
		const enabled=await adminPage.request.patch('/api/admin/users',{data:{userId:userProfile.id,depositEnabled:true,withdrawalEnabled:true}});
		expect(enabled.ok()).toBeTruthy();
		const deposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:25,currency:'USD',simulatedBitcoinAddress:bitcoinAddress,simulatedBitcoinAddressAcknowledged:true}));
		const withdrawal=await page.request.post('/api/wallet',{headers:{'Idempotency-Key':randomUUID()},data:{type:'WITHDRAWAL',amount:10,currency:'USD'}});
		expect(deposit.status()).toBe(403);
		expect(withdrawal.status()).toBe(403);
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(startingWallet.balance));
		expect((await page.request.get('/api/wallet').then(response=>response.json())).transactions).toHaveLength(startingWallet.transactions.length);
		expect(await db.fundingRequest.count({where:{userId:userProfile.id,accountMode:'DEMO'}})).toBe(startingWallet.transactions.length);
		const legacyDemoRequest=await db.fundingRequest.create({data:{userId:userProfile.id,type:'DEPOSIT',method:'Legacy DEMO funding request',amount:25,currency:'USD',accountMode:'DEMO',status:'PENDING_REVIEW',idempotencyKey:randomUUID()}});
		const legacyApproval=await adminPage.request.patch('/api/admin/funding',{data:{id:legacyDemoRequest.id,decision:'APPROVED'}});
		expect(legacyApproval.status()).toBe(409);
		expect((await legacyApproval.json()).error).toContain('REAL Mode only');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${legacyDemoRequest.id}:APPROVED`}})).toBeNull();
		const legacyRejection=await adminPage.request.patch('/api/admin/funding',{data:{id:legacyDemoRequest.id,decision:'REJECTED'}});
		expect(legacyRejection.status()).toBe(200);
		expect((await legacyRejection.json()).status).toBe('REJECTED');
		const legacyWithdrawal=await db.fundingRequest.create({data:{userId:userProfile.id,type:'WITHDRAWAL',method:'Legacy DEMO withdrawal',amount:10,currency:'USD',accountMode:'DEMO',status:'APPROVED',idempotencyKey:randomUUID()}});
		const settlement=await adminPage.request.post('/api/admin/funding/settle',{headers:{'Idempotency-Key':randomUUID()},data:{id:legacyWithdrawal.id,note:'Reject legacy simulated payout'}});
		expect(settlement.status()).toBe(409);
		expect((await settlement.json()).error).toContain('DEMO withdrawals are disabled');
		expect(await db.ledgerTransaction.findUnique({where:{reference:`FUNDING:${legacyWithdrawal.id}:SETTLED`}})).toBeNull();
		expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(Number(startingWallet.balance));
	}finally{
		if(!adminPage.isClosed())await adminPage.request.put('/api/admin/settings',{data:{key:SIMULATED_BTC_ADDRESS_SETTING,value:priorBitcoinAddress?.value||''}}).catch(()=>undefined);
		await adminContext.close();
	}
});

test('approved internal deposit receipts show gross amount, deducted fee, net credit, and reviewer audit',async({browser,page})=>{
	const adminContext=await browser.newContext();
	const reviewerContext=await browser.newContext();
	const adminPage=await adminContext.newPage();
	const reviewerPage=await reviewerContext.newPage();
	try{
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		await loginAs(reviewerPage,fixture('REVIEWER_EMAIL'),fixture('REVIEWER_PASSWORD'));
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
		const deposit=await page.request.post('/api/wallet',depositPostOptions(randomUUID(),{type:'DEPOSIT',amount:100,currency:'USD',transactionReference:`E2E-${randomUUID()}`}));
		expect(deposit.status()).toBe(201);
		const request=await deposit.json();
		await logout(page);
		const initiated=await adminPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'First approval for internal ledger credit'}});
		expect(initiated.status()).toBe(202);
		const approval=await reviewerPage.request.patch('/api/admin/funding',{data:{id:request.id,decision:'APPROVED',note:'Approved internal ledger credit'}});
		expect(approval.status()).toBe(200);
		expect(Number((await approval.json()).creditedAmount)).toBe(90);
		expect(Number((await approval.json()).feeAmount)).toBe(10);
		await loginAs(page,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(page,'REAL');
		const wallet=await page.request.get('/api/wallet').then(response=>response.json());
		expect(Number(wallet.balance)).toBeCloseTo(startingBalance+90,2);
		const transaction=wallet.transactions.find((item:{id:string})=>item.id===request.id);
		expect(transaction).toMatchObject({status:'APPROVED',amount:'100',creditedAmount:'90',feeAmount:'10',reviewedBy:{email:fixture('REVIEWER_EMAIL')}});
		expect(transaction.reviewedAt).toBeTruthy();
		await page.goto('/wallet/transactions');
		await page.getByRole('button',{name:'View history'}).click();
		const transactionRow=page.locator('.transaction-history-row').filter({hasText:request.id});
		await expect(transactionRow).toContainText('Approved');
		await expect(transactionRow).not.toContainText('Pending');
		await page.goto('/wallet');
		await page.locator('.wallet-ledger-records > summary').click();
		const receiptDetails=page.locator('.wallet-receipt-list > details').filter({hasText:request.id}).first();
		await receiptDetails.locator('summary').click();
		await expect(receiptDetails.getByText('$100.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByText('$10.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByText('$90.00',{exact:true}).first()).toBeVisible();
		await expect(receiptDetails.getByRole('heading',{name:'Transaction Details'})).toBeVisible();
		await expect(receiptDetails.getByText(fixture('ADMIN_EMAIL'),{exact:true})).toHaveCount(0);
		const downloadPromise=page.waitForEvent('download');
		await receiptDetails.getByRole('button',{name:'Download PDF'}).click();
		expect((await downloadPromise).suggestedFilename()).toContain('approved');
		await page.goto('/wallet?action=DEPOSIT');
		const fundingReceipts=page.locator('.wallet-funding-receipts');
		await expect(fundingReceipts).toBeVisible();
		await expect(fundingReceipts).not.toHaveAttribute('open','');
		await expect(fundingReceipts.locator('.wallet-receipt-list')).toBeHidden();
		await fundingReceipts.locator(':scope > summary').click();
		await expect(fundingReceipts).toHaveAttribute('open','');
		await expect(fundingReceipts.locator('.wallet-receipt-list')).toBeVisible();
	}finally{await Promise.all([adminContext.close(),reviewerContext.close()]);}
});

test('DEMO investment submissions are denied without moving funds',async({page})=>{
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await selectAccountMode(page,'DEMO');
	const userId=await page.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
	const startingBalance=Number((await page.request.get('/api/wallet').then(response=>response.json())).balance);
	const requestResponse=await page.request.post('/api/investments',{headers:{'Idempotency-Key':randomUUID()},data:{opportunityId:'not-a-demo-opportunity',amount:500}});
	expect(requestResponse.status()).toBe(403);
	expect(Number((await page.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(startingBalance);
	expect(await db.investmentRequest.count({where:{userId,accountMode:'DEMO',opportunityId:'not-a-demo-opportunity'}})).toBe(0);
});

test('KYC access is owner-scoped and unavailable signed Storage access fails closed',async({browser,page})=>{
	const documentId=fixture('KYC_DOCUMENT_ID');
	const pendingUser=await createIsolatedDemoUser('kyc-access');
	await loginAs(page,pendingUser.email,pendingUser.password);
	expect((await page.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(403);
	expect((await page.request.get(`/api/admin/kyc/documents/${documentId}`)).status()).toBe(403);

	const unauthenticatedContext=await browser.newContext();
	try{
		const unauthenticatedPage=await unauthenticatedContext.newPage();
		expect((await unauthenticatedPage.request.get(`/api/kyc/documents/${documentId}`)).status()).toBe(401);
	}finally{await unauthenticatedContext.close();}

	const investorContext=await browser.newContext();
	try{
		const investorPage=await investorContext.newPage();
		await loginAs(investorPage,fixture('INVESTOR_EMAIL'),fixture('INVESTOR_PASSWORD'));
		await selectAccountMode(investorPage,'REAL');
		const documents=await investorPage.request.get('/api/kyc/documents').then(response=>response.json());
		expect(documents.map((document:{id:string})=>document.id)).toContain(documentId);
		const ownerAccess=await investorPage.request.get(`/api/kyc/documents/${documentId}`);
		expect(ownerAccess.status()).toBe(502);
		expect((await ownerAccess.json()).error).toBeTruthy();

		const approvedUpload=await investorPage.request.post('/api/kyc/documents',{multipart:{
			kind:'IDENTITY_DOCUMENT',
			file:{name:'approved-e2e.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nApproved account upload must be blocked\\n%%EOF\\n')},
		}});
		expect(approvedUpload.status()).toBe(410);
		expect((await investorPage.request.get('/api/kyc/documents').then(response=>response.json()))).toHaveLength(documents.length);
	}finally{await investorContext.close();}
	const pendingUserRecord=await db.user.findUniqueOrThrow({where:{email:pendingUser.email},select:{id:true}});
	await db.$transaction(async tx=>{
		await tx.user.update({where:{id:pendingUserRecord.id},data:{accountMode:'REAL',approvedTier:2,kycStatus:'APPROVED',phoneVerified:true,verifiedAt:new Date()}});
		await tx.kycProfile.upsert({where:{userId:pendingUserRecord.id},update:{address:'123 E2E Proof Street'},create:{userId:pendingUserRecord.id,address:'123 E2E Proof Street'}});
	});
	const pendingDocuments=await page.request.get('/api/kyc/documents').then(response=>response.json());
	const upload=await page.request.post('/api/kyc/documents',{multipart:{
		kind:'PROOF_OF_ADDRESS',
		file:{name:'temporary-proof-of-address.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\\nDisposable E2E proof of address\\n%%EOF\\n')},
	}});
	expect(upload.status()).toBe(201);
	expect((await page.request.get('/api/kyc/documents').then(response=>response.json()))).toHaveLength(pendingDocuments.length+1);

	const adminContext=await browser.newContext();
	try{
		const adminPage=await adminContext.newPage();
		await loginAs(adminPage,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
		const adminAccess=await adminPage.request.get(`/api/admin/kyc/documents/${documentId}`);
		expect(adminAccess.status()).toBe(502);
		expect((await adminAccess.json()).error).toBeTruthy();
	}finally{await adminContext.close();}
});

test('profile settings persist for the owner and remain inaccessible to signed-out clients',async({browser,page})=>{
	const settingsUser=await createIsolatedDemoUser('profile-settings');
	await db.user.update({where:{email:settingsUser.email},data:{name:null,country:null}});
	await loginAs(page,settingsUser.email,settingsUser.password);
	const initialProfile=await page.request.get('/api/profile').then(response=>response.json());
	expect(initialProfile).toMatchObject({twoFactorEnabled:false,twoFactorAvailable:true});
	await page.goto('/settings#profile');
	await expect(page.getByText('Complete your profile',{exact:true})).toBeVisible();
	await page.getByLabel('First name').fill('Complete');
	await page.getByLabel('Last name').fill('Profile');
	await page.locator('#profile-country').fill('Test Country');
	await page.getByRole('button',{name:'Save profile'}).click();
	await expect(page.getByText('Profile complete',{exact:true})).toBeVisible();
	const updated=await page.request.patch('/api/profile',{data:{name:'Temporary Settings Update',country:'Test Country',address:'Isolated test address',twoFactorEnabled:true}});
	expect(updated.ok()).toBeTruthy();
	expect(await page.request.get('/api/profile').then(response=>response.json())).toMatchObject({name:'Temporary Settings Update',twoFactorEnabled:false,twoFactorAvailable:true});
	const unverifiedPhoneChange=await page.request.patch('/api/profile',{data:{firstName:'Temporary',lastName:'Settings Update',phone:'+2348031234567'}});
	expect(unverifiedPhoneChange.status()).toBe(409);
	expect((await page.request.get('/api/settings/contact-verification')).status()).toBe(200);
	await page.setViewportSize({width:320,height:800});
	await page.goto('/settings#profile');
	await expect(page.locator('input[autocomplete="tel"]')).toHaveAttribute('readonly','');
	await expectNoHorizontalOverflow(page);
	await page.setViewportSize({width:1440,height:900});
	await page.goto('/settings');
	await page.getByRole('tab',{name:'Security'}).click();
	await expect(page.getByRole('heading',{name:'Financial Account Security Center'})).toBeVisible();
	await expect(page.getByRole('button',{name:'Enable two-factor authentication'})).toBeVisible();
	const signedOutContext=await browser.newContext();
	try{
		const signedOutPage=await signedOutContext.newPage();
		expect((await signedOutPage.request.get('/api/profile')).status()).toBe(401);
	}finally{await signedOutContext.close();}
});

test('authentication session cookies are protected and sign-in requires a CSRF token',async({browser,page})=>{
	const user=await createIsolatedDemoUser('auth-cookie-security');
	await loginAs(page,user.email,user.password);
	const sessionCookie=(await page.context().cookies()).find(cookie=>cookie.name.endsWith('session-token'));
	expect(sessionCookie).toMatchObject({httpOnly:true,sameSite:'Lax',path:'/'});

	const unauthenticatedContext=await browser.newContext();
	try{
		const response=await unauthenticatedContext.request.post('/api/auth/signin/credentials',{
			data:{username:user.email,password:user.password},
			maxRedirects:0,
		});
		expect(response.status()).toBe(302);
		expect(response.headers().location).toContain('csrf=true');
		expect(await (await unauthenticatedContext.request.get('/api/auth/session')).json()).not.toHaveProperty('user');
	}finally{await unauthenticatedContext.close();}
});

test('password changes require fresh credentials and revoke other sessions',async({browser,page})=>{
	const user=await createIsolatedDemoUser('security-password');
	await loginAs(page,user.email,user.password);
	const otherContext=await browser.newContext();
	const nextContext=await browser.newContext();
	try{
		const otherDevice=await otherContext.newPage();
		await loginAs(otherDevice,user.email,user.password);
		const sessions=await page.request.get('/api/security/sessions').then(response=>response.json());
		expect(sessions.sessions).toHaveLength(2);
		const otherSession=sessions.sessions.find((item:{current:boolean})=>!item.current);
		expect(otherSession).toBeTruthy();
		const revoke=await page.request.post('/api/security/sessions',{data:{action:'revoke-session',sessionId:otherSession.id,password:user.password}});
		expect(revoke.status()).toBe(200);
		await expect.poll(async()=> (await otherDevice.request.get('/api/dashboard')).status()).toBe(401);

		const nextDevice=await nextContext.newPage();
		await loginAs(nextDevice,user.email,user.password);
		const weak=await page.request.post('/api/security/password',{data:{currentPassword:user.password,newPassword:'weak',confirmPassword:'weak'}});
		expect(weak.status()).toBe(400);
		const mismatch=await page.request.post('/api/security/password',{data:{currentPassword:user.password,newPassword:'NewStrongPassword42',confirmPassword:'DifferentPassword42'}});
		expect(mismatch.status()).toBe(400);
		const incorrect=await page.request.post('/api/security/password',{data:{currentPassword:'IncorrectPassword1',newPassword:'NewStrongPassword42',confirmPassword:'NewStrongPassword42'}});
		expect(incorrect.status()).toBe(401);

		await page.setViewportSize({width:390,height:844});
		await page.goto('/settings#security');
		await expectNoHorizontalOverflow(page);
		await page.getByRole('button',{name:'Change password'}).click();
		const changeForm=page.locator('.security-center-form').first();
		await changeForm.getByLabel('Current password').fill(user.password);
		await changeForm.getByLabel('New password',{exact:true}).fill('NewStrongPassword42');
		await changeForm.getByLabel('Confirm new password',{exact:true}).fill('NewStrongPassword42');
		await changeForm.getByRole('button',{name:'Update password'}).click();
		await expect(page.getByRole('status').filter({hasText:'Password changed'})).toBeVisible();
		await expectNoHorizontalOverflow(page);
		expect((await page.request.get('/api/dashboard')).status()).toBe(200);
		await expect.poll(async()=> (await nextDevice.request.get('/api/dashboard')).status()).toBe(401);

		await loginAs(nextDevice,user.email,'NewStrongPassword42');
		expect((await nextDevice.request.get('/api/dashboard')).status()).toBe(200);
	}finally{
		await otherContext.close();
		await nextContext.close();
	}
});

test('TOTP enrollment and recovery-code rotation support the disable flow',async({browser,page})=>{
	test.setTimeout(120_000);
	const user=await createIsolatedDemoUser('security-totp');
	await loginAs(page,user.email,user.password);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/settings');
	await waitForStartup(page);
	await page.getByRole('link',{name:/^Security Password, two-factor authentication, and active sessions$/}).click();
	await expect(page.getByRole('heading',{name:'Financial Account Security Center'})).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await page.getByRole('button',{name:'Enable two-factor authentication'}).click();
	const enrollmentForm=page.locator('.security-center-form').first();
	await enrollmentForm.getByLabel('Current password').fill(user.password);
	const startResponsePromise=page.waitForResponse(response=>response.url().endsWith('/api/security/totp')&&response.request().method()==='POST');
	await enrollmentForm.getByRole('button',{name:'Continue enrollment'}).click();
	const startResponse=await startResponsePromise;
	expect(startResponse.status()).toBe(200);
	const enrollment=await startResponse.json();
	expect(enrollment.qrCode).toMatch(/^data:image\/png;base64,/);
	expect(enrollment.manualKey).toBeTruthy();
	await expect(enrollmentForm.getByAltText('Scan this QR code with your authenticator application')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	expect((await page.request.get('/api/profile').then(response=>response.json())).twoFactorEnabled).toBe(false);
	expect(JSON.stringify(await page.request.get('/api/profile').then(response=>response.json()))).not.toContain(enrollment.manualKey);

	const enrollmentStep=Math.floor(Date.now()/30_000);
	const validEnrollmentCode=await generate({secret:enrollment.manualKey});
	let invalidEnrollmentCode=await generate({secret:generateSecret()});
	if(invalidEnrollmentCode===validEnrollmentCode)invalidEnrollmentCode=`${(Number(invalidEnrollmentCode)+1)%1_000_000}`.padStart(6,'0');
	const enrollmentCodeInput=enrollmentForm.getByLabel('Authenticator verification code');
	await enrollmentCodeInput.fill(invalidEnrollmentCode);
	const invalidResponsePromise=page.waitForResponse(response=>response.url().endsWith('/api/security/totp')&&response.request().method()==='POST');
	await enrollmentForm.getByRole('button',{name:'Verify and enable'}).click();
	const invalidConfirmation=await invalidResponsePromise;
	expect(invalidConfirmation.status()).toBe(400);
	await expect(page.getByRole('alert').filter({hasText:'not valid'})).toBeVisible();
	expect((await page.request.get('/api/profile').then(response=>response.json())).twoFactorEnabled).toBe(false);

	await enrollmentCodeInput.fill(await generate({secret:enrollment.manualKey}));
	const confirmationResponsePromise=page.waitForResponse(response=>response.url().endsWith('/api/security/totp')&&response.request().method()==='POST');
	await enrollmentForm.getByRole('button',{name:'Verify and enable'}).click();
	const confirmationResponse=await confirmationResponsePromise;
	expect(confirmationResponse.status()).toBe(200);
	const confirmation=await confirmationResponse.json();
	const recoveryCodes=confirmation.recoveryCodes as string[];
	expect(recoveryCodes).toHaveLength(10);
	expect(new Set(recoveryCodes).size).toBe(10);
	await expect(page.locator('.security-recovery-codes li code')).toHaveCount(10);
	await expectNoHorizontalOverflow(page);
	expect((await page.request.get('/api/profile').then(response=>response.json())).twoFactorEnabled).toBe(true);
	await page.getByRole('button',{name:'I’ve saved my recovery codes'}).click();

	const newDeviceContext=await browser.newContext();
	try{
		const newDevicePage=await newDeviceContext.newPage();
		await loginAs(newDevicePage,user.email,user.password);
		await expect(newDevicePage).toHaveURL(/\/dashboard/);
		await expect(newDevicePage.locator('input[name="secondFactorCode"]')).toHaveCount(0);
		await expect.poll(()=>Math.floor(Date.now()/30_000),{timeout:35_000}).not.toBe(enrollmentStep);
		const regenerateCode=await generate({secret:enrollment.manualKey});
		const regenerate=await newDevicePage.request.post('/api/security/totp',{data:{
			action:'regenerate',password:user.password,secondFactorCode:regenerateCode,
		}});
		expect(regenerate.status()).toBe(200);
		const regeneratedCodes=(await regenerate.json()).recoveryCodes as string[];
		expect(regeneratedCodes).toHaveLength(10);
		expect(new Set(regeneratedCodes).size).toBe(10);

		const disable=await newDevicePage.request.post('/api/security/totp',{data:{action:'disable',password:user.password}});
		expect(disable.status()).toBe(200);
		expect(await newDevicePage.request.get('/api/profile').then(response=>response.json())).toMatchObject({twoFactorEnabled:false});
		await expect.poll(async()=> (await page.request.get('/api/dashboard')).status()).toBe(401);
	}finally{
		await newDeviceContext.close();
	}
});

test('browser notification settings explain denied permission without prompting again',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('push-denied');
	await page.context().grantPermissions([],{origin:appOrigin});
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/settings');
	await page.getByRole('link',{name:/Preferences/}).click();
	await waitForStartup(page);
	await expect(page.getByRole('heading',{name:'Appearance'})).toBeVisible();
	await page.getByRole('button',{name:'Premium Dashboard'}).last().click();
	await expect(page.locator('html')).toHaveAttribute('data-theme-name','premium-dashboard');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(247, 248, 245)');
	await expect(page.getByRole('button',{name:'Forest Green'})).toHaveCount(1);
	await page.getByRole('button',{name:'Forest Green'}).last().click();
	await expect(page.locator('html')).toHaveAttribute('data-theme-name','forest-green');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(7, 17, 13)');
	await expect(page.getByRole('heading',{name:'Browser notifications'})).toBeVisible();
	await expect(page.getByText('Permission: Blocked')).toBeVisible();
	await expect(page.getByText(/Aurevia cannot prompt again/)).toBeVisible();
	await expect(page.getByRole('button',{name:'Enable notifications'})).toBeDisabled();
	await expectNoHorizontalOverflow(page);
});

test('iOS browser tabs receive Home Screen Web Push installation guidance',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('push-ios-tab');
	await page.addInitScript(()=>{
		Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
	});
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.goto('/settings#preferences');
	await waitForStartup(page);
	await expect(page.getByText(/Web Push is available only after Aurevia is added to the Home Screen/)).toBeVisible();
	await expect(page.getByText(/Share.*Add to Home Screen/)).toBeVisible();
	await expect(page.getByRole('button',{name:'Enable notifications'})).toBeDisabled();
});

test('installed iOS Home Screen apps are distinguished from browser tabs',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('push-ios-installed');
	await page.addInitScript(()=>{
		Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'});
		Object.defineProperty(navigator,'standalone',{configurable:true,value:true});
	});
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.goto('/settings#preferences');
	await waitForStartup(page);
	await expect(page.getByText('Installed app')).toBeVisible();
	await expect(page.getByText(/Web Push is available only after Aurevia is added to the Home Screen/)).toHaveCount(0);
});

test('browser notification settings report service worker registration failures',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('push-worker-failure');
	await page.addInitScript(()=>{
		let registrations=0;
		Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:()=>{
			registrations++;
			return registrations===1?Promise.resolve({}):Promise.reject(new Error('registration blocked'));
		}}});
	});
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.goto('/settings#preferences');
	await waitForStartup(page);
	await expect(page.getByRole('alert').filter({hasText:'could not register its background notification worker'})).toBeVisible();
});

test('theme preferences are account-isolated and load on a second device',async({browser})=>{
	const accountA=await createIsolatedDemoUser('theme-account-a');
	const accountB=await createIsolatedDemoUser('theme-account-b');
	const firstDevice=await browser.newContext();
	const secondDevice=await browser.newContext();
	try{
		const firstPage=await firstDevice.newPage();
		await loginAs(firstPage,accountA.email,accountA.password);
		const saved=await firstPage.request.patch('/api/theme-preference',{data:{theme:'premium-dashboard'}});
		expect(saved.status()).toBe(200);
		expect(await saved.json()).toMatchObject({theme:'premium-dashboard'});

		const secondPage=await secondDevice.newPage();
		await loginAs(secondPage,accountA.email,accountA.password);
		await secondPage.goto('/about-me');
		await expect(secondPage.locator('html')).toHaveAttribute('data-theme-name','premium-dashboard');
		expect(await secondPage.request.get('/api/theme-preference').then(response=>response.json())).toMatchObject({theme:'premium-dashboard'});

		await logout(secondPage);
		await loginAs(secondPage,accountB.email,accountB.password);
		await secondPage.goto('/about-me');
		await expect(secondPage.locator('html')).toHaveAttribute('data-theme-name','forest-green');
		expect(await secondPage.request.get('/api/theme-preference').then(response=>response.json())).toMatchObject({theme:'forest-green'});
	}finally{
		await firstDevice.close();
		await secondDevice.close();
	}
});

test('notification sound preferences stay device-local, previewable, and persistent across tabs',async({page})=>{
	const settingsUser=await createIsolatedDemoUser('notification-sounds');
	await loginAs(page,settingsUser.email,settingsUser.password);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/settings#preferences');
	await waitForStartup(page);
	const master=page.getByRole('checkbox',{name:/Enable notification sounds/});
	await expect(master).not.toBeChecked();
	await master.check();
	const session=await page.request.get('/api/auth/session').then(response=>response.json());
	const settingsKey=`aurevia.notification-sounds.v1.${encodeURIComponent(session.user.id)}`;
	await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'null')?.enabled,settingsKey)).toBe(true);
	await page.getByRole('button',{name:'Preview Order filled sound'}).click();
	await expect(page.getByRole('status').filter({hasText:'Order filled preview played.'})).toBeVisible();
	const secondTab=await page.context().newPage();
	try{
		await secondTab.goto('/settings#preferences');
		await waitForStartup(secondTab);
		await expect(secondTab.getByRole('checkbox',{name:/Enable notification sounds/})).toBeChecked();
		await expect(secondTab.locator('.notification-sound-category-list')).toBeVisible();
		await page.getByRole('button',{name:'Restore defaults'}).click();
		await expect(master).not.toBeChecked();
		await expect.poll(()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'null')?.volume,settingsKey)).toBe(0.45);
	}finally{await secondTab.close()}
	await expectNoHorizontalOverflow(page);
});

test('account deletion preserves ledger history and permits fresh registration without Akedly',async({page})=>{
	const userId=fixture('DELETE_USER_ID');
	const email=fixture('DELETE_EMAIL');
	const password=fixture('DELETE_PASSWORD');
	await loginAs(page,email,password);
	const demoAccount=await db.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${userId}:DEMO:USD`}});
	const openingCapital=await db.ledgerAccount.findUniqueOrThrow({where:{code:'SYSTEM:DEMO:INITIAL_CAPITAL'}});
	const currentDemoBalance=await ledgerBalance(db,demoAccount.id);
	if(currentDemoBalance.gt(0)){
		await db.$transaction(tx=>postDoubleEntry(tx,{
			reference:`E2E:DELETE:${userId}:ZERO`,
			description:'Disposable E2E balance closure',
			debitAccountId:demoAccount.id,
			creditAccountId:openingCapital.id,
			amount:currentDemoBalance,
		}));
	}
	const ledgerAccountIds=(await db.ledgerAccount.findMany({where:{userId},select:{id:true}})).map(account=>account.id);
	const ledgerBefore=await db.ledgerEntry.findMany({where:{accountId:{in:ledgerAccountIds}},select:{type:true,amount:true}});
	const balanceBefore=ledgerBefore.reduce((balance,entry)=>balance+(entry.type==='CREDIT'?1:-1)*Number(entry.amount),0);

	const invalidPassword=await page.request.post('/api/account/delete',{data:{password:'Incorrect-password-99',confirmation:'DELETE'}});
	expect(invalidPassword.status()).toBe(403);
	const rejectedConfirmation=await page.request.post('/api/account/delete',{data:{password,confirmation:'DELETE ACCOUNT'}});
	expect(rejectedConfirmation.status()).toBe(400);
	expect((await db.user.findUniqueOrThrow({where:{id:userId}})).status).toBe('ACTIVE');

	const deleted=await page.request.post('/api/account/delete',{data:{password,confirmation:'DELETE'}});
	const deletionResult=await deleted.json();
	expect(deleted.status(),JSON.stringify(deletionResult)).toBe(200);
	await page.goto('/login');
	const closedUser=await db.user.findUniqueOrThrow({where:{id:userId},select:{status:true,email:true}});
	expect(closedUser.status).toBe('CLOSED');
	expect(closedUser.email).not.toBe(email);
	expect(await db.kycProfile.findUnique({where:{userId}})).not.toBeNull();
	const retainedAccounts=await db.ledgerAccount.findMany({where:{id:{in:ledgerAccountIds}},select:{userId:true,code:true}});
	expect(retainedAccounts).toHaveLength(ledgerAccountIds.length);
	expect(retainedAccounts.every(account=>account.userId===userId&&account.code.includes(userId))).toBe(true);
	expect(await page.request.get('/api/profile').then(response=>response.status())).toBe(401);
	const ledgerAfter=await db.ledgerEntry.findMany({where:{accountId:{in:ledgerAccountIds}},select:{type:true,amount:true}});
	expect(ledgerAfter).toHaveLength(ledgerBefore.length);
	expect(ledgerAfter.reduce((balance,entry)=>balance+(entry.type==='CREDIT'?1:-1)*Number(entry.amount),0)).toBeCloseTo(balanceBefore,8);

	const newPassword='NewE2e1!Password';
	const registered=await page.request.post('/api/register',{data:await validRegistrationPayload(email,newPassword,{name:'Replacement E2E User',firstName:'Replacement',lastName:'E2E User',country:'United States',countryCode:'US',address:{countryCode:'US',line1:'1 Test St',city:'Test City'}})});
	expect(registered.status()).toBe(201);
	expect(await db.user.findUnique({where:{email}})).toMatchObject({email,status:'ACTIVE'});
});

test('admin broadcast lifecycle is persisted and visible to active users without inventing a stream',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const userContext=await browser.newContext();
	try{
		const userPage=await userContext.newPage();
		await loginAs(userPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		expect((await userPage.request.get('/api/admin/broadcasts')).status()).toBe(403);
		const scheduledAt=new Date(Date.now()+86_400_000).toISOString();
		const createdResponse=await page.request.post('/api/admin/broadcasts',{data:{title:'E2E configured broadcast',description:'A published session without a configured video source.',streamUrl:null,startsAt:scheduledAt,status:'DRAFT'}});
		expect(createdResponse.status()).toBe(201);
		const created=await createdResponse.json();
		const scheduled=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'schedule'}});
		expect((await scheduled.json()).status).toBe('SCHEDULED');
		const published=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'publish'}});
		expect((await published.json()).status).toBe('PUBLISHED');
		const userBroadcasts=await userPage.request.get('/api/broadcasts').then(response=>response.json());
		expect(userBroadcasts.eligibilityTier).toBe(1);
		expect(userBroadcasts.broadcasts.find((item:{id:string})=>item.id===created.id)).toMatchObject({status:'PUBLISHED',streamUrl:null});
		await userPage.goto('/broadcasts');
		await expect(userPage.getByRole('heading',{name:'E2E configured broadcast'})).toBeVisible();
		await expect(userPage.getByText('No stream source configured')).toBeVisible();
		const ended=await page.request.patch('/api/admin/broadcasts',{data:{id:created.id,action:'end'}});
		expect((await ended.json()).status).toBe('ENDED');
		const endedBroadcasts=await userPage.request.get('/api/broadcasts').then(response=>response.json());
		expect(endedBroadcasts.broadcasts.find((item:{id:string})=>item.id===created.id).status).toBe('ENDED');
	}finally{await userContext.close();}
});

test('Deleted Items enforces admin access and supports audited soft delete, bulk restore, and permanent removal',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const userContext=await browser.newContext();
	const userPage=await userContext.newPage();
	try{
		await loginAs(userPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		expect((await userPage.request.get('/api/admin/deleted-items')).status()).toBe(403);
		await userPage.goto('/admin/deleted-items');
		await expect(userPage).toHaveURL(/\/dashboard$/);
	}finally{await userContext.close();}
	const adminId=await db.user.findUniqueOrThrow({where:{email:fixture('ADMIN_EMAIL')},select:{id:true}}).then(user=>user.id);
	const suffix=randomUUID();
	const waitlist=await db.waitlistEntry.create({data:{email:`deleted-${suffix}@example.invalid`,name:'Recycle Bin Waitlist',country:'GB',consent:true}});
	const story=await db.clientStory.create({data:{displayName:'Recycle Bin Story',country:'GB',quote:'A private test story for deleted-item lifecycle coverage.'}});
	const broadcast=await db.broadcast.create({data:{title:'Recycle Bin Broadcast',description:'A private test broadcast for deleted-item lifecycle coverage.',createdById:adminId}});
	const removedWaitlist=await page.request.delete('/api/admin/waitlist',{data:{id:waitlist.id}});
	const removedStory=await page.request.delete('/api/admin/client-stories',{data:{storyId:story.id}});
	const removedBroadcast=await page.request.delete('/api/admin/broadcasts',{data:{id:broadcast.id}});
	expect(removedWaitlist.status()).toBe(200);
	expect(removedStory.status()).toBe(200);
	expect(removedBroadcast.status()).toBe(200);
	const deleted=await page.request.get('/api/admin/deleted-items').then(response=>response.json());
	expect(deleted).toHaveLength(3);
	expect(deleted.map((item:{type:string})=>item.type).sort()).toEqual(['BROADCAST','CLIENT_STORY','WAITLIST_ENTRY']);
	expect(deleted.every((item:{deletedBy:{email:string}|null;originalLocation:string})=>item.deletedBy?.email===fixture('ADMIN_EMAIL')&&item.originalLocation.startsWith('/admin/'))).toBe(true);
	await page.goto('/admin/deleted-items');
	await expect(page.getByRole('heading',{name:'Deleted Items'})).toBeVisible();
	await expect(page.getByText('Recycle Bin Broadcast')).toBeVisible();
	await expect(page.getByText('Recycle Bin Story')).toBeVisible();
	await page.getByLabel('Filter by item type').selectOption('WAITLIST_ENTRY');
	await expect(page.getByText('Recycle Bin Waitlist')).toBeVisible();
	await page.getByLabel('Filter by item type').selectOption('ALL');
	await page.getByLabel('Search deleted items').fill('Recycle Bin Story');
	await expect(page.getByText('Recycle Bin Story')).toBeVisible();
	await expect(page.getByText('Recycle Bin Broadcast')).toHaveCount(0);
	await page.getByLabel('Search deleted items').clear();
	await expect(page.getByText('Recycle Bin Broadcast')).toBeVisible();
	for(const name of ['Recycle Bin Waitlist','Recycle Bin Story','Recycle Bin Broadcast'])await page.getByRole('checkbox',{name:`Select ${name}`}).check();
	await page.getByRole('button',{name:'Restore selected'}).click();
	await expect(page.getByText('3 items restored.')).toBeVisible();
	expect(await db.waitlistEntry.findUnique({where:{id:waitlist.id}}).then(item=>item?.deletedAt)).toBeNull();
	expect(await db.clientStory.findUnique({where:{id:story.id}}).then(item=>item?.deletedAt)).toBeNull();
	expect(await db.broadcast.findUnique({where:{id:broadcast.id}}).then(item=>item?.deletedAt)).toBeNull();
	const restoredEvents=await db.auditLog.count({where:{entityId:{in:[waitlist.id,story.id,broadcast.id]},action:{in:['WAITLIST_ENTRY_RESTORED','CLIENT_STORY_RESTORED','BROADCAST_RESTORED']}}});
	expect(restoredEvents).toBe(3);
	await page.request.delete('/api/admin/waitlist',{data:{id:waitlist.id}});
	await page.request.delete('/api/admin/client-stories',{data:{storyId:story.id}});
	await page.request.delete('/api/admin/broadcasts',{data:{id:broadcast.id}});
	const secondListing=await page.request.get('/api/admin/deleted-items').then(response=>response.json());
	const permanentlyDeleted=await page.request.post('/api/admin/deleted-items',{data:{action:'permanently-delete',items:secondListing.map((item:{type:string;id:string})=>({type:item.type,id:item.id}))}});
	expect(permanentlyDeleted.status()).toBe(200);
	expect((await permanentlyDeleted.json()).affected).toBe(3);
	expect(await db.waitlistEntry.findUnique({where:{id:waitlist.id}})).toBeNull();
	expect(await db.clientStory.findUnique({where:{id:story.id}})).toBeNull();
	expect(await db.broadcast.findUnique({where:{id:broadcast.id}})).toBeNull();
	const lifecycleEvents=await db.auditLog.count({where:{entityId:{in:[waitlist.id,story.id,broadcast.id]}}});
	expect(lifecycleEvents).toBe(12);
});

test('admin investment initiation is idempotent and reconciles against reserved ledger funds',async({browser,page})=>{
	await loginAs(page,fixture('ADMIN_EMAIL'),fixture('ADMIN_PASSWORD'));
	const demoUser=await createIsolatedDemoUser('admin-investment');
	const opportunityResponse=await page.request.post('/api/admin/investments',{data:{title:'E2E admin initiated plan',category:'Internal simulation',description:'Disposable plan for administrator-initiated investment coverage.',assetSymbol:null,minimumAmount:50,maximumAmount:1_000_000_000,targetReturnPercent:8,durationDays:30,startsAt:null,maturesAt:null,riskLevel:'MODERATE',status:'AVAILABLE',demoEligible:false,realEligible:true,requiresApproval:true,targetPrice:null,stopPrice:null}});
	expect(opportunityResponse.status()).toBe(201);
	const opportunity=await opportunityResponse.json();
	const userContext=await browser.newContext();
	try{
		const userPage=await userContext.newPage();
		await loginAs(userPage,demoUser.email,demoUser.password);
		await selectAccountMode(userPage,'REAL');
		const userId=await userPage.request.get('/api/profile').then(response=>response.json().then(profile=>profile.id));
		await requestRealBalanceAdjustment(browser,page,{userId,accountMode:'REAL',currency:'USD',amount:'2000.00',direction:'CREDIT',category:'ADMIN_ALLOCATION',reason:'Isolated investment route test funding',idempotencyKey:randomUUID()});
		const before=Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance);
		expect(before).toBe(2000);
		const initialEligible=await userPage.request.get('/api/investments').then(response=>response.json());
		expect(initialEligible).toMatchObject({accountMode:'REAL',availableBalance:'2000',requests:[]});
		expect(initialEligible.opportunities).toEqual(expect.arrayContaining([expect.objectContaining({id:opportunity.id})]));
		await db.fundingRequest.create({data:{userId,type:'WITHDRAWAL',method:'E2E reserved withdrawal',amount:500,currency:'USD',accountMode:'REAL',status:'PENDING_REVIEW'}});
		const expectedAvailable=Prisma.Decimal.max(0,new Prisma.Decimal(before).minus(500)).toString();
		expect((await userPage.request.get('/api/investments').then(response=>response.json())).availableBalance).toBe(expectedAvailable);
		const eligibleUsers=await page.request.get(`/api/admin/investments/users?search=${encodeURIComponent(demoUser.email)}`).then(response=>response.json());
		expect(eligibleUsers.items.find((item:{id:string})=>item.id===userId).availableBalances.REAL).toBe(expectedAvailable);
		const idempotencyKey=randomUUID();
		const startsAt=new Date(Date.now()-1000);
		const maturesAt=new Date(startsAt.getTime()+30*86_400_000);
		const payload={action:'initiate',userId,opportunityId:opportunity.id,accountMode:'REAL',amount:250,targetReturnPercent:8,startsAt:startsAt.toISOString(),maturesAt:maturesAt.toISOString()};
		const demoInitiation=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,accountMode:'DEMO'}});
		expect(demoInitiation.status()).toBe(400);
		const initiated=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(initiated.status()).toBe(201);
		const investment=await initiated.json();
		expect(investment).toMatchObject({userId,accountMode:'REAL',amount:'250',status:'ACTIVE',targetReturnPercent:'8'});
		const replay=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:payload});
		expect(replay.status()).toBe(200);
		expect((await replay.json()).id).toBe(investment.id);
		const mismatchedReplay=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':idempotencyKey},data:{...payload,amount:300}});
		expect(mismatchedReplay.status()).toBe(409);
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${investment.id}:RESERVE`}})).toBe(1);
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-250);
		expect((await userPage.request.get('/api/investments').then(response=>response.json())).requests).toContainEqual(expect.objectContaining({id:investment.id,accountMode:'REAL'}));

		const scheduledStart=new Date(Date.now()+60_000);
		const scheduledEnd=new Date(scheduledStart.getTime()+7*86_400_000);
		const scheduledResponse=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:100,startsAt:scheduledStart.toISOString(),maturesAt:scheduledEnd.toISOString()}});
		expect(scheduledResponse.status()).toBe(201);
		const scheduled=await scheduledResponse.json();
		expect(scheduled.status).toBe('APPROVED');
		await settleMaturedSimulatedInvestments(new Date(scheduledStart.getTime()+1));
		expect((await db.investmentRequest.findUniqueOrThrow({where:{id:scheduled.id}})).status).toBe('ACTIVE');
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-350);
		await db.investmentRequest.update({where:{id:scheduled.id},data:{maturesAt:new Date(Date.now()-1000)}});
		await settleMaturedSimulatedInvestments(new Date());
		const settled=await db.investmentRequest.findUniqueOrThrow({where:{id:scheduled.id}});
		expect(settled.status).toBe('SETTLED');
		expect(settled.simulatedPayout?.toFixed(2)).toBe('108.00');
		expect(await db.ledgerTransaction.count({where:{reference:`INVESTMENT:${scheduled.id}:SIMULATED_RETURN`}})).toBe(0);
		expect(Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance)).toBe(before-242);

		const currentBalance=Number((await userPage.request.get('/api/wallet').then(response=>response.json())).balance);
		const overBalance=await page.request.post('/api/admin/investments',{headers:{'Idempotency-Key':randomUUID()},data:{...payload,amount:currentBalance+1}});
		expect(overBalance.status()).toBe(400);
	}finally{await userContext.close();}
});
