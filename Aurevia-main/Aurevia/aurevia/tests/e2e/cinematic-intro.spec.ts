import {expect,test,type Page} from '@playwright/test';

async function holdVideoRequests(page:Page){
	const releases:Array<()=>Promise<void>>=[];
	await page.route('**/Videos/*.mp4',route=>new Promise<void>(resolve=>{
		releases.push(async()=>{
			try{await route.abort()}catch{}
			resolve();
		});
	}));
	return async()=>Promise.all(releases.map(release=>release()));
}

async function prepareFirstVisit(page:Page,playResult:'resolve'|'reject'){
	await page.addInitScript(({result})=>{
		Object.defineProperty(window,'__aureviaStartupPlayCalls',{configurable:true,writable:true,value:0});
		Object.defineProperty(HTMLMediaElement.prototype,'play',{
			configurable:true,
			value:()=>{
				const target=window as Window&{__aureviaStartupPlayCalls?:number};
				target.__aureviaStartupPlayCalls=(target.__aureviaStartupPlayCalls||0)+1;
				return result==='resolve'?Promise.resolve():Promise.reject(new Error('Autoplay blocked'));
			},
		});
	},{result:playResult});
}

test('fresh homepage loads automatically start the intro with browser-safe playback settings',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.emulateMedia({reducedMotion:'no-preference'});
	await prepareFirstVisit(page,'resolve');
	await page.goto('/');
	const intro=page.getByRole('dialog',{name:'Aurevia Exchange introduction'});
	const video=page.locator('.exchange-intro-video');
	await expect(intro).toBeVisible();
	await expect(page.locator('link[rel="preload"][as="video"]')).toHaveCount(0);
	await expect(video).toHaveAttribute('autoplay','');
	await expect(video).toHaveJSProperty('muted',true);
	await expect(video).toHaveAttribute('playsinline','');
	await expect(video).toHaveAttribute('preload','auto');
	await expect.poll(()=>page.evaluate(()=>((window as Window&{__aureviaStartupPlayCalls?:number}).__aureviaStartupPlayCalls)||0)).toBeGreaterThan(0);
	await video.evaluate(element=>{
		Object.defineProperty(element,'currentTime',{configurable:true,value:7});
		element.dispatchEvent(new Event('timeupdate'));
	});
	await expect(intro).toBeVisible();
	await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
});

test('desktop intro falls back to the available orientation, ends, skips, and replays on a fresh load',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.emulateMedia({reducedMotion:'no-preference'});
	await prepareFirstVisit(page,'resolve');
	const releaseVideoRequests=await holdVideoRequests(page);
	let releaseInitialDesktop:undefined|(()=>Promise<void>);
	let desktopRequestCount=0;
	await page.route('**/Videos/aurevia-intro-desktop.mp4',route=>{
		desktopRequestCount+=1;
		if(desktopRequestCount>1)return route.abort();
		return new Promise<void>(resolve=>{
			releaseInitialDesktop=async()=>{
				try{await route.abort()}finally{resolve()}
			};
		});
	});
	try{
		await page.goto('/');
		const intro=page.getByRole('dialog',{name:'Aurevia Exchange introduction'});
		await expect(intro).toBeVisible();
		await expect(page.getByRole('button',{name:'Retry video'})).toHaveCount(0);
		const video=page.locator('.exchange-intro-video');
		await expect(video).toHaveAttribute('src','/Videos/aurevia-intro-desktop.mp4');
		if(!releaseInitialDesktop)throw new Error('Desktop video request did not start.');
		await releaseInitialDesktop();
		await expect(video).toHaveAttribute('src','/Videos/aurevia-intro-mobile.mp4');

		await video.evaluate(element=>element.dispatchEvent(new Event('ended',{bubbles:true})));
		await expect(intro).toBeHidden();
		await expect(page.locator('h1:visible').first()).toBeVisible();

		await page.getByRole('button',{name:'Replay video'}).click();
		await expect(intro).toBeVisible();
		await page.getByRole('button',{name:'Skip intro'}).click();
		await expect(intro).toBeHidden();
		await expect(page.getByRole('button',{name:'Replay video'})).toBeVisible();
		await page.evaluate(()=>window.history.pushState({},'','/stories'));
		await expect(page).toHaveURL(/\/stories$/);
		await expect(intro).toHaveCount(0);
		await page.evaluate(()=>window.history.pushState({},'','/'));
		await expect(page).toHaveURL(/\/$/);
		await expect(intro).toHaveCount(0);
		await page.reload();
		await expect(intro).toBeVisible();
		await expect(page.locator('.exchange-intro-video')).toHaveAttribute('autoplay','');
	}finally{
		await releaseVideoRequests();
	}
});
test('portrait devices select the mobile video and autoplay failures offer playback',async({page})=>{
	await page.setViewportSize({width:390,height:844});
	await page.emulateMedia({reducedMotion:'no-preference'});
	await prepareFirstVisit(page,'reject');
	const releaseVideoRequests=await holdVideoRequests(page);
	try{
		await page.goto('/');
		await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toBeVisible();
		const video=page.locator('.exchange-intro-video');
		await expect(video).toHaveAttribute('src','/Videos/aurevia-intro-mobile.mp4');
		await expect(page.locator('link[rel="preload"][as="video"]')).toHaveCount(0);
		expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
		await video.evaluate(element=>{
			Object.defineProperty(element,'readyState',{configurable:true,value:HTMLMediaElement.HAVE_CURRENT_DATA});
			element.dispatchEvent(new Event('loadeddata'));
		});
		await expect(page.getByRole('button',{name:'Play video'})).toBeVisible();
		await expect(page.getByRole('button',{name:'Retry video'})).toBeVisible();
		await page.getByRole('button',{name:'Play video'}).click();
		await expect(page.getByRole('button',{name:'Play video'})).toBeVisible();
		await page.getByRole('button',{name:'Skip intro'}).click();
		await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toBeHidden();
	}finally{
		await releaseVideoRequests();
	}
});

test('video network failures can be retried after connectivity returns',async({page})=>{
	await page.setViewportSize({width:1280,height:900});
	await page.emulateMedia({reducedMotion:'no-preference'});
	await prepareFirstVisit(page,'resolve');
	const failedSources=new Set<string>();
	await page.route('**/Videos/*.mp4',route=>{
		const source=new URL(route.request().url()).pathname;
		if(!failedSources.has(source)){
			failedSources.add(source);
			return route.abort();
		}
		return route.continue();
	});
	await page.goto('/');
	await expect(page.locator('.exchange-intro-actions [role="status"]')).toHaveText('The introduction video could not be loaded.');
	await expect(page.getByRole('button',{name:'Retry video'})).toBeVisible();
	await page.getByRole('button',{name:'Retry video'}).click();
	const video=page.locator('.exchange-intro-video');
	await expect(video).toHaveAttribute('src','/Videos/aurevia-intro-desktop.mp4');
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
	await expect(page.getByRole('button',{name:'Continue to Aurevia'})).toHaveCount(0);
	await page.getByRole('button',{name:'Skip intro'}).click();
	await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toBeHidden();
	await expect(page.locator('h1:visible').first()).toBeVisible();
});

test('real intro videos are served and autoplay is attempted with browser-safe settings',async({page})=>{
	await page.setViewportSize({width:1440,height:900});
	await page.emulateMedia({reducedMotion:'no-preference'});
	await page.addInitScript(()=>{
		const nativePlay=HTMLMediaElement.prototype.play;
		Object.defineProperty(window,'__aureviaIntroPlayAttempts',{configurable:true,writable:true,value:0});
		Object.defineProperty(HTMLMediaElement.prototype,'play',{
			configurable:true,
			value:function(this:HTMLMediaElement){
				(window as Window&{__aureviaIntroPlayAttempts?:number}).__aureviaIntroPlayAttempts=(window as Window&{__aureviaIntroPlayAttempts?:number}).__aureviaIntroPlayAttempts!+1;
				return nativePlay.call(this);
			},
		});
	});

	await page.goto('/');
	await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toBeVisible();
	for(const source of ['/Videos/aurevia-intro-desktop.mp4','/Videos/aurevia-intro-mobile.mp4']){
		const response=await page.request.get(new URL(source,page.url()).toString());
		expect(response.status()).toBe(200);
		expect(response.headers()['content-type']).toContain('video/mp4');
		const bytes=await response.body();
		expect(bytes.length).toBeGreaterThan(100_000);
		expect(bytes.toString('ascii',4,8)).toBe('ftyp');
	}

	const video=page.locator('.exchange-intro-video');
	await expect(video).toHaveAttribute('src','/Videos/aurevia-intro-desktop.mp4');
	await expect(video).toHaveAttribute('preload','auto');
	await expect(video).toHaveJSProperty('muted',true);
	await expect(video).toHaveJSProperty('playsInline',true);
	await expect.poll(()=>page.evaluate(()=>((window as Window&{__aureviaIntroPlayAttempts?:number}).__aureviaIntroPlayAttempts)||0)).toBeGreaterThan(0);
	await expect(page.getByRole('button',{name:'Skip intro'})).toBeVisible();
	await expect(page.getByRole('button',{name:'Retry video'})).toHaveCount(0);
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).currentTime),{timeout:10_000}).toBeGreaterThan(0.2);
	await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toHaveCount(0,{timeout:30_000});
});

test('reduced-motion visitors bypass automatic playback',async({page})=>{
	await page.setViewportSize({width:1280,height:900});
	await page.emulateMedia({reducedMotion:'reduce'});
	await page.goto('/');
	await expect(page.getByRole('dialog',{name:'Aurevia Exchange introduction'})).toHaveCount(0);
	await expect(page.locator('link[rel="preload"][as="video"]')).toHaveCount(0);
	await expect(page.locator('h1:visible').first()).toBeVisible();
});
