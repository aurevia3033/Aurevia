export type PushBrowserFeatures={
	secureContext:boolean;
	serviceWorker:boolean;
	pushManager:boolean;
	notifications:boolean;
	isIOS:boolean;
	iosVersion:{major:number;minor:number}|null;
	installed:boolean;
	permission:NotificationPermission|'unsupported';
};

export type PushBrowserIssue=
	|'secure-context-required'
	|'ios-version-unsupported'
	|'ios-install-required'
	|'service-worker-unsupported'
	|'notifications-unsupported'
	|'push-unsupported'
	|'permission-blocked'
	|null;

const CURRENT_ENDPOINT_HASH_KEY='aurevia.push-endpoint-hash.v1';

export function detectIOSDevice(userAgent:string,platform:string,maxTouchPoints:number){
	return /iPhone|iPad|iPod/i.test(userAgent)||(platform==='MacIntel'&&maxTouchPoints>1);
}

export function detectIOSVersion(userAgent:string){
	const match=userAgent.match(/(?:iPhone OS|CPU OS)\s(\d+)[._](\d+)/i);
	if(!match)return null;
	return {major:Number(match[1]),minor:Number(match[2])};
}

export function classifyPushBrowser(features:PushBrowserFeatures):PushBrowserIssue{
	if(!features.secureContext)return 'secure-context-required';
	if(features.isIOS&&features.iosVersion&&(features.iosVersion.major<16||(features.iosVersion.major===16&&features.iosVersion.minor<4)))return 'ios-version-unsupported';
	if(features.isIOS&&!features.installed)return 'ios-install-required';
	if(features.isIOS&&features.installed&&!features.iosVersion&&!features.pushManager)return 'ios-version-unsupported';
	if(!features.serviceWorker)return 'service-worker-unsupported';
	if(!features.notifications)return 'notifications-unsupported';
	if(!features.pushManager)return 'push-unsupported';
	if(features.permission==='denied')return 'permission-blocked';
	return null;
}

export function supportsBrowserPush(features:Pick<PushBrowserFeatures,'secureContext'|'serviceWorker'|'pushManager'|'notifications'>){
	return features.secureContext&&features.serviceWorker&&features.pushManager&&features.notifications;
}

export function requestPushPermission(notificationApi:Pick<typeof Notification,'permission'|'requestPermission'>){
	if(notificationApi.permission!=='default')return Promise.resolve(notificationApi.permission);
	return notificationApi.requestPermission();
}

export async function hashBrowserPushEndpoint(endpoint:string){
	const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(endpoint));
	return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export function rememberedPushEndpointHash(){
	try{
		const value=localStorage.getItem(CURRENT_ENDPOINT_HASH_KEY)||'';
		return /^[a-f0-9]{64}$/.test(value)?value:null;
	}catch(error){
		console.warn('Unable to read the current browser push device marker.',{errorName:error instanceof Error?error.name:'UnknownError'});
		return null;
	}
}

export function rememberPushEndpointHash(value:string){
	if(!/^[a-f0-9]{64}$/.test(value))return;
	try{localStorage.setItem(CURRENT_ENDPOINT_HASH_KEY,value)}
	catch(error){console.warn('Unable to remember the current browser push device marker.',{errorName:error instanceof Error?error.name:'UnknownError'})}
}

export function forgetPushEndpointHash(){
	try{localStorage.removeItem(CURRENT_ENDPOINT_HASH_KEY)}
	catch(error){console.warn('Unable to clear the current browser push device marker.',{errorName:error instanceof Error?error.name:'UnknownError'})}
}

export async function removeCurrentBrowserPushSubscription(){
	try{
		if(typeof window==='undefined'||typeof navigator==='undefined'||!('serviceWorker' in navigator)||!('PushManager' in window))return;
		const registration=await navigator.serviceWorker.getRegistration('/');
		const subscription=await registration?.pushManager.getSubscription();
		if(!subscription)return;
		try{
			const response=await fetch('/api/push/subscriptions',{
				method:'DELETE',
				headers:{'content-type':'application/json'},
				body:JSON.stringify({endpoint:subscription.endpoint}),
			});
			if(!response.ok&&response.status!==401)console.warn('Unable to remove the signed-out browser push subscription.',{status:response.status});
		}catch(error){
			console.warn('Unable to remove the signed-out browser push subscription.',{errorName:error instanceof Error?error.name:'UnknownError'});
		}
		await subscription.unsubscribe();
	}catch(error){
		console.warn('Unable to clear the signed-out browser push subscription.',{errorName:error instanceof Error?error.name:'UnknownError'});
	}finally{
		forgetPushEndpointHash();
	}
}
