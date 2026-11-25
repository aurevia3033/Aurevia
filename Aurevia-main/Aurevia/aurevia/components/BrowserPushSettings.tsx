'use client';

import {useEffect,useState} from 'react';
import {Bell,Check,LoaderCircle,ShieldCheck} from 'lucide-react';
import {classifyPushBrowser,detectIOSDevice,detectIOSVersion,forgetPushEndpointHash,hashBrowserPushEndpoint,rememberedPushEndpointHash,rememberPushEndpointHash,requestPushPermission,supportsBrowserPush,type PushBrowserFeatures,type PushBrowserIssue} from '@/lib/push-browser';

type Preferences={accountActivity:boolean;investmentUpdates:boolean;announcements:boolean};
type PushDevice={id:string;createdAt:string;expiresAt:string|null;lastDeliveredAt:string|null;isCurrentDevice:boolean};
type PushStatus={
	available:boolean;
	publicKey:string|null;
	subscriptionCount:number;
	devices:PushDevice[];
	preferences:Preferences;
};

const defaultPreferences:Preferences={accountActivity:true,investmentUpdates:true,announcements:false};

function decodePublicKey(value:string){
	const base64=value.replaceAll('-','+').replaceAll('_','/');
	const padded=base64.padEnd(Math.ceil(base64.length/4)*4,'=');
	return Uint8Array.from(atob(padded),character=>character.charCodeAt(0));
}

function detectBrowserFeatures():PushBrowserFeatures{
	const userAgent=navigator.userAgent;
	const permission=typeof Notification==='undefined'?'unsupported':Notification.permission;
	return {
		secureContext:window.isSecureContext,
		serviceWorker:'serviceWorker' in navigator,
		pushManager:'PushManager' in window,
		notifications:'Notification' in window,
		isIOS:detectIOSDevice(userAgent,navigator.platform,navigator.maxTouchPoints),
		iosVersion:detectIOSVersion(userAgent),
		installed:window.matchMedia?.('(display-mode: standalone), (display-mode: minimal-ui), (display-mode: fullscreen)').matches===true
			||('standalone' in navigator&&(navigator as Navigator&{standalone?:boolean}).standalone===true),
		permission,
	};
}

async function readResponse(response:Response){
	const result=await response.json();
	if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'Unable to update browser notifications.');
	return result;
}

async function loadPushStatus(subscription:PushSubscription|null){
	let endpointHash=rememberedPushEndpointHash();
	if(subscription){
		try{
			endpointHash=await hashBrowserPushEndpoint(subscription.endpoint);
			rememberPushEndpointHash(endpointHash);
		}catch(error){
			console.warn('Unable to identify the current browser push device.',{errorName:error instanceof Error?error.name:'UnknownError'});
		}
	}
	const headers=new Headers();
	if(endpointHash)headers.set('x-aurevia-current-endpoint-hash',endpointHash);
	const response=await fetch('/api/push/subscriptions',{headers,cache:'no-store'});
	return await readResponse(response) as PushStatus;
}

function issueMessage(issue:PushBrowserIssue){
	switch(issue){
		case 'secure-context-required':return 'Browser push needs a secure HTTPS connection. Open Aurevia using its HTTPS address.';
		case 'ios-version-unsupported':return 'Web Push requires iOS or iPadOS 16.4 or newer. Update your device, then add Aurevia to your Home Screen and open it there.';
		case 'ios-install-required':return 'On iPhone and iPad, Web Push is available only after Aurevia is added to the Home Screen and opened as an app.';
		case 'service-worker-unsupported':return 'System push is unavailable here because this browser cannot run background workers. In-app alerts and notification history remain available while you are signed in.';
		case 'notifications-unsupported':return 'System notifications are unavailable in this environment. In-app alerts and notification history remain available while you are signed in.';
		case 'push-unsupported':return 'Background push is unavailable in this environment. In-app alerts and notification history remain available while you are signed in.';
		case 'permission-blocked':return 'Permission is blocked. Aurevia cannot prompt again; change notification permission in your browser or device settings first.';
		default:return null;
	}
}

function formatDeviceDate(value:string|null){
	if(!value)return 'No successful push send recorded';
	const date=new Date(value);
	return Number.isFinite(date.getTime())?date.toLocaleString():'Date unavailable';
}

export default function BrowserPushSettings(){
	const [status,setStatus]=useState<PushStatus|null>(null);
	const [features,setFeatures]=useState<PushBrowserFeatures|null>(null);
	const [localSubscription,setLocalSubscription]=useState<PushSubscription|null>(null);
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);
	const [serviceWorkerError,setServiceWorkerError]=useState('');
	const [subscriptionError,setSubscriptionError]=useState(false);
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');

	useEffect(()=>{
		let active=true;
		const initialize=async()=>{
			const detected=detectBrowserFeatures();
			if(!active)return;
			setFeatures(detected);
			try{
				let subscription:PushSubscription|null=null;
				const mayRegister=detected.secureContext&&detected.serviceWorker&&(!detected.isIOS||detected.installed);
				if(mayRegister){
					try{
						const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
						subscription=await registration.pushManager.getSubscription();
					}catch(exception){
						if(active)setServiceWorkerError(exception instanceof Error?exception.message:'Service worker registration failed.');
					}
				}
				const data=await loadPushStatus(subscription);
				if(!active)return;
				setStatus(data);
				setLocalSubscription(subscription);
			}catch(exception){
				if(active)setError(exception instanceof Error?exception.message:'Unable to load browser notification settings.');
			}finally{if(active)setLoading(false)}
		};
		void initialize();
		return()=>{active=false};
	},[]);

	useEffect(()=>{
		let active=true;
		const refresh=async()=>{
			if(typeof Notification!=='undefined'){
				setFeatures(current=>current?{...current,permission:Notification.permission}:current);
			}
			if(!('serviceWorker' in navigator)||!('PushManager' in window))return;
			try{
				const registration=await navigator.serviceWorker.getRegistration('/');
				const subscription=await registration?.pushManager.getSubscription()||null;
				if(!active)return;
				setLocalSubscription(subscription);
				setStatus(await loadPushStatus(subscription));
			}catch(exception){
				if(active)console.warn('Unable to refresh browser push device status.',{errorName:exception instanceof Error?exception.name:'UnknownError'});
			}
		};
		const onFocus=()=>{void refresh()};
		const onVisibilityChange=()=>{if(document.visibilityState==='visible')void refresh()};
		window.addEventListener('focus',onFocus);
		document.addEventListener('visibilitychange',onVisibilityChange);
		return()=>{
			active=false;
			window.removeEventListener('focus',onFocus);
			document.removeEventListener('visibilitychange',onVisibilityChange);
		};
	},[]);

	const issue=features?classifyPushBrowser(features):null;
	const supported=Boolean(features&&supportsBrowserPush(features)&&(!features.isIOS||features.installed)&&issue!=='ios-version-unsupported');

	async function updatePreferences(next:Partial<Preferences>){
		if(!status)return;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/push/preferences',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(next)});
			const result=await readResponse(response) as {preferences:Preferences};
			setStatus({...status,preferences:result.preferences});
			setMessage('Notification preferences saved.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save notification preferences.')}
		finally{setBusy(false)}
	}

	async function enable(){
		if(!status?.available||!status.publicKey||!features||!supported||busy)return;
		setBusy(true);setError('');setMessage('');setServiceWorkerError('');setSubscriptionError(false);
		try{
			let nextPermission=features.permission;
			if(nextPermission==='default')nextPermission=await requestPushPermission(Notification);
			if(nextPermission==='unsupported')return;
			setFeatures({...features,permission:nextPermission});
			if(nextPermission==='denied')return;
			if(nextPermission!=='granted'){
				setMessage('Notification permission was not granted. You can try again when ready.');
				return;
			}
			let registration:ServiceWorkerRegistration;
			try{registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'})}
			catch(exception){
				setServiceWorkerError(exception instanceof Error?exception.message:'Service worker registration failed.');
				return;
			}
			let subscription:PushSubscription;
			try{
				const existing=await registration.pushManager.getSubscription();
				subscription=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decodePublicKey(status.publicKey)});
			}catch{
				setSubscriptionError(true);
				return;
			}
			const saved=await fetch('/api/push/subscriptions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(subscription.toJSON())});
			await readResponse(saved);
			const preferences=await fetch('/api/push/preferences',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({accountActivity:true,investmentUpdates:true})});
			const preferenceResult=await readResponse(preferences) as {preferences:Preferences};
			setLocalSubscription(subscription);
			const refreshed=await loadPushStatus(subscription);
			setStatus({...refreshed,preferences:preferenceResult.preferences});
			setMessage('Notifications are enabled on this device.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to enable browser notifications.')}
		finally{setBusy(false)}
	}

	async function disable(){
		if(!status||busy)return;
		setBusy(true);setError('');setMessage('');
		try{
			const preferences=await fetch('/api/push/preferences',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({accountActivity:false,investmentUpdates:false,announcements:false})});
			const preferenceResult=await readResponse(preferences) as {preferences:Preferences};
			const currentDevice=status.devices.find(device=>device.isCurrentDevice);
			if(localSubscription||currentDevice){
				const removed=await fetch('/api/push/subscriptions',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(localSubscription?{endpoint:localSubscription.endpoint}:{id:currentDevice!.id})});
				await readResponse(removed);
				if(localSubscription)await localSubscription.unsubscribe();
			}
			forgetPushEndpointHash();
			setLocalSubscription(null);
			const refreshed=await loadPushStatus(null);
			setStatus({...refreshed,preferences:preferenceResult.preferences});
			setMessage('Browser notifications are disabled for this account.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to disable browser notifications.')}
		finally{setBusy(false)}
	}

	async function removeDevice(device:PushDevice){
		if(busy)return;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/push/subscriptions',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({id:device.id})});
			await readResponse(response);
			const isCurrent=localSubscription&&device.isCurrentDevice;
			if(isCurrent)await localSubscription.unsubscribe();
			if(device.isCurrentDevice){
				forgetPushEndpointHash();
				setLocalSubscription(null);
			}
			const refreshed=await loadPushStatus(isCurrent?null:localSubscription);
			setStatus(refreshed);
			setMessage(device.isCurrentDevice?'This device was removed from push notifications.':'The device was removed from push notifications.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to remove this device.')}
		finally{setBusy(false)}
	}

	async function sendTest(){
		if(busy)return;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/push/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint:localSubscription?.endpoint})});
			const result=await readResponse(response) as {message:string};
			setStatus({...await loadPushStatus(localSubscription),preferences:status?.preferences||defaultPreferences});
			setMessage(result.message);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send a test notification.')}
		finally{setBusy(false)}
	}

	const permission=features?.permission||'unsupported';
	const permissionLabel=permission==='unsupported'?'Unavailable':permission==='granted'?'Allowed':permission==='denied'?'Blocked':'Not requested';
	const enabled=status?.preferences.accountActivity||status?.preferences.investmentUpdates||status?.preferences.announcements;
	const currentDevice=status?.devices.some(device=>device.isCurrentDevice)||false;
	const currentSubscription=Boolean(localSubscription||currentDevice);
	const guidance=issueMessage(issue);
	const pushStatus=loading||!features?'Checking…':permission==='denied'?'Permission blocked':currentSubscription?'Enabled on this device':!supported?'Unavailable here':!status?.available?'Not configured':'Available';

	return <section className="account-panel browser-push-settings" role="tabpanel">
		<div className="account-panel-title"><div><h3>Browser notifications</h3><p className="account-panel-subtitle">System notifications can arrive when Aurevia is closed on supported devices. In-app notification history remains available on every device.</p></div><Bell size={18} className="gold" aria-hidden="true"/></div>
		<div className="browser-push-status" aria-live="polite">
			<span className="status-pill">Push: {pushStatus}</span>
			<span className="status-pill">Permission: {loading?'Checking…':permissionLabel}</span>
			<span className="status-pill">{loading?'Checking subscription…':currentSubscription?'This device is registered':`${status?.subscriptionCount||0} registered device${status?.subscriptionCount===1?'':'s'}`}</span>
			{features?.installed&&<span className="status-pill">Installed app</span>}
			{enabled&&<span className="status-pill"><Check size={13} aria-hidden="true"/> Preferences enabled</span>}
		</div>
		{guidance&&<div className="account-callout browser-push-guidance" role="status"><span>{guidance}
			{issue==='ios-install-required'&&<ol className="list-decimal pl-5 pt-2">
				<li>Open this page in Safari over HTTPS.</li>
				<li>Tap <b>Share</b>, choose <b>Add to Home Screen</b>, then tap <b>Add</b>.</li>
				<li>Open Aurevia from its new Home Screen icon and enable notifications here.</li>
			</ol>}
			{issue==='ios-version-unsupported'&&<span className="block pt-2">Older iOS/iPadOS versions cannot receive Web Push from a Home Screen app. Use the in-app notification centre until you can update.</span>}
		</span></div>}
		{serviceWorkerError&&<p className="account-callout" role="alert">Aurevia could not register its background notification worker. Check that your browser allows service workers and that <code>/sw.js</code> is reachable, then reload and try again.</p>}
		{subscriptionError&&<p className="account-callout" role="alert">This browser could not create a push subscription. Check that notifications are allowed for Aurevia, then try again.</p>}
		{status&&features&&!status.available&&<p className="account-callout" role="status">Browser notifications are not configured by the Aurevia server yet. In-app notifications continue to work.</p>}
		{error&&<p className="account-callout" role="alert">{error}</p>}
		{message&&<p className="account-callout browser-push-success" role="status"><ShieldCheck size={15} aria-hidden="true"/>{message}</p>}
		<div className="browser-push-actions">
			<button type="button" className="btn bg-gold text-black" disabled={loading||busy||!supported||!status?.available||permission==='denied'} onClick={()=>void enable()}>{busy?<LoaderCircle size={16} className="animate-spin" aria-hidden="true"/>:null}Enable notifications</button>
			<button type="button" className="btn bg-white/5" disabled={loading||busy||!status} onClick={()=>void disable()}>Disable notifications</button>
			<button type="button" className="btn bg-white/5" disabled={loading||busy||!localSubscription||permission!=='granted'} onClick={()=>void sendTest()}>Send test notification</button>
		</div>
		{issue===null&&status?.available&&!currentSubscription&&<p className="account-callout" role="status">Notifications are available in this {features?.installed?'installed app':'browser'}. Select Enable notifications to subscribe this device.</p>}
		<div className="browser-push-devices">
			<div className="browser-push-devices-heading"><h4>Registered devices</h4><span>{status?.devices.length||0}</span></div>
			{status?.devices.length?<ul>{status.devices.map((device,index)=><li key={device.id}>
				<div><b>{device.isCurrentDevice?'This device':`Other device ${index+1}`}</b><small>Registered {formatDeviceDate(device.createdAt)}</small><small>Last successful push-service delivery: {formatDeviceDate(device.lastDeliveredAt)}</small>
					{device.isCurrentDevice&&permission==='denied'&&<small>Permission is blocked here. Allow it in browser or device settings, or remove this registration.</small>}
					{!device.isCurrentDevice&&<small>For device-specific permission or compatibility help, open Aurevia settings on that device.</small>}
				</div>
				<button type="button" className="text-link" disabled={loading||busy} aria-label={`Remove ${device.isCurrentDevice?'this device':'registered device '+(index+1)}`} onClick={()=>void removeDevice(device)}>Remove</button>
			</li>)}</ul>:<p className="muted">No browser devices are registered. Your in-app notification centre remains available.</p>}
		</div>
		<fieldset className="browser-push-preferences" disabled={loading||busy||!status}>
			<legend>Notification preferences</legend>
			<label><input type="checkbox" checked={status?.preferences.accountActivity??defaultPreferences.accountActivity} onChange={event=>void updatePreferences({accountActivity:event.target.checked})}/><span><b>Account activity</b><small>Funding, verification, card and security updates.</small></span></label>
			<label><input type="checkbox" checked={status?.preferences.investmentUpdates??defaultPreferences.investmentUpdates} onChange={event=>void updatePreferences({investmentUpdates:event.target.checked})}/><span><b>Investment updates</b><small>Investment and trading activity.</small></span></label>
			<label><input type="checkbox" checked={status?.preferences.announcements??defaultPreferences.announcements} onChange={event=>void updatePreferences({announcements:event.target.checked})}/><span><b>Optional announcements</b><small>Important updates published by Aurevia administrators.</small></span></label>
		</fieldset>
	</section>;
}
