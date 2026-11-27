import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it,vi} from 'vitest';

function loadServiceWorker(options:{fetch?:ReturnType<typeof vi.fn>;cacheKeys?:string[];cachedResponse?:unknown;offlinePage?:unknown;pushManager?:Record<string,ReturnType<typeof vi.fn>>}={}){
	const listeners=new Map<string,(event:Record<string,unknown>)=>void>();
	const showNotification=vi.fn().mockResolvedValue(undefined);
	const cache={addAll:vi.fn().mockResolvedValue(undefined),match:vi.fn().mockResolvedValue(options.cachedResponse),put:vi.fn().mockResolvedValue(undefined)};
	const caches={open:vi.fn().mockResolvedValue(cache),keys:vi.fn().mockResolvedValue(options.cacheKeys||[]),delete:vi.fn().mockResolvedValue(true),match:vi.fn().mockResolvedValue(options.offlinePage)};
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
		expect(respondWith).toHaveBeenCalledTimes(2);
		await respondWith.mock.calls[0][0];
		await respondWith.mock.calls[1][0];
		expect(fetch).toHaveBeenCalledWith(
			expect.objectContaining({url:'https://aurevia.test/api/wallet'}),
			{cache:'no-store'},
		);
		expect(cache.addAll).not.toHaveBeenCalled();

		let response:unknown;
		handleFetch({request:{method:'GET',mode:'no-cors',url:'https://aurevia.test/icons/icon-192.png'},respondWith:(value:unknown)=>{response=value}});
		await response;
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('serves the branded offline page when a navigation cannot reach the network',async()=>{
		const offlinePage={offline:true};
		const fetch=vi.fn().mockRejectedValue(new Error('offline'));
		const {listeners,caches}=loadServiceWorker({fetch,offlinePage});
		let response:unknown;
		listeners.get('fetch')!({
			request:{method:'GET',mode:'navigate',url:'https://aurevia.test/dashboard'},
			respondWith:(value:unknown)=>{response=value},
		});
		await expect(response).resolves.toBe(offlinePage);
		expect(fetch).toHaveBeenCalledOnce();
		expect(caches.match).toHaveBeenCalledWith('/offline.html');
	});

	it('caches only explicitly public HTML pages with public response headers',async()=>{
		const cachedPage={html:true};
		const response={ok:true,headers:{get:(name:string)=>({
			'Cache-Control':'public, max-age=60',
			'Vary':'Accept-Encoding',
			'Content-Type':'text/html; charset=utf-8',
		}[name]||null)},clone:()=>cachedPage};
		const {listeners,cache}=loadServiceWorker({fetch:vi.fn().mockResolvedValue(response)});
		const waitUntil=vi.fn();
		let aboutResponse:unknown;
		listeners.get('fetch')!({
			request:{method:'GET',mode:'navigate',url:'https://aurevia.test/about'},
			waitUntil,
			respondWith:(value:unknown)=>{aboutResponse=value},
		});
		await aboutResponse;
		expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({url:'https://aurevia.test/about'}),cachedPage);

		let dashboardResponse:unknown;
		listeners.get('fetch')!({
			request:{method:'GET',mode:'navigate',url:'https://aurevia.test/dashboard'},
			waitUntil,
			respondWith:(value:unknown)=>{dashboardResponse=value},
		});
		await dashboardResponse;
		expect(cache.put).toHaveBeenCalledOnce();
	});

	it('serves cached static assets immediately while refreshing them in the background',async()=>{
		const cachedResponse={version:1};
		const updatedResponse={ok:true,headers:{get:()=> 'public, max-age=31536000'},clone:()=>({version:2})};
		const {listeners,cache}=loadServiceWorker({
			cachedResponse,
			fetch:vi.fn().mockResolvedValue(updatedResponse),
		});
		let served:unknown;
		let refresh:Promise<unknown>|undefined;
		listeners.get('fetch')!({
			request:{method:'GET',mode:'same-origin',url:'https://aurevia.test/_next/static/chunks/app.js'},
			waitUntil:(value:unknown)=>{refresh=value as Promise<unknown>},
			respondWith:(value:unknown)=>{served=value},
		});
		await expect(served).resolves.toBe(cachedResponse);
		await refresh;
		expect(cache.put).toHaveBeenCalledWith(
			expect.objectContaining({url:'https://aurevia.test/_next/static/chunks/app.js'}),
			{version:2},
		);
	});

	it('only seeds public static assets and caches eligible versioned assets',async()=>{
		const response={ok:true,headers:{get:()=> 'public, max-age=31536000'},clone:()=>({staticAsset:true})};
		const {listeners,cache}=loadServiceWorker({fetch:vi.fn().mockResolvedValue(response)});
		let installation:Promise<unknown>|undefined;
		listeners.get('install')!({waitUntil:(value:unknown)=>{installation=value as Promise<unknown>}});
		await installation;
		expect(cache.addAll).toHaveBeenCalledWith(['/offline.html','/manifest.webmanifest','/aurevia-logo.png','/icons/icon-192.png','/icons/icon-512.png']);

		let cachedResponse:unknown;
		listeners.get('fetch')!({request:{method:'GET',mode:'same-origin',url:'https://aurevia.test/_next/static/chunks/app.js'},waitUntil:vi.fn(),respondWith:(value:unknown)=>{cachedResponse=value}});
		await cachedResponse;
		expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({url:'https://aurevia.test/_next/static/chunks/app.js'}),{staticAsset:true});
	});

	it('does not activate an update until the user confirms and validates the PWA manifest',async()=>{
		const {listeners,self}=loadServiceWorker();
		const manifest=JSON.parse(readFileSync('public/manifest.webmanifest','utf8')) as Record<string,unknown>;
		expect(manifest).toMatchObject({name:'Aurevia Exchange',short_name:'Aurevia',start_url:'/',display:'standalone',theme_color:'#07110D'});
		expect(manifest.icons).toHaveLength(2);
		let installation:Promise<unknown>|undefined;
		listeners.get('install')!({waitUntil:(value:unknown)=>{installation=value as Promise<unknown>}});
		await installation;
		expect(self.skipWaiting).not.toHaveBeenCalled();
		const waitUntil=vi.fn();
		listeners.get('message')!({data:{type:'AUREVIA_SKIP_WAITING'},waitUntil});
		await waitUntil.mock.calls[0][0];
		expect(self.skipWaiting).toHaveBeenCalledOnce();
	});

	it('pre-caches only safe same-origin app assets and excludes API URLs',async()=>{
		const response={ok:true,headers:{get:()=> 'public, max-age=60'},clone:()=>({asset:true})};
		const fetch=vi.fn().mockResolvedValue(response);
		const {listeners,cache}=loadServiceWorker({fetch});
		const waitUntil=vi.fn();
		listeners.get('message')!({
			data:{type:'AUREVIA_CACHE_ASSETS',urls:[
				'https://aurevia.test/_next/static/app.css',
				'/icons/icon-192.png',
				'/api/wallet',
				'https://other.test/image.png',
			]},
			waitUntil,
		});
		await waitUntil.mock.calls[0][0];
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(cache.put).toHaveBeenCalledTimes(2);
		expect(cache.put).toHaveBeenCalledWith('https://aurevia.test/_next/static/app.css',{asset:true});
		expect(cache.put).toHaveBeenCalledWith('https://aurevia.test/icons/icon-192.png',{asset:true});
	});

	it('deletes only obsolete Aurevia caches when the worker activates',async()=>{
		const {listeners,caches,self}=loadServiceWorker({cacheKeys:['aurevia-static-v1','aurevia-static-v2','next-cache','other-app-cache','aurevia-static-v3','aurevia-static-v4']});
		let activation:Promise<unknown>|undefined;
		listeners.get('activate')!({waitUntil:(value:unknown)=>{activation=value as Promise<unknown>}});
		await activation;
		expect(caches.delete).toHaveBeenCalledTimes(4);
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v1');
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v2');
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v3');
		expect(caches.delete).toHaveBeenCalledWith('aurevia-static-v4');
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
