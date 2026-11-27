'use client';

import {FormEvent,useEffect,useState} from 'react';
import {signIn,useSession} from 'next-auth/react';
import Link from 'next/link';
import Image from 'next/image';
import {useRouter} from 'next/navigation';
import {Eye,EyeOff,LoaderCircle,ShieldCheck} from 'lucide-react';
import Nav from '@/components/Nav';
import StatusNotice from '@/components/StatusNotice';
import {useLocale} from '@/lib/i18n-context';
import {safeInternalPath} from '@/lib/navigation';
import {getEncryptedLocalValue,removeEncryptedLocalValue,setEncryptedLocalValue} from '@/lib/encrypted-local-storage';

const rememberedEmailKey='aurevia-signin-remembered-email';

export default function Login(){
	const router=useRouter();
	const {translate}=useLocale();
	const [identifier,setIdentifier]=useState('');
	const [password,setPassword]=useState('');
	const [rememberEmail,setRememberEmail]=useState(false);
	const [passwordVisible,setPasswordVisible]=useState(false);
	const [error,setError]=useState('');
	const [storageNotice,setStorageNotice]=useState('');
	const [registered,setRegistered]=useState(false);
	const [loginSuccess,setLoginSuccess]=useState(false);
	const [callbackUrl,setCallbackUrl]=useState('/dashboard');
	const [busy,setBusy]=useState(false);
	const {update}=useSession();

	useEffect(()=>{
		const query=new URLSearchParams(window.location.search);
		let active=true;
		void (async()=>{
			let registrationEmail='';
			let legacyEmail='';
			try{
				registrationEmail=window.sessionStorage.getItem('aurevia-signin-email')||'';
				if(registrationEmail)window.sessionStorage.removeItem('aurevia-signin-email');
			}catch(error){
				console.warn('Unable to restore the registration email for sign-in.',{errorName:error instanceof Error?error.name:'UnknownError'});
			}
			try{
				legacyEmail=window.localStorage.getItem(rememberedEmailKey)||'';
				if(legacyEmail)window.localStorage.removeItem(rememberedEmailKey);
			}catch(error){
				console.warn('Unable to migrate the remembered sign-in email.',{errorName:error instanceof Error?error.name:'UnknownError'});
			}
			let rememberedEmail='';
			try{
				rememberedEmail=await getEncryptedLocalValue(rememberedEmailKey)||'';
				if(!rememberedEmail&&legacyEmail){
					await setEncryptedLocalValue(rememberedEmailKey,legacyEmail);
					rememberedEmail=legacyEmail;
				}
			}catch(error){
				console.warn('Secure remembered-email storage is unavailable.',{errorName:error instanceof Error?error.name:'UnknownError'});
				if(legacyEmail)rememberedEmail=legacyEmail;
				if(active)setStorageNotice('Secure device storage is unavailable. You can still sign in, but your email will not be remembered.');
			}
			if(!active)return;
			if(registrationEmail){
				setIdentifier(registrationEmail);
				setRememberEmail(false);
			}else if(rememberedEmail){
				setIdentifier(rememberedEmail);
				setRememberEmail(true);
			}
		})();
		setRegistered(query.get('registered')==='1');
		setCallbackUrl(safeInternalPath(query.get('callbackUrl')||'/dashboard','/dashboard',window.location.origin));
		return()=>{active=false};
	},[]);

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;setBusy(true);setError('');setLoginSuccess(false);
		try{
			const result=await signIn('credentials',{username:identifier,email:identifier,password,redirect:false});
			if(result?.ok){
				try{
					if(rememberEmail)await setEncryptedLocalValue(rememberedEmailKey,identifier.trim());
					else await removeEncryptedLocalValue(rememberedEmailKey);
					setStorageNotice('');
				}catch(storageError){
					console.warn('Unable to securely save the remembered sign-in email.',{errorName:storageError instanceof Error?storageError.name:'UnknownError'});
					setStorageNotice('Secure device storage is unavailable. Your sign-in succeeded, but your email was not remembered.');
				}
				try{await update()}catch(error){console.error('Session refresh after sign-in failed.',error instanceof Error?error.name:'UnknownError')}
				setLoginSuccess(true);
				await new Promise<void>(resolve=>window.setTimeout(resolve,900));
				router.replace(callbackUrl);
			}else if(result?.error==='CredentialsSignin'){
				setError('Sign-in details are incorrect.');
			}else if(result?.error?.startsWith('AUTHENTICATION_SERVICE_UNAVAILABLE:')){
				const referenceId=result.error.slice('AUTHENTICATION_SERVICE_UNAVAILABLE:'.length);
				setError(/^[0-9a-f-]{36}$/i.test(referenceId)?`${translate('unableAuth')} Reference ID: ${referenceId}`:translate('unableAuth'));
			}else{
				setError(translate('unableAuth'));
			}
		}catch{setError(translate('unableAuth'))}
		finally{setBusy(false);}
	}

	return <><Nav/><main className="auth-scene auth-signin-scene"><div className="auth-signin-layout">
		<aside className="auth-signin-story">
			<div className="auth-brand"><Image src="/aurevia-logo.png" alt="" width={52} height={52} priority/><span className="brand-copy"><strong>Aurevia</strong><small>EXCHANGE</small></span></div>
			<p className="account-kicker">PRIVATE CLIENT ACCESS · AUREVIA EXCHANGE</p>
			<div className="auth-signin-market" aria-hidden="true">
				<div className="auth-signin-market-heading"><span>MARKET OVERVIEW</span><span>ILLUSTRATIVE</span></div>
				<svg viewBox="0 0 520 132" preserveAspectRatio="none"><path d="M0 104 48 96 81 101 124 72 161 82 204 58 242 66 284 40 321 48 362 27 399 34 442 15 480 23 520 9" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M0 104 48 96 81 101 124 72 161 82 204 58 242 66 284 40 321 48 362 27 399 34 442 15 480 23 520 9V132H0Z" fill="url(#signin-market-fill)" opacity=".16"/><defs><linearGradient id="signin-market-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor="currentColor"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs></svg>
				<div className="auth-signin-market-foot"><span>ACCOUNT CONTROL</span><span>DEMO &amp; REAL · KEPT SEPARATE</span></div>
			</div>
			<div className="auth-signin-security"><ShieldCheck size={17} aria-hidden="true"/><span><b>Private by design</b><small>Protected sign-in and account-level security controls.</small></span></div>
		</aside>
		<section className="auth-card auth-signin-card" aria-labelledby="signin-title">
			<p className="account-kicker">{translate('secureAccess')} · PRIVATE ACCOUNT ACCESS</p>
			<h1 id="signin-title" className="auth-heading">{translate('welcomeBack')}</h1>
			<p className="auth-subtitle">Sign in to pick up where you left off. No subscription or payment method is required.</p>
			<div className="auth-market-line" aria-hidden="true"/>
			{registered&&!busy&&<StatusNotice tone="success" title="Registration complete" description={translate('registeredSignIn')} emoji="😊"/>}
			{busy&&!loginSuccess&&<StatusNotice tone="pending" title="Signing in securely…" description="Please wait while Aurevia verifies your account." processing/>}
			{loginSuccess&&<StatusNotice tone="success" title="Welcome back!" description="Sign-in confirmed. Opening your account…" emoji="😊"/>}
			<form onSubmit={submit} className="mt-5 space-y-4">
				<label className="auth-field-label">{translate('emailOrUsername')}<input className="auth-input" name="username" type="text" autoComplete="username" value={identifier} onChange={event=>{setIdentifier(event.target.value);setError('')}} required/></label>
				<div><label className="auth-field-label" htmlFor="login-password">{translate('password')}</label><div className="auth-password-wrap"><input id="login-password" className="auth-input" name="password" type={passwordVisible?'text':'password'} autoComplete="current-password" value={password} onChange={event=>{setPassword(event.target.value);setError('')}} required/><button type="button" className="auth-password-toggle" aria-label={passwordVisible?translate('hidePassword'):translate('showPassword')} aria-pressed={passwordVisible} onClick={()=>setPasswordVisible(value=>!value)}>{passwordVisible?<EyeOff size={18}/>:<Eye size={18}/>}</button></div></div>
				<div className="auth-signin-options"><label className="auth-remember-option"><input type="checkbox" checked={rememberEmail} onChange={event=>{
					const checked=event.target.checked;
					setRememberEmail(checked);
					if(!checked){
						void removeEncryptedLocalValue(rememberedEmailKey).catch(storageError=>{
							console.warn('Unable to clear the encrypted remembered sign-in email.',{errorName:storageError instanceof Error?storageError.name:'UnknownError'});
							setStorageNotice('The remembered email could not be removed from secure device storage.');
						});
					}
				}}/><span>Remember my email on this device</span></label><Link className="auth-link" href="/forgot-password">{translate('forgotPassword')}</Link></div>
				{storageNotice&&<p className="text-sm text-amber-300" role="status">{storageNotice}</p>}
				{error&&<StatusNotice tone={error==='Sign-in details are incorrect.'?'declined':'neutral'} title={error==='Sign-in details are incorrect.'?'Sign-in details not accepted':'Sign-in could not be completed'} description={error} role="alert"/>}
				<button type="submit" disabled={busy} className="auth-submit flex w-full items-center justify-center gap-2" aria-busy={busy}>{busy?<><LoaderCircle size={16} className="animate-spin" aria-hidden="true"/>{loginSuccess?'Opening account…':translate('loading')}</> : translate('signIn')}</button>
			</form>
			<p className="auth-footer">{translate('newToAurevia')} <Link className="auth-link" href="/register">{translate('createAccount')}</Link></p>
			<div className="auth-assurance"><ShieldCheck size={17} className="gold" aria-hidden="true"/><span><b>{translate('protectedSession')}</b><small>Sessions expire after 8 hours. Your password is never displayed in the app.</small></span></div>
		</section>
	</div></main></>;
}