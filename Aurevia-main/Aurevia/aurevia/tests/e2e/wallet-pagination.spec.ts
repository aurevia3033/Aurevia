import {randomUUID} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {test,expect,loginAs,waitForStartup} from './fixtures';
import {db} from '../../lib/db';

test('wallet funding history fetches authorized pages and accurate account summaries',async({page})=>{
	const email=`aurevia-e2e-wallet-history-${randomUUID()}@example.invalid`;
	const password=`E2e-${randomUUID()}-A1!`;
	const user=await db.user.create({data:{
		email,
		name:'Temporary wallet history user',
		passwordHash:await bcrypt.hash(password,10),
		accountMode:'DEMO',
		status:'ACTIVE',
	}});
	const otherUser=await db.user.create({data:{
		email:`aurevia-e2e-wallet-history-other-${randomUUID()}@example.invalid`,
		passwordHash:await bcrypt.hash(password,10),
		accountMode:'DEMO',
		status:'ACTIVE',
	}});
	try{
		await db.fundingRequest.createMany({data:[
			...Array.from({length:23},(_,index)=>({
				id:randomUUID(),
				userId:user.id,
				type:index%2===0?'DEPOSIT' as const:'WITHDRAWAL' as const,
				method:`Test method ${index+1}`,
				amount:100,
				currency:'USD',
				accountMode:'DEMO' as const,
				status:index<5?'PENDING_REVIEW' as const:'COMPLETED' as const,
				idempotencyKey:randomUUID(),
			})),
			{
				id:randomUUID(),
				userId:otherUser.id,
				type:'DEPOSIT' as const,
				method:'Other account record',
				amount:999,
				currency:'USD',
				accountMode:'DEMO' as const,
				status:'COMPLETED' as const,
				idempotencyKey:randomUUID(),
			},
		]});

		await loginAs(page,email,password);
		const firstPageResponse=await page.request.get('/api/wallet/transactions?type=ALL&page=1');
		expect(firstPageResponse.status()).toBe(200);
		const firstPage=await firstPageResponse.json();
		expect(firstPage).toMatchObject({
			accountMode:'DEMO',
			type:'ALL',
			page:1,
			pageSize:20,
			pageCount:2,
			filteredCount:23,
			totalCount:23,
			pendingCount:5,
			totalUsdDeposits:'1200',
			totalUsdWithdrawals:'1100',
		});
		expect(firstPage.transactions).toHaveLength(20);
		expect(JSON.stringify(firstPage)).not.toContain('Other account record');
		const secondPageResponse=await page.request.get('/api/wallet/transactions?type=ALL&page=2');
		expect((await secondPageResponse.json()).transactions).toHaveLength(3);
		const withdrawalsResponse=await page.request.get('/api/wallet/transactions?type=WITHDRAWAL&page=1');
		expect(await withdrawalsResponse.json()).toMatchObject({type:'WITHDRAWAL',filteredCount:11,pageCount:1});

		await page.goto('/wallet/transactions');
		await waitForStartup(page);
		await page.getByRole('button',{name:'View history'}).click();
		await expect(page.getByText('23',{exact:true})).toBeVisible();
		await expect(page.locator('.transaction-history-row')).toHaveCount(20);
		await expect(page.getByText('Page 1 of 2 · 23 requests')).toBeVisible();
		await page.getByRole('button',{name:/Next/}).click();
		await expect(page.locator('.transaction-history-row')).toHaveCount(3);
		await expect(page.getByText('Page 2 of 2 · 23 requests')).toBeVisible();
		await page.getByRole('button',{name:'Withdrawals'}).click();
		await expect(page.locator('.transaction-history-row')).toHaveCount(11);
		await expect(page.getByText('Page 1 of 1 · 11 requests')).toBeVisible();
	}finally{
		await db.user.deleteMany({where:{id:{in:[user.id,otherUser.id]}}});
	}
});
