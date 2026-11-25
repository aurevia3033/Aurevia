import {test,expect} from './fixtures';

test('Aurevia loads in Chromium and reports a healthy isolated application',async({page})=>{
	const homepage=await page.goto('/');
	expect(homepage?.status()).toBe(200);
	await expect(page.locator('.home-hero h1').first()).toBeVisible();

	const health=await page.request.get('/api/health');
	expect(health.status()).toBe(200);
	await expect(health.json()).resolves.toMatchObject({
		ok:true,
		service:'aurevia-exchange',
		database:'ok',
	});
});

test('homepage hero stays visible when browser entrance animations are paused',async({page})=>{
	await page.addInitScript(()=>{
		const observer=new MutationObserver(()=>{
			if(!document.documentElement)return;
			const style=document.createElement('style');
			style.textContent='*{animation-play-state:paused!important}';
			document.documentElement.append(style);
			observer.disconnect();
		});
		observer.observe(document,{childList:true});
	});

	const homepage=await page.goto('/');
	expect(homepage?.status()).toBe(200);
	await expect(page.locator('.home-hero h1').first()).toBeVisible();
	await expect(page.locator('.home-hero-copy')).toHaveCSS('opacity','1');
});
