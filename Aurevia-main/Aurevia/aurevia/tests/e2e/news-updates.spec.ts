import {expect,test} from '@playwright/test';

const videoUrl='/Videos/aurevia-intro-desktop.mp4';
const items=[
	{
		id:'video-story',
		title:'Aurevia market briefing video',
		summary:'A video briefing with a readable summary.',
		canonicalUrl:videoUrl,
		publisher:'Aurevia Editorial',
		category:'VIDEO',
		publishedAt:'2026-11-17T07:00:00.000Z',
		thumbnailUrl:null,
		contentType:'editorial-link',
		mediaSource:{kind:'video',url:videoUrl},
		source:{key:'aurevia',displayName:'Aurevia Editorial',providerType:'EDITORIAL'},
	},
	{
		id:'embed-story',
		title:'Market perspective from our video partners',
		summary:'This supported provider embed keeps its native player controls.',
		canonicalUrl:'https://youtu.be/AbCdEf_1234',
		publisher:'Video Partner',
		category:'MARKET_NEWS',
		publishedAt:'2026-11-17T06:00:00.000Z',
		thumbnailUrl:null,
		contentType:'editorial-link',
		mediaSource:{kind:'embed',url:'https://www.youtube-nocookie.com/embed/AbCdEf_1234'},
		source:{key:'partner',displayName:'Video Partner',providerType:'EDITORIAL'},
	},
];

async function mockNewsFeed(page:import('@playwright/test').Page){
	await page.route(/\/api\/news-feed(?:\?|$)/,route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify({items,page:1,pageSize:12,total:items.length,hasMore:false,stale:false,lastSuccessAt:null,sources:[]}),
	}));
}

test('news page displays article headlines returned by the feed',async({page})=>{
	const article={
		...items[0],
		id:'market-article',
		title:'Markets respond to new economic data',
		canonicalUrl:'https://publisher.test/market-article',
		contentType:'article',
		mediaSource:null,
	};
	await page.route(/\/api\/news-feed(?:\?|$)/,route=>route.fulfill({
		status:200,
		contentType:'application/json',
		body:JSON.stringify({items:[article],page:1,pageSize:12,total:1,hasMore:false,stale:false,lastSuccessAt:null,sources:[]}),
	}));
	await page.goto('/news');
	await expect(page.getByRole('link',{name:/Markets respond to new economic data/})).toBeVisible();
});

test('news cards and video players fit phone, tablet, and desktop widths',async({page})=>{
	await mockNewsFeed(page);
	await page.setViewportSize({width:320,height:900});
	await page.goto('/news');
	const cards=page.locator('.news-feed-item');
	await expect(cards).toHaveCount(0);
	await expect(page.getByRole('region',{name:'Aurevia TV'})).toBeVisible();
	await expect(page.getByRole('heading',{name:'Aurevia TV',exact:true})).toBeVisible();
	for(const width of [320,375,390,430,768,1024,1440]){
		await page.setViewportSize({width,height:900});
		const geometry=await page.evaluate(()=>{
			const main=document.querySelector<HTMLElement>('.news-editorial-page');
			const stage=document.querySelector<HTMLElement>('.news-tv');
			const frame=document.querySelector<HTMLElement>('.news-feed-media-frame');
			if(!main||!stage||!frame)throw new Error('News layout elements are missing.');
			return {
				scrollWidth:document.documentElement.scrollWidth,
				viewportWidth:window.innerWidth,
				mainWidth:main.getBoundingClientRect().width,
				stageWidth:stage.getBoundingClientRect().width,
				frameWidth:frame.getBoundingClientRect().width,
				frameHeight:frame.getBoundingClientRect().height,
			};
		});
		expect(geometry.scrollWidth,`horizontal overflow at ${width}px`).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.mainWidth).toBeGreaterThan(Math.min(width-40,1120)*.95);
		expect(geometry.stageWidth).toBeGreaterThan(geometry.mainWidth*.95);
		expect(geometry.frameWidth).toBeGreaterThan(geometry.stageWidth*.45);
		expect(geometry.frameHeight/geometry.frameWidth).toBeCloseTo(9/16,1);
		await expect(page.locator('.news-tv-screen video')).toBeVisible();
		await expect(page.getByText('A video briefing with a readable summary.')).toBeVisible();
	}
});

test('homepage video section uses its full grid width on mobile and desktop',async({page})=>{
	await mockNewsFeed(page);
	await page.setViewportSize({width:390,height:844});
	await page.goto('/');
	const section=page.locator('.news-section');
	await section.scrollIntoViewIfNeeded();
	const stage=section.locator('.news-tv');
	await expect(stage).toBeVisible();

	for(const viewport of [{width:390,height:844},{width:412,height:915},{width:768,height:1024},{width:1440,height:900}]){
		await page.setViewportSize(viewport);
		await section.scrollIntoViewIfNeeded();
		const geometry=await page.evaluate(()=>{
			const section=document.querySelector<HTMLElement>('.news-section');
			const panel=document.querySelector<HTMLElement>('.news-section .news-feed-panel');
			const tv=document.querySelector<HTMLElement>('.news-section .news-tv');
			const screen=document.querySelector<HTMLElement>('.news-section .news-tv-screen');
			const frame=document.querySelector<HTMLElement>('.news-section .news-feed-media-frame');
			const details=document.querySelector<HTMLElement>('.news-section .news-tv-details');
			if(!section||!panel||!tv||!screen||!frame||!details)throw new Error('Homepage video layout elements are missing.');
			return {
				viewportWidth:window.innerWidth,
				scrollWidth:document.documentElement.scrollWidth,
				sectionWidth:section.getBoundingClientRect().width,
				panelWidth:panel.getBoundingClientRect().width,
				tvWidth:tv.getBoundingClientRect().width,
				screenWidth:screen.getBoundingClientRect().width,
				detailsWidth:details.getBoundingClientRect().width,
				frameWidth:frame.getBoundingClientRect().width,
				frameHeight:frame.getBoundingClientRect().height,
			};
		});
		expect(geometry.scrollWidth,`horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(geometry.viewportWidth);
		expect(geometry.panelWidth,`news panel narrowed at ${viewport.width}px`).toBeGreaterThan(geometry.sectionWidth*.9);
		expect(geometry.tvWidth,`TV stage narrowed at ${viewport.width}px`).toBeGreaterThan(geometry.panelWidth*.9);
		expect(geometry.frameWidth,`player narrowed at ${viewport.width}px`).toBeGreaterThan(geometry.screenWidth*.9);
		expect(geometry.detailsWidth).toBeGreaterThan(0);
		expect(geometry.frameHeight/geometry.frameWidth).toBeCloseTo(9/16,1);
	}
});

test('Aurevia TV keeps selected programs inside the platform',async({page})=>{
	await mockNewsFeed(page);
	await page.setViewportSize({width:1280,height:900});
	const response=await page.goto('/news');
	const contentSecurityPolicy=response?.headers()['content-security-policy']||'';
	expect(contentSecurityPolicy).toContain('https://www.youtube-nocookie.com');
	expect(contentSecurityPolicy).toContain('https://player.vimeo.com');

	const stage=page.getByRole('region',{name:'Aurevia TV'});
	await expect(stage.getByRole('heading',{name:'Aurevia market briefing video'})).toBeVisible();
	await expect(stage.getByRole('button',{name:/Market perspective from our video partners/})).toHaveAttribute('aria-pressed','false');
	await stage.getByRole('button',{name:/Market perspective from our video partners/}).click();

	await expect(stage.getByRole('heading',{name:'Market perspective from our video partners'})).toBeVisible();
	await expect(stage.getByTitle('Market perspective from our video partners video')).toBeVisible();
	await expect(stage.getByRole('button',{name:/Market perspective from our video partners/})).toHaveAttribute('aria-pressed','true');
});

test('Aurevia TV loads playable video links independently of the selected news category',async({page})=>{
	const mediaItem=items[0];
	const nonVideoItem={...mediaItem,id:'article-link',canonicalUrl:'https://example.test/article',mediaSource:null};
	const mediaRequests:string[]=[];
	await page.route(/\/api\/news-feed(?:\?|$)/,route=>{
		const url=new URL(route.request().url());
		if(url.searchParams.get('mediaOnly')==='true'){
			mediaRequests.push(url.search);
			const pageNumber=Number(url.searchParams.get('page'));
			const pageItems=pageNumber===1?[nonVideoItem]:[mediaItem];
			return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:pageItems,page:pageNumber,pageSize:30,total:2,hasMore:pageNumber===1,stale:false,lastSuccessAt:null,sources:[]})});
		}
		return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],page:1,pageSize:12,total:0,hasMore:false,stale:false,lastSuccessAt:null,sources:[]})});
	});

	await page.goto('/news');
	const stage=page.getByRole('region',{name:'Aurevia TV'});
	await expect(stage.getByRole('heading',{name:mediaItem.title})).toBeVisible();
	await expect(stage.locator('video')).toHaveAttribute('src',videoUrl);
	await page.getByLabel('Category').selectOption('ECONOMIC_NEWS');
	await expect(stage.getByRole('heading',{name:mediaItem.title})).toBeVisible();
	expect(mediaRequests.length).toBeGreaterThan(0);
	expect(mediaRequests.map(query=>new URLSearchParams(query).get('page'))).toContain('2');
});

test('direct video reports loading errors, retries, plays, pauses, mutes, fullscreen, and replays',async({page})=>{
	await mockNewsFeed(page);
	let firstVideoRequest=true;
	await page.route('**/Videos/aurevia-intro-desktop.mp4',route=>{
		if(firstVideoRequest){
			firstVideoRequest=false;
			return route.abort();
		}
		return route.continue();
	});

	await page.setViewportSize({width:390,height:844});
	await page.goto('/news');
	const player=page.getByRole('region',{name:'Aurevia TV'}).getByRole('group',{name:'Aurevia market briefing video video'});
	await expect(player.getByRole('alert')).toContainText('This video could not be loaded or played.');
	await player.getByRole('button',{name:'Retry video'}).click();

	const video=player.locator('video');
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
	await video.evaluate(element=>(element as HTMLVideoElement).pause());
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).paused)).toBe(true);
	await player.getByRole('button',{name:'Play video in player'}).click();
	await expect(player.getByRole('status')).toHaveText('Playing');
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).currentTime)).toBeGreaterThan(.2);
	await expect(player.getByRole('button',{name:'Pause video in player'})).toBeVisible();

	await player.getByRole('button',{name:'Unmute video',exact:true}).click();
	await expect(video).toHaveJSProperty('muted',false);
	await player.getByRole('button',{name:'Mute video',exact:true}).click();
	await expect(video).toHaveJSProperty('muted',true);
	await player.getByRole('button',{name:'Pause video',exact:true}).click();
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).paused)).toBe(true);

	const replaySeek=video.evaluate(element=>new Promise<boolean>(resolve=>element.addEventListener('seeked',()=>resolve((element as HTMLVideoElement).currentTime<.5),{once:true})));
	await player.getByRole('button',{name:'Replay video'}).click();
	expect(await replaySeek).toBe(true);
	await expect.poll(()=>video.evaluate(element=>(element as HTMLVideoElement).currentTime)).toBeGreaterThan(.2);
	await video.evaluate(element=>element.dispatchEvent(new Event('ended')));
	await player.getByRole('button',{name:'Replay video from beginning'}).click();
	await expect(player.getByRole('status')).toHaveText('Playing');
	await player.getByRole('button',{name:'Fullscreen video'}).click();
	await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);
	await page.keyboard.press('Escape');
});
