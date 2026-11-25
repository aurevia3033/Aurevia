import {describe,expect,it,vi} from 'vitest';
import {classifyPushBrowser,detectIOSDevice,detectIOSVersion,removeCurrentBrowserPushSubscription,requestPushPermission,supportsBrowserPush} from '@/lib/push-browser';

describe('browser push capability and permission behavior',()=>{
	it('requires HTTPS and all browser push APIs',()=>{
		expect(supportsBrowserPush({secureContext:true,serviceWorker:true,pushManager:true,notifications:true})).toBe(true);
		expect(supportsBrowserPush({secureContext:false,serviceWorker:true,pushManager:true,notifications:true})).toBe(false);
		expect(supportsBrowserPush({secureContext:true,serviceWorker:false,pushManager:true,notifications:true})).toBe(false);
		expect(supportsBrowserPush({secureContext:true,serviceWorker:true,pushManager:false,notifications:true})).toBe(false);
		expect(supportsBrowserPush({secureContext:true,serviceWorker:true,pushManager:true,notifications:false})).toBe(false);
	});

	it('requests permission only from the default state and never reprompts after denial',async()=>{
		const requestPermission=vi.fn().mockResolvedValue('granted');
		await expect(requestPushPermission({permission:'default',requestPermission})).resolves.toBe('granted');
		expect(requestPermission).toHaveBeenCalledOnce();
		await expect(requestPushPermission({permission:'denied',requestPermission})).resolves.toBe('denied');
		await expect(requestPushPermission({permission:'granted',requestPermission})).resolves.toBe('granted');
		expect(requestPermission).toHaveBeenCalledOnce();
	});

	it('distinguishes secure context, iOS installation, and unsupported iOS versions',()=>{
		const supported={secureContext:true,serviceWorker:true,pushManager:true,notifications:true,isIOS:false,iosVersion:null,installed:false,permission:'default' as const};
		expect(classifyPushBrowser({...supported,secureContext:false})).toBe('secure-context-required');
		expect(detectIOSDevice('Mozilla/5.0 (iPhone)','iPhone',0)).toBe(true);
		expect(detectIOSDevice('Mozilla/5.0 (Macintosh)','MacIntel',5)).toBe(true);
		expect(detectIOSDevice('Mozilla/5.0 (Macintosh)','MacIntel',0)).toBe(false);
		expect(detectIOSVersion('Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X)')).toEqual({major:16,minor:3});
		expect(classifyPushBrowser({...supported,isIOS:true,iosVersion:{major:16,minor:3},installed:true})).toBe('ios-version-unsupported');
		expect(classifyPushBrowser({...supported,isIOS:true,iosVersion:{major:16,minor:4}})).toBe('ios-install-required');
		expect(classifyPushBrowser({...supported,isIOS:true,iosVersion:{major:17,minor:0},installed:true})).toBeNull();
		expect(classifyPushBrowser({...supported,isIOS:true,iosVersion:null,installed:true,pushManager:false})).toBe('ios-version-unsupported');
	});

	it('reports missing browser APIs and blocked permission independently',()=>{
		const supported={secureContext:true,serviceWorker:true,pushManager:true,notifications:true,isIOS:false,iosVersion:null,installed:false,permission:'default' as const};
		expect(classifyPushBrowser({...supported,serviceWorker:false})).toBe('service-worker-unsupported');
		expect(classifyPushBrowser({...supported,notifications:false})).toBe('notifications-unsupported');
		expect(classifyPushBrowser({...supported,pushManager:false})).toBe('push-unsupported');
		expect(classifyPushBrowser({...supported,permission:'denied'})).toBe('permission-blocked');
	});

	it('unsubscribes this device even when logout cleanup is no longer authorized',async()=>{
		const unsubscribe=vi.fn().mockResolvedValue(true);
		const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/device-token',unsubscribe};
		const getSubscription=vi.fn().mockResolvedValue(subscription);
		const getRegistration=vi.fn().mockResolvedValue({pushManager:{getSubscription}});
		const fetch=vi.fn().mockResolvedValue({ok:false,status:401});
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
		vi.stubGlobal('window',{PushManager:class {}});
		vi.stubGlobal('navigator',{serviceWorker:{getRegistration}});
		vi.stubGlobal('fetch',fetch);
		try{
			await removeCurrentBrowserPushSubscription();
			expect(fetch).toHaveBeenCalledWith('/api/push/subscriptions',expect.objectContaining({method:'DELETE',body:JSON.stringify({endpoint:subscription.endpoint})}));
			expect(unsubscribe).toHaveBeenCalledOnce();
		}finally{
			vi.unstubAllGlobals();
			warning.mockRestore();
		}
	});
});
