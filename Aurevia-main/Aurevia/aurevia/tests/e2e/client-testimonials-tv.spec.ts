import {expect,test} from '@playwright/test';

const stories=[
	{id:'story-one',displayName:'Aurevia Client One',country:'Nigeria',cityOrRegion:'Lagos',title:'A clear experience',quote:'The first customer experience.',imageReference:null,imageUrl:null,rating:5,verifiedClientStory:false},
	{id:'story-two',displayName:'Aurevia Client Two',country:'Ghana',cityOrRegion:'Accra',title:'A helpful platform',quote:'The second customer experience.',imageReference:null,imageUrl:null,rating:4,verifiedClientStory:false},
];

test('homepage client testimonials rotate automatically and navigation controls work',async({page})=>{
	await page.emulateMedia({reducedMotion:'no-preference'});
	await page.route('**/api/client-stories',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stories)}));
	await page.goto('/');
	await expect(page.locator('.client-story-swiper .swiper-slide-active .client-story-quote')).toContainText('The first customer experience.');
	await expect(page.locator('.client-story-swiper .swiper-slide-active .client-story-monogram[aria-label="Initial for Aurevia Client One"]')).toHaveText('A');
	await expect.poll(async()=>page.locator('.client-story-swiper .swiper-slide-active .client-story-quote').innerText(),{timeout:15_000}).toContain('The second customer experience.');
	await page.getByRole('button',{name:'Previous testimonial'}).click();
	await expect(page.locator('.client-story-swiper .swiper-slide-active .client-story-quote')).toContainText('The first customer experience.');
	await page.getByRole('button',{name:'Next testimonial'}).click();
	await expect(page.locator('.client-story-swiper .swiper-slide-active .client-story-quote')).toContainText('The second customer experience.');
});

test('testimonial feed failures can be retried without reloading the homepage',async({page})=>{
	await page.emulateMedia({reducedMotion:'reduce'});
	let attempts=0;
	await page.route('**/api/client-stories',route=>{
		attempts++;
		if(attempts===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Stories temporarily unavailable.'})});
		return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stories)});
	});
	await page.goto('/');
	await expect(page.locator('.client-stories-rotator [role="alert"]')).toContainText('Stories temporarily unavailable.');
	await page.getByRole('button',{name:'Retry stories'}).click();
	await expect(page.locator('.client-story-swiper .swiper-slide-active .client-story-quote')).toContainText('The first customer experience.');
});

test('Aurevia TV rotates published client testimonies when no video programmes are available',async({page})=>{
	await page.route('**/api/news-feed**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],page:1,pageSize:12,total:0,hasMore:false,stale:false,lastSuccessAt:null,sources:[]})}));
	await page.route('**/api/client-stories',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(stories)}));
	await page.goto('/news');
	await expect(page.getByRole('region',{name:'Aurevia TV'})).toBeVisible();
	await expect(page.getByText('The first customer experience.')).toBeVisible();
	await expect(page.getByRole('img',{name:'Illustrated avatar for Aurevia Client One'})).toBeVisible();
	await page.getByRole('button',{name:'Next testimony'}).click();
	await expect(page.getByText('The second customer experience.')).toBeVisible();
});

test('Aurevia TV shows an empty state when no videos or published testimonies exist',async({page})=>{
	await page.route('**/api/news-feed**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[],page:1,pageSize:12,total:0,hasMore:false,stale:false,lastSuccessAt:null,sources:[]})}));
	await page.route('**/api/client-stories',route=>route.fulfill({status:200,contentType:'application/json',body:'[]'}));
	await page.goto('/news');
	await expect(page.getByRole('region',{name:'Aurevia TV'})).toBeVisible();
	await expect(page.getByText('No published testimonies yet')).toBeVisible();
});
