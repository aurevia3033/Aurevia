import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

function loadServiceWorker(options:{fetch?:ReturnType<typeof vi.fn>;cacheKeys?:string[];pushManager?:Record<string,ReturnType<typeof vi.fn>>}={}){
	const listeners=new Map<string,(event:Record<string,unknown>)=>void>();
	const showNotification=vi.fn().mockResolvedValue(undefined);
	const cache={addAll:vi.fn().mockResolvedValue(undefined),match:vi.fn().mockResolvedValue(undefined),put:vi.fn().mockResolvedValue(undefined)};
	const caches={open:vi.fn().mockResolvedValue(cache),keys:vi.fn().mockResolvedValue(options.cacheKeys||[]),delete:vi.fn().mockResolvedValue(true),match:vi.fn().mockResolvedValue(undefined)};
	const self={
		location:{origin:'https://aurevia.test'},
		registration:{showNotification,pushManager:options.pushManager},
		skipWaiting:vi.fn().mockResolvedValue(undefined),
		clients:{claim:vi.fn().mockResolvedValue(undefined),matchAll:vi.fn().mockResolvedValue([]),openWindow:vi.fn()},
		addEventListener:(name:string,callback:(event:Record<string,unknown>)=>void)=>listeners.set(name,callback),
	};
	const fetch=options.fetch||vi.fn();
	runInNewContext(readFileSync('public/sw.js','utf8'),{self,URL,Promise,caches,fetch,Response,Uint8Array,atob});
	return {listeners,showNotification,cache,caches,self,fetch};
}

describe('Aurevia browser push service worker',()=>{
	it('shows concise branded notifications and safely falls back on malformed payloads',async()=>{
		const {listeners,showNotification}=loadServiceWorker();
		const validWait=vi.fn();
		listeners.get('push')!({data:{json:()=>({title:'Aurevia Exchange',body:'An account update.',url:'/wallet',tag:'aurevia-0123456789abcdef'})},waitUntil:validWait});
		await validWait.mock.calls[0][0];
		expect(showNotification).toHaveBeenCalledWith('Aurevia Exchange',expect.objectContaining({body:'An account update.',data:{url:'/wallet'},tag:'aurevia-0123456789abcdef',renotify:false,icon:'/aurevia-logo.png'}));
		const invalidWait=vi.fn();
		listeners.get('push')!({data:{json:()=>{throw new Error('bad payload')}},waitUntil:invalidWait});
		await invalidWait.mock.calls[0][0];
		expect(showNotification).toHaveBeenLastCalledWith('Aurevia Exchange',expect.objectContaining({body:'There is a new update to your account.'}));
	});

	it('routes notification clicks through the authenticated redirect endpoint',async()=>{
		const navigate=vi.fn().mockResolvedValue({focus:vi.fn()});
		const openWindow=vi.fn();
		const matchAll=vi.fn().mockResolvedValue([{url:'https://aurevia.test/dashboard',navigate}]);
		const listeners=new Map<string,(event:Record<string,unknown>)=>void>();
		const self={
			location:{origin:'https://aurevia.test'},
			registration:{showNotification:vi.fn()},
			clients:{matchAll,openWindow},
			addEventListener:(name:string,callback:(event:Record<string,unknown>)=>void)=>listeners.set(name,callback),
		};
		runInNewContext(readFileSync('public/sw.js','utf8'),{self,URL,Promise});
		const close=vi.fn(),waitUntil=vi.fn();
		listeners.get('notificationclick')!({notification:{data:{url:'/wallet/transactions'},close},waitUntil});
		await waitUntil.mock.calls[0][0];
		expect(close).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith('https://aurevia.test/api/push/redirect?to=%2Fwallet%2Ftransactions');
		expect(openWindow).not.toHaveBeenCalled();
	});

	it('does not cache authenticated navigations or private static responses',async()=>{
		const fetch=vi.fn(async()=>({ok:true,headers:{get:()=> 'private, no-store'},clone:()=>({})}));
		const {listeners,cache}=loadServiceWorker({fetch});
		const handleFetch=listeners.get('fetch')!;
		const respondWith=vi.fn();
		handleFetch({request:{method:'GET',mode:'navigate',url:'https://aurevia.test/dashboard'},respondWith});
		handleFetch({request:{method:'GET',mode:'cors',url:'https://aurevia.test/api/wallet'},respondWith});
		expect(respondWith).not.toHaveBeenCalled();
		expect(cache.addAll).not.toHaveBeenCalled();

		let response:unknown;
		handleFetch({request:{method:'GET',mode:'no-cors',url:'https://aurevia.test/icons/icon-192.png'},respondWith:(value:unknown)=>{response=value}});
		await response;
		expect(fetch).toHaveBeenCalledOnce();
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('only seeds public static assets and caches eligible versioned assets',async()=>{
		const response={ok:true,headers:{get:()=> 'public, max-age=31536000'},clone:()=>({staticAsset:true})};
		const {listeners,cache}=loadServiceWorker({fetch:vi.fn().mockResolvedValue(response)});
		let installation:Promise<unknown>|undefined;
		listeners.get('install')!({waitUntil:(value:unknown)=>{installation=value as Promise<unknown>}});
		await installation;
		expect(cache.addAll).toHaveBeenCalledWith(['/manifest.webmanifest','/aurevia-logo.png','/icons/icon-192.png','/icons/icon-512.png']);

		let cachedResponse:unknown;
		listeners.get('fetch')!({request:{method:'GET',mode:'same-origin',url:'https://aurevia.test/_next/static/chunks/app.js'},respondWith:(value:unknown)=>{cachedResponse=value}});
		await cachedResponse;
		expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({url:'https://aurevia.test/_next/static/chunks/app.js'}),{staticAsset:true});
	});

	it('deletes only obsolete Aurevia caches when the worker activates',async()=>{
		const {listeners,caches,self}=loadServiceWorker({cacheKeys:['aurevia-static-v1','aurevia-static-v2','next-cache','other-app-cache','aurevia-static-v3']});
		let activation:Promise<unknown>|undefined;
		listeners.get('activate')!({waitUntil:(value:unknown)=>{activation=value as Promise<unknown>}});
		await activation;
		expect(caches.delete).toHaveBeenCalledTimes(2);
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v1');
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v2');
		expect(self.clients.claim).toHaveBeenCalledOnce();
	});

	it('replaces an expired push subscription before removing its old endpoint',async()=>{
		const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/new',toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/new',keys:{p256dh:'key',auth:'key'}})};
		const fetch=vi.fn().mockResolvedValue({ok:true});
		const pushManager={subscribe:vi.fn()};
		const {listeners}=loadServiceWorker({fetch,pushManager});
		let update:Promise<unknown>|undefined;
		listeners.get('pushsubscriptionchange')!({
			newSubscription:subscription,
			oldSubscription:{endpoint:'https://fcm.googleapis.com/fcm/send/old'},
			waitUntil:(value:unknown)=>{update=value as Promise<unknown>},
		});
		await update;
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0][1]).toMatchObject({method:'POST',credentials:'same-origin'});
		expect(fetch.mock.calls[1][1]).toMatchObject({method:'DELETE',credentials:'same-origin'});
		expect(pushManager.subscribe).not.toHaveBeenCalled();
	});

	it('renews an empty subscription from the authenticated server configuration',async()=>{
		const replacement={endpoint:'https://fcm.googleapis.com/fcm/send/renewed',toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/renewed',keys:{p256dh:'key',auth:'key'}})};
		const pushManager={subscribe:vi.fn().mockResolvedValue(replacement)};
		const fetch=vi.fn()
			.mockResolvedValueOnce({ok:true,json:async()=>({available:true,publicKey:'AQAB'})})
			.mockResolvedValueOnce({ok:true});
		const {listeners}=loadServiceWorker({fetch,pushManager});
		let update:Promise<unknown>|undefined;
		listeners.get('pushsubscriptionchange')!({
			newSubscription:null,
			oldSubscription:null,
			waitUntil:(value:unknown)=>{update=value as Promise<unknown>},
		});
		await update;
		expect(pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({userVisibleOnly:true,applicationServerKey:expect.any(Uint8Array)}));
		expect(fetch).toHaveBeenLastCalledWith('/api/push/subscriptions',expect.objectContaining({method:'POST'}));
	});
});
