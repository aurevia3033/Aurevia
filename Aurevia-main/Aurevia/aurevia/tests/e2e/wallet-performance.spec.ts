import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {test,expect,loginAs,waitForStartup} from './fixtures';
import type {Request} from '@playwright/test';
import {db} from '../../lib/db';
import {initializeDemoAccount} from '../../lib/ledger';
import {CURRENT_TERMS_VERSION} from '../../lib/policy-consent';
import {currentMandatoryTermsWhere} from '../../lib/managed-notice-policy';
import {REGISTRATION_LEGAL_DOCUMENTS} from '../../lib/registration-legal';

test('wallet initial load records authoritative balance and request timings',async({page})=>{
	const requests:{path:string;elapsedMs:number}[]=[];
	const requestStartedAt=new WeakMap<Request,number>();
	const email=`aurevia-e2e-wallet-performance-${randomUUID()}@example.invalid`;
	const password=`E2e-${randomUUID()}-A1!`;
	const user=await db.user.create({data:{
		email,
		name:'Temporary wallet performance user',
		country:'Test',
		passwordHash:await bcrypt.hash(password,10),
		accountMode:'DEMO',
		status:'ACTIVE',
	}});
	await db.$transaction(tx=>initializeDemoAccount(tx,user.id));
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
	page.on('request',request=>requestStartedAt.set(request,Date.now()));
	page.on('response',response=>{
		const path=new URL(response.url()).pathname;
		if(!path.startsWith('/api/'))return;
		const started=requestStartedAt.get(response.request());
		if(started!==undefined)requests.push({path,elapsedMs:Date.now()-started});
	});

	await loginAs(page,email,password);
	requests.length=0;
	const startedAt=Date.now();
	await page.goto('/wallet');
	await waitForStartup(page);
	const balance=page.locator('.wallet-balance-value');
	await expect(balance).not.toHaveText('Loading…');
	await expect(balance).not.toHaveText('Unavailable');
	await expect(balance).not.toBeEmpty();

	const walletRequest=requests.filter(request=>request.path==='/api/wallet');
	expect(walletRequest).toHaveLength(1);
	console.info('[wallet-performance] Initial wallet load',JSON.stringify({
		pageToAuthoritativeBalanceMs:Date.now()-startedAt,
		apiRequests:requests.length,
		apiTimingsMs:requests.map(({path,elapsedMs})=>({path,elapsedMs})),
	}));
});
