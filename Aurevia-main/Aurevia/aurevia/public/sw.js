'use strict';

const CACHE_NAME='aurevia-static-v5';
const CACHE_PREFIX='aurevia-static-';
const APP_SHELL=['/offline.html','/manifest.webmanifest','/aurevia-logo.png','/icons/icon-192.png','/icons/icon-512.png'];
const PUBLIC_PAGES=new Set(['/about','/education']);
const fallback={title:'Aurevia Exchange',body:'There is a new update to your account.',url:'/dashboard'};

function isSafeStaticAsset(url){
	if(url.pathname==='/manifest.webmanifest'||url.pathname==='/aurevia-logo.png')return true;
	if(url.pathname.startsWith('/icons/'))return /\.(?:png|svg|webp|ico)$/.test(url.pathname);
	return (url.pathname.startsWith('/_next/static/')||url.pathname.startsWith('/images/')||url.pathname.startsWith('/fonts/'))
		&&/\.(?:css|woff2?|ttf|otf|eot|png|jpe?g|webp|svg|ico|js)$/.test(url.pathname);
}

self.addEventListener('install',event=>{
	event.waitUntil((async()=>{
		const cache=await caches.open(CACHE_NAME);
		await cache.addAll(APP_SHELL);
	})());
});

self.addEventListener('activate',event=>{
	event.waitUntil((async()=>{
		const keys=await caches.keys();
		await Promise.all(keys.filter(key=>key.startsWith(CACHE_PREFIX)&&key!==CACHE_NAME).map(key=>caches.delete(key)));
		await self.clients.claim();
	})());
});

self.addEventListener('message',event=>{
	if(event.data?.type==='AUREVIA_SKIP_WAITING'){
		event.waitUntil(self.skipWaiting());
		return;
	}
	if(event.data?.type==='AUREVIA_CACHE_ASSETS'&&Array.isArray(event.data.urls)){
		event.waitUntil((async()=>{
			const cache=await caches.open(CACHE_NAME);
			const urls=event.data.urls.slice(0,100);
			await Promise.all(urls.map(async candidate=>{
				if(typeof candidate!=='string')return;
				const url=new URL(candidate,self.location.origin);
				if(url.origin!==self.location.origin||!isSafeStaticAsset(url))return;
				try{
					const response=await fetch(url.href,{cache:'no-store',credentials:'same-origin'});
					const cacheControl=response.headers.get('Cache-Control')||'';
					if(response.ok&&!/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)){
						await cache.put(url.href,response.clone());
					}
				}catch(error){
					console.warn('Unable to pre-cache a static Aurevia resource.',{errorName:error instanceof Error?error.name:'UnknownError'});
				}
			}));
		})());
	}
});

self.addEventListener('fetch',event=>{
	const request=event.request;
	if(request.method!=='GET')return;
	const url=new URL(request.url);
	if(url.origin!==self.location.origin)return;
	if(url.pathname.startsWith('/api/')){
		event.respondWith(fetch(request,{cache:'no-store'}));
		return;
	}
	if(request.mode==='navigate'){
		event.respondWith((async()=>{
			const cache=await caches.open(CACHE_NAME);
			try{
				const response=await fetch(request);
				const cacheControl=response.headers.get('Cache-Control')||'';
				const vary=response.headers.get('Vary')||'';
				if(PUBLIC_PAGES.has(url.pathname)&&!url.search&&response.ok
					&&/\bpublic\b/i.test(cacheControl)
					&&!/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)
					&&!/\bcookie\b/i.test(vary)
					&&(response.headers.get('Content-Type')||'').includes('text/html')){
					await cache.put(request,response.clone());
				}
				return response;
			}catch{
				const cachedPage=PUBLIC_PAGES.has(url.pathname)&&!url.search?await cache.match(request):undefined;
				if(cachedPage)return cachedPage;
				const offlinePage=await caches.match('/offline.html');
				return offlinePage||Response.error();
			}
		})());
		return;
	}
	if(!isSafeStaticAsset(url))return;
	event.respondWith((async()=>{
		const cache=await caches.open(CACHE_NAME);
		const cached=await cache.match(request);
		if(cached){
			const refresh=fetch(request).then(async response=>{
				const cacheControl=response.headers.get('Cache-Control')||'';
				if(response.ok&&!/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)){
					await cache.put(request,response.clone());
				}
			}).catch(()=>undefined);
			event.waitUntil(refresh);
			return cached;
		}
		try{
			const response=await fetch(request);
			const cacheControl=response.headers.get('Cache-Control')||'';
			if(response.ok&&!/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)){
				await cache.put(request,response.clone());
			}
			return response;
		}catch{
			return cached||Response.error();
		}
	})());
});

self.addEventListener('push',event=>{
	let payload=fallback;
	try{
		const parsed=event.data?.json();
		if(parsed&&typeof parsed==='object'){
			payload={
				title:typeof parsed.title==='string'?parsed.title.slice(0,80):fallback.title,
				body:typeof parsed.body==='string'?parsed.body.slice(0,180):fallback.body,
				url:typeof parsed.url==='string'&&parsed.url.startsWith('/')&&!parsed.url.startsWith('//')?parsed.url:fallback.url,
				tag:typeof parsed.tag==='string'&&/^aurevia-[a-f0-9]{16}$/.test(parsed.tag)?parsed.tag:undefined,
			};
		}
	}catch{
		payload=fallback;
	}
	event.waitUntil(self.registration.showNotification(payload.title,{
		body:payload.body,
		icon:'/aurevia-logo.png',
		badge:'/aurevia-logo.png',
		tag:payload.tag,
		renotify:false,
		data:{url:payload.url},
	}));
});

self.addEventListener('pushsubscriptionchange',event=>{
	const renewal=(async()=>{
		let subscription=event.newSubscription;
		if(!subscription){
			const statusResponse=await fetch('/api/push/subscriptions',{cache:'no-store',credentials:'same-origin'});
			if(!statusResponse.ok)throw new Error('PUSH_STATUS_UNAVAILABLE');
			const status=await statusResponse.json();
			if(!status.available||typeof status.publicKey!=='string')return;
			const base64=status.publicKey.replaceAll('-','+').replaceAll('_','/');
			const padded=base64.padEnd(Math.ceil(base64.length/4)*4,'=');
			const applicationServerKey=Uint8Array.from(atob(padded),character=>character.charCodeAt(0));
			subscription=await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey});
		}
		const saved=await fetch('/api/push/subscriptions',{
			method:'POST',
			cache:'no-store',
			credentials:'same-origin',
			headers:{'content-type':'application/json'},
			body:JSON.stringify(subscription.toJSON()),
		});
		if(!saved.ok)throw new Error('PUSH_SUBSCRIPTION_UPDATE_FAILED');
		const oldEndpoint=event.oldSubscription?.endpoint;
		if(oldEndpoint&&oldEndpoint!==subscription.endpoint){
			const removed=await fetch('/api/push/subscriptions',{
				method:'DELETE',
				cache:'no-store',
				credentials:'same-origin',
				headers:{'content-type':'application/json'},
				body:JSON.stringify({endpoint:oldEndpoint}),
			});
			if(!removed.ok)throw new Error('PUSH_OLD_SUBSCRIPTION_REMOVE_FAILED');
		}
	})();
	event.waitUntil(renewal.catch(error=>{
		console.error('Push subscription renewal failed.',{errorCode:error instanceof Error?error.message:'UnknownError'});
	}));
});

self.addEventListener('notificationclick',event=>{
	event.notification.close();
	const requested=event.notification.data?.url;
	const path=typeof requested==='string'&&requested.startsWith('/')&&!requested.startsWith('//')?requested:'/dashboard';
	const target=new URL(`/api/push/redirect?to=${encodeURIComponent(path)}`,self.location.origin).href;
	event.waitUntil((async()=>{
		const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
		for(const windowClient of windows){
			if(new URL(windowClient.url).origin!==self.location.origin)continue;
			const navigated=await windowClient.navigate(target);
			if(navigated){await navigated.focus();return}
		}
		await self.clients.openWindow(target);
	})());
});
