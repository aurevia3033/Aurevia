import {test,expect,expectNoHorizontalOverflow,loginAs,waitForStartup} from './fixtures';
import {concreteRoutePath,fallbackRoutes,publicRoutes,themes} from './theme-route-inventory';

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

function fixture(name:string){
	const value=process.env[`AUREVIA_E2E_${name}`];
	if(!value)throw new Error(`Playwright fixture ${name} is unavailable.`);
	return value;
}

test.describe('public routes and responsive layout',()=>{
	for(const viewport of viewports){
		test(`public routes render without horizontal overflow at ${viewport.width}x${viewport.height}`,async({page})=>{
			test.setTimeout(300_000);
			await page.setViewportSize(viewport);
			for(const theme of themes){
				await page.context().addCookies([{name:'aurevia-anonymous-theme',value:theme,url:appOrigin}]);
				for(const route of publicRoutes){
					await test.step(`${route} in ${theme}`,async()=>{
						const path=concreteRoutePath(route);
						const response=await page.goto(path);
						expect(response?.status(),route).toBe(200);
						await expect(page.locator('html'),`${route} (${theme})`).toHaveAttribute('data-theme-name',theme);
						await expect(page.locator('h1:visible').first(),route).toBeVisible();
						if(route==='/admin/login')await expect(page.locator('.admin-login-card')).toBeVisible();
						if(route==='/support')await expect(page.getByRole('heading',{name:'Nova AI',exact:true})).toBeVisible();
						if(route==='/register'){
							await expect(page.getByRole('heading',{name:viewport.width<=680?'Create your Aurevia account':'Welcome to Aurevia Exchange.'})).toBeVisible();
							await expect(page.getByRole('textbox',{name:'First name'})).toBeVisible();
						}
						await expectNoHorizontalOverflow(page);
					});
				}
				for(const route of fallbackRoutes){
					await test.step(`${route} fallback in ${theme}`,async()=>{
						const response=await page.goto(route);
						expect(response?.status(),route).toBe(404);
						await expect(page.locator('html'),`${route} (${theme})`).toHaveAttribute('data-theme-name',theme);
						await expect(page.getByRole('heading',{name:'404'})).toBeVisible();
						await expectNoHorizontalOverflow(page);
					});
				}
			}
		});
	}
});

test('zoom remains available for regular pages and admin',async({page})=>{
	await page.goto('/markets');
	const regularViewport=await page.locator('meta[name="viewport"]').getAttribute('content');
	expect(regularViewport).toContain('maximum-scale=5');
	expect(regularViewport).toContain('user-scalable=yes');
	const regularZoomPrevented=await page.evaluate(()=>{
		const event=new KeyboardEvent('keydown',{key:'-',ctrlKey:true,cancelable:true});
		document.dispatchEvent(event);
		return event.defaultPrevented;
	});
	expect(regularZoomPrevented).toBe(false);

	await page.goto('/admin/login');
	const adminViewport=await page.locator('meta[name="viewport"]').getAttribute('content');
	expect(adminViewport).toContain('width=device-width');
	expect(adminViewport).toContain('maximum-scale=5');
	expect(adminViewport).toContain('user-scalable=yes');
	const adminZoomAvailable=await page.evaluate(()=>{
		const event=new KeyboardEvent('keydown',{key:'-',ctrlKey:true,cancelable:true});
		document.dispatchEvent(event);
		return event.defaultPrevented;
	});
	expect(adminZoomAvailable).toBe(false);
});

test('Lucide icons use dimensional styling in both site themes',async({page})=>{
	for(const theme of themes){
		await page.context().addCookies([{name:'aurevia-anonymous-theme',value:theme,url:appOrigin}]);
		await page.goto('/markets');
		await expect(page.locator('html')).toHaveAttribute('data-theme-name',theme);
		const icon=page.locator('svg.lucide:visible').first();
		await expect(icon).toBeVisible();
		const style=await icon.evaluate(element=>{
			const computed=getComputedStyle(element);
			return {filter:computed.filter,transform:computed.transform};
		});
		expect((style.filter.match(/drop-shadow\(/g)||[]).length).toBeGreaterThanOrEqual(4);
		expect(style.transform).toMatch(/^matrix3d\(/);
	}
});

test('education page heading fits mobile screens without zooming out',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/education');
	await expect(page.getByRole('heading',{name:'Education',level:1})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Start with the building blocks.',level:2})).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('homepage keeps Stories in navigation and off the landing content',async({page})=>{
	for(const width of [320,375,414]){
		await page.setViewportSize({width,height:844});
		await page.goto('/');
		await expect(page.locator('.stories-section')).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
	}
	await loginAs(page,process.env.AUREVIA_E2E_USER_EMAIL!,process.env.AUREVIA_E2E_USER_PASSWORD!);
	const moreButton=page.getByRole('navigation',{name:'Primary account navigation'}).getByRole('button',{name:'More navigation'});
	const hitTest=await moreButton.evaluate(button=>{
		const bounds=button.getBoundingClientRect();
		const hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
		const chat=document.querySelector('.floating-support')?.getBoundingClientRect();
		return {hitByChat:Boolean(hit?.closest('.floating-support')),more:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},chat:chat?{left:chat.left,right:chat.right,top:chat.top,bottom:chat.bottom}:null};
	});
	expect(hitTest.hitByChat,JSON.stringify(hitTest)).toBe(false);
	await moreButton.click();
	await expect(page.getByRole('dialog',{name:'More'}).getByRole('link',{name:'Stories',exact:true})).toHaveAttribute('href','/stories');
});

test.describe('mocked testimonial API response',()=>{
test.use({serviceWorkers:'block'});
test('homepage testimonial profile stays visible when its portrait is unavailable',async({page})=>{
	await page.route('**/api/client-stories',route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify([{id:'home-testimonial',displayName:'Sam Example',country:'Canada',cityOrRegion:'Toronto',title:'A clear account view',quote:'I can review my account in one place.',imageUrl:'data:image/png;base64,AA==',rating:5}]),
	}));
	await page.goto('/');
	await waitForStartup(page);
	const profile=page.locator('.client-story-stage').filter({hasText:'Sam Example'});
	await expect(profile).toBeVisible();
	await expect(profile.getByText('I can review my account in one place.')).toBeVisible();
	await profile.scrollIntoViewIfNeeded();
	await expect(profile.locator('.client-story-monogram')).toHaveText('S');
});
});

test('public navigation is balanced in the desktop header and remains accessible on mobile',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.goto('/');
	const websiteNavigation=page.getByRole('navigation',{name:'Website navigation'});
	await expect(websiteNavigation).toBeVisible();
	for(const label of ['Platform','Markets','How it works','Education','Support','Sign in','Create an account']){
		await expect(websiteNavigation.getByRole('link',{name:label})).toBeVisible();
	}
	await expect(page.getByRole('button',{name:'Open navigation'})).toBeHidden();
	await expectNoHorizontalOverflow(page);

	await page.setViewportSize({width:390,height:844});
	await expect(websiteNavigation).toBeHidden();
	await expect(page.getByRole('button',{name:'Open navigation'})).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('homepage renders for signed-out and signed-in visitors on desktop and mobile',async({browser})=>{
	test.setTimeout(300_000);
	for(const authenticated of [false,true]){
		for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
			const context=await browser.newContext({viewport});
			try{
				const page=await context.newPage();
				if(authenticated)await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
				const response=await page.goto('/');
				expect(response?.status()).toBe(200);
				await expect(page.locator('.home-hero h1').first()).toBeVisible();
				await expectNoHorizontalOverflow(page);
			}finally{
				await context.close();
			}
		}
	}
});

test('PWA metadata is valid and an offline navigation displays a clear fallback',async({page})=>{
	const fatalErrors:string[]=[];
	page.on('pageerror',error=>fatalErrors.push(error.message));
	page.on('console',message=>{
		if(message.type()==='error'&&/Content Security Policy|Refused to/.test(message.text()))fatalErrors.push(message.text());
	});
	const manifestResponse=await page.request.get('/manifest.webmanifest');
	expect(manifestResponse.ok()).toBe(true);
	expect(await manifestResponse.json()).toMatchObject({
		name:'Aurevia Exchange',
		short_name:'Aurevia',
		start_url:'/',
		display:'standalone',
		theme_color:'#07110D',
	});
	const offlineResponse=await page.request.get('/offline.html');
	expect(offlineResponse.ok()).toBe(true);

	for(const viewport of [{width:390,height:844},{width:412,height:915},{width:1365,height:900}]){
		await page.setViewportSize(viewport);
		await page.goto('/');
		await expect(page.locator('.home-hero h1').first()).toBeVisible();
		await expectNoHorizontalOverflow(page);
	}
	await page.evaluate(()=>navigator.serviceWorker.ready);
	await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
	await page.context().setOffline(true);
	await page.goto('/dashboard');
	await expect(page.getByRole('heading',{name:'You’re offline'})).toBeVisible();
	await expect(page.getByText('Live prices, balances, transactions, and account details are not available offline.')).toBeVisible();
	expect(fatalErrors).toEqual([]);
});

test('mobile install guidance uses iOS Add to Home Screen and Android install options',async({browser})=>{
	const userAgents=[
		{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',heading:'Add Aurevia to your Home Screen',instruction:'In Safari, tap Share, choose “Add to Home Screen”, then tap Add.'},
		{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',heading:'Install Aurevia App',instruction:'Install Aurevia for a standalone app experience on this device.'},
	];
	for(const device of userAgents){
		const context=await browser.newContext({userAgent:device.userAgent,viewport:{width:390,height:844}});
		try{
			const page=await context.newPage();
			await page.goto('/');
			const installDialog=page.getByRole('dialog',{name:'Install Aurevia App'});
			await expect(installDialog.getByText(device.heading)).toBeVisible();
			await expect(installDialog.getByText(device.instruction)).toBeVisible();
			if(device.heading==='Install Aurevia App'){
				await installDialog.getByRole('button',{name:'Options'}).click();
				await expect(installDialog).toContainText('Open your browser menu');
			}
		}finally{await context.close()}
	}
});

test('slow page navigation keeps the current page usable with the standard loading indicator',async({page})=>{
	await page.setViewportSize({width:1280,height:900});
	await page.goto('/');
	await page.route('**/login**',async route=>{
		await new Promise(resolve=>setTimeout(resolve,900));
		await route.continue();
	});

	await page.locator('.home-hero-actions a[href="/login"]').click();
	const loader=page.locator('.page-transition-loader');
	await expect(loader).toBeVisible();
	await expect(loader.getByRole('status',{name:'Loading the next page'})).toBeVisible();
	await expect(page.locator('.home-hero h1').first()).toBeVisible();
	await expect(page.locator('.scene-content > div').first()).not.toHaveJSProperty('inert',true);
	await page.waitForURL(/\/login$/);
	await expect(loader).toHaveCount(0);
});

test('homepage hero actions remain usable with reduced motion',async({browser,page})=>{
	await page.setViewportSize({width:1280,height:900});
	await page.goto('/');
	await expect(page.locator('.home-hero').locator('h1').first()).toBeVisible();
	await expect(page.locator('.home-hero-actions a[href="/register"]')).toBeVisible();
	await expect(page.locator('.home-hero-actions a[href="/login"]')).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await expect(page.locator('.market-depth-fallback')).toBeVisible();

	const nextSession=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
	try{
		const nextPage=await nextSession.newPage();
		await nextPage.goto('/');
		await waitForStartup(nextPage);
		await expect(nextPage.locator('.home-hero').locator('h1').first()).toBeVisible();
		await expect(nextPage.locator('.home-hero-actions a[href="/register"]')).toBeVisible();
		await expect(nextPage.locator('.market-depth-fallback')).toBeVisible();
		await expect(nextPage.locator('.market-depth-canvas')).toHaveCount(0);
		await expectNoHorizontalOverflow(nextPage);
	}finally{await nextSession.close();}
});

test('homepage uses a static 3D fallback on narrow mobile screens',async({page})=>{
	await page.setViewportSize({width:320,height:800});
	await page.goto('/');
	await expect(page.locator('.market-depth-fallback')).toBeVisible();
	await expect(page.locator('.market-depth-canvas')).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test('terms and privacy policies remain readable to signed-out visitors',async({page})=>{
	await page.goto('/terms');
	await expect(page.getByRole('heading',{name:'Terms of use'})).toBeVisible();
	await expect(page.locator('.policy-consent-dialog')).toBeHidden();
	await page.goto('/privacy');
	await expect(page.getByRole('heading',{name:'Privacy overview'})).toBeVisible();
	await expect(page.locator('.policy-consent-dialog')).toBeHidden();
});

test.describe('mocked homepage market APIs',()=>{
test.use({serviceWorkers:'block'});
test('homepage clearly shows simulated DEMO prices when live providers are unavailable',async({page})=>{
	await page.route('**/api/live-markets?*',async route=>{
		await new Promise(resolve=>setTimeout(resolve,6_000));
		try{
			await route.fulfill({
				status:200,
				contentType:'application/json',
				body:JSON.stringify({quotes:[{asset:{id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},error:'No provider quote'}],marketDataStatus:'UNAVAILABLE'}),
			});
		}catch{/* the page should have timed out and used its demo fallback */}
	});
	await page.route('**/api/market',route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify([{
			symbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD',name:'Bitcoin / USD',price:'92500',
			dataMode:'SIMULATED',lastUpdatedAt:new Date().toISOString(),
		}]),
	}));
	await page.goto('/');
	await expect(page.locator('.market-time .live-pill')).toHaveText('DEMO');
	await expect(page.locator('.market-stage-price')).toContainText('92,500.00');
	await expect(page.locator('.market-stage-price')).toContainText('Simulated DEMO price');
	await expect(page.locator('.market-chart-empty')).toContainText('not a live market quote');
	await expect(page.locator('.market-feed-status')).toContainText('Simulated DEMO prices · not live');
});
});

test('homepage clearly labels stock and crypto trading modes',async({page})=>{
	await page.goto('/');
	await waitForStartup(page);
	const stocks=page.locator('.asset-item').filter({hasText:'Stock trading'}).first();
	await expect(stocks).toContainText('DEMO');
	await expect(stocks).toContainText('NVDA');
	await expect(stocks).toContainText('wallet-funded internal simulation');
	const crypto=page.locator('.asset-item').filter({hasText:'Crypto trading'}).first();
	await expect(crypto).toContainText('BTC/USD');
	await expect(crypto).toContainText('ETH/USD');
	await expect(crypto).toContainText('wallet-funded internal simulation');
});

test.describe('theme preference across navigation and devices',()=>{
test.use({serviceWorkers:'block'});
test('site theme preference switches globally and persists across navigation and devices',async({browser,page})=>{
	await page.setViewportSize({width:390,height:844});
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await page.goto('/about-me');
	const ticker=page.locator('.site-nav-user-shell .global-market-ticker');
	await expect(ticker).toBeVisible();
	const tickerLayout=await page.evaluate(()=>{
		const tickerElement=document.querySelector('.site-nav-user-shell .global-market-ticker');
		const header=document.querySelector('.site-nav-user-shell');
		const dock=document.querySelector('.user-bottom-navigation');
		if(!tickerElement||!header||!dock)return null;
		return{
			tickerBottom:tickerElement.getBoundingClientRect().bottom,
			headerBottom:header.getBoundingClientRect().bottom,
			dockTop:dock.getBoundingClientRect().top,
		};
	});
	if(!tickerLayout)throw new Error('Expected the user header, market ticker, and bottom dock to be present');
	expect(tickerLayout.tickerBottom).toBeLessThanOrEqual(tickerLayout.headerBottom);
	expect(tickerLayout.tickerBottom).toBeLessThan(tickerLayout.dockTop);
	await page.getByRole('button',{name:'More navigation'}).click();
	const themeToggle=page.locator('#user-more-menu').getByRole('button',{name:'Premium Dashboard'});
	await themeToggle.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme-name','premium-dashboard');
	await expect.poll(()=>page.locator('html').evaluate(element=>(element as HTMLElement).style.backgroundColor)).toBe('rgb(247, 248, 245)');
	await expect(page.locator('body')).toHaveCSS('background-color','rgb(247, 248, 245)');
	await page.goto('/dashboard');
	await expect(page.locator('html')).toHaveAttribute('data-theme-name','premium-dashboard');
	const secondDevice=await browser.newContext({viewport:{width:390,height:844}});
	try{
		const secondPage=await secondDevice.newPage();
		await loginAs(secondPage,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
		await secondPage.goto('/about-me');
		await expect(secondPage.locator('html')).toHaveAttribute('data-theme-name','premium-dashboard');
		await secondPage.getByRole('button',{name:'Forest Green'}).click();
		await expect(secondPage.locator('html')).toHaveAttribute('data-theme-name','forest-green');
		await expect.poll(()=>secondPage.locator('html').evaluate(element=>(element as HTMLElement).style.backgroundColor)).toBe('rgb(7, 17, 13)');
	}finally{await secondDevice.close();}
});
});

test('authenticated dashboard logo returns to Home without a URL parsing error',async({page})=>{
	const pageErrors:string[]=[];
	page.on('pageerror',error=>pageErrors.push(error.message));
	await loginAs(page,fixture('USER_EMAIL'),fixture('USER_PASSWORD'));
	await waitForStartup(page);
	await page.locator('.dashboard-sidebar-brand').click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.locator('.home-root')).toBeVisible();
	expect(pageErrors.filter(message=>message.includes('string did not match the expected pattern'))).toEqual([]);
});

test('public disclosures explain internal simulated orders and wallet records',async({page})=>{
	await page.goto('/terms');
	await expect(page.getByText(/REAL-mode orders are funded from the Aurevia Wallet and simulated internally/)).toBeVisible();
	await expect(page.getByText(/no external exchange order is placed and wallet assets are not silently converted/)).toBeVisible();
	await page.goto('/risk-disclosure');
	await expect(page.getByText(/REAL-mode orders are funded from the Aurevia Wallet and simulated internally/)).toBeVisible();
	await expect(page.getByText(/They do not represent money held in custody or confirmation that an external payment occurred/)).toBeVisible();
	await page.goto('/privacy');
	await expect(page.getByText(/private object-storage bucket/)).toBeVisible();
	await expect(page.locator('.info-note')).toContainText('short-lived links');
});
