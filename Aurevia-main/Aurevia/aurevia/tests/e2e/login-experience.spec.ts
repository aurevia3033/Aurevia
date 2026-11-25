import {expect,test} from '@playwright/test';

test('sign-in experience remains responsive and exposes the existing account controls',async({page})=>{
	await page.emulateMedia({reducedMotion:'reduce'});
	await page.goto('/login');
	const card=page.locator('.auth-signin-card');
	await expect(card.getByRole('heading',{name:'Welcome back'})).toBeVisible();
	await expect(card.getByLabel('Email address')).toBeVisible();
	await expect(card.getByLabel('Password',{exact:true})).toBeVisible();
	await expect(card.getByRole('checkbox',{name:'Remember my email on this device'})).toBeVisible();
	await expect(card.getByRole('link',{name:'Forgot password?'})).toHaveAttribute('href','/forgot-password');
	await expect(card.getByRole('link',{name:'Create an account'})).toHaveAttribute('href','/register');

	for(const width of [320,375,390,430,768,1024,1440,1920]){
		await page.setViewportSize({width,height:width<600?844:900});
		expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`horizontal overflow at ${width}px`).toBe(true);
	}
});
