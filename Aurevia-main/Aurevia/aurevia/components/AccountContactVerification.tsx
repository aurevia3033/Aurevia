'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {getCountries,getCountryCallingCode,parsePhoneNumberFromString,type CountryCode} from 'libphonenumber-js';

type ContactStatus={
	email:string;
	emailVerified:boolean;
	emailPending:boolean;
	emailResendAfter:string|null;
	phone:string|null;
	phoneVerified:boolean;
	phonePending:boolean;
	pendingPhone:string|null;
	phoneProvider:'BREVO'|'TERMII'|null;
	phoneResendAfter:string|null;
	phoneDeliveryAvailable:boolean;
	emailDeliveryAvailable:boolean;
	emailConfigurationMissing:string[];
	phoneConfigurationMissing:string[];
};

const countryNames=new Intl.DisplayNames(['en'],{type:'region'});
const phoneCountries=getCountries()
	.map(country=>({country,name:countryNames.of(country)||country,callingCode:getCountryCallingCode(country)}))
	.sort((left,right)=>left.name.localeCompare(right.name));

function countryForPhone(phone:string|null,country:string|null){
	const parsed=phone?parsePhoneNumberFromString(phone):undefined;
	if(parsed?.country)return parsed.country;
	const normalizedCountry=country?.trim().toLocaleLowerCase();
	return phoneCountries.find(item=>item.country.toLocaleLowerCase()===normalizedCountry||item.name.toLocaleLowerCase()===normalizedCountry)?.country
		||phoneCountries.find(item=>item.country.toLocaleLowerCase()===normalizedCountry)?.country
		||'US';
}

function nationalNumber(phone:string|null,countryCode:string){
	if(!phone)return '';
	const selectedCountry=getCountries().find(country=>country===countryCode)||'US';
	const parsed=parsePhoneNumberFromString(phone,selectedCountry);
	return parsed?.nationalNumber||phone;
}

function secondsRemaining(value:string|null,now:number){
	if(!value)return 0;
	const time=Date.parse(value);
	return Number.isFinite(time)?Math.max(0,Math.ceil((time-now)/1000)):0;
}

async function readResult(response:Response){
	const result=await response.json().catch(()=>({error:'The request could not be completed.'}));
	if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'The request could not be completed.');
	return result as Record<string,unknown>;
}

export default function AccountContactVerification({country}:{country:string|null}){
	const [status,setStatus]=useState<ContactStatus|null>(null);
	const [loading,setLoading]=useState(true);
	const [emailCode,setEmailCode]=useState('');
	const [phoneCode,setPhoneCode]=useState('');
	const [phoneEntry,setPhoneEntry]=useState('');
	const [countryCode,setCountryCode]=useState<CountryCode>(countryForPhone(null,country));
	const [emailBusy,setEmailBusy]=useState(false);
	const [phoneBusy,setPhoneBusy]=useState(false);
	const [emailPending,setEmailPending]=useState(false);
	const [phonePending,setPhonePending]=useState(false);
	const [message,setMessage]=useState('');
	const [error,setError]=useState('');
	const [now,setNow]=useState(0);

	const refresh=useCallback(async()=>{
		const response=await fetch('/api/settings/contact-verification',{cache:'no-store'});
		const result=await readResult(response) as unknown as ContactStatus;
		setStatus(result);
		return result;
	},[]);

	useEffect(()=>{
		let active=true;
		fetch('/api/settings/contact-verification',{cache:'no-store'}).then(readResult).then(result=>{
			if(!active)return;
			const current=result as unknown as ContactStatus;
			setStatus(current);
			const entryPhone=current.pendingPhone||current.phone;
			const initialCountry=countryForPhone(entryPhone,country);
			setCountryCode(initialCountry);
			setPhoneEntry(nationalNumber(entryPhone,initialCountry));
			setEmailPending(current.emailPending);
			setPhonePending(current.phonePending);
		}).catch(exception=>{
			if(active)setError(exception instanceof Error?exception.message:'Unable to load contact verification.');
		}).finally(()=>{if(active)setLoading(false)});
		return()=>{active=false};
	},[country]);

	useEffect(()=>{
		const updateNow=()=>setNow(Date.now());
		updateNow();
		const interval=window.setInterval(updateNow,1000);
		return()=>window.clearInterval(interval);
	},[]);

	const emailCooldown=secondsRemaining(status?.emailResendAfter||null,now);
	const phoneCooldown=secondsRemaining(status?.phoneResendAfter||null,now);

	async function sendEmailCode(){
		if(emailBusy)return;
		setEmailBusy(true);setError('');setMessage('');
		try{
			await readResult(await fetch('/api/settings/email-verification/send',{
				method:'POST',headers:{'content-type':'application/json'},body:'{}',
			}));
			const current=await refresh();
			setEmailPending(true);
			setMessage(`A code was sent to ${current.email}.`);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send an email code.')}
		finally{setEmailBusy(false)}
	}

	async function verifyEmailCode(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(emailBusy)return;
		setEmailBusy(true);setError('');setMessage('');
		try{
			await readResult(await fetch('/api/settings/email-verification/verify',{
				method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:emailCode}),
			}));
			await refresh();
			setEmailCode('');setEmailPending(false);setMessage('Your email address is verified.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to verify this email address.')}
		finally{setEmailBusy(false)}
	}

	async function sendPhoneCode(){
		if(phoneBusy)return;
		setPhoneBusy(true);setError('');setMessage('');
		try{
			const result=await readResult(await fetch('/api/settings/phone-verification/send',{
				method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:phoneEntry,countryCode}),
			}));
			await refresh();
			setPhonePending(true);
			setPhoneCode('');
			setMessage(typeof result.message==='string'?result.message:'A verification code was requested.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send a phone code.')}
		finally{setPhoneBusy(false)}
	}

	async function verifyPhoneCode(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(phoneBusy)return;
		setPhoneBusy(true);setError('');setMessage('');
		try{
			await readResult(await fetch('/api/settings/phone-verification/verify',{
				method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:phoneCode}),
			}));
			const current=await refresh();
			setPhoneEntry(nationalNumber(current.phone,countryCode));
			setPhoneCode('');setPhonePending(false);setMessage('Your phone number is verified.');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to verify this phone number.')}
		finally{setPhoneBusy(false)}
	}

	return <section className="account-panel card mt-4 p-5" aria-labelledby="contact-verification-heading">
		<div className="account-panel-title"><div><h2 id="contact-verification-heading">Contact verification</h2></div></div>
		{loading?<p className="muted" role="status">Loading verification status…</p>:!status?<div className="grid gap-3"><p className="text-sm muted">Contact verification status is unavailable.</p><button className="btn w-fit bg-white/5" type="button" onClick={()=>{setLoading(true);setError('');void refresh().catch(exception=>setError(exception instanceof Error?exception.message:'Unable to load contact verification status.')).finally(()=>setLoading(false))}}>Retry</button></div>:<div className="grid gap-6 lg:grid-cols-2">
			<section aria-labelledby="email-verification-heading">
				<h3 id="email-verification-heading" className="font-semibold">Email Verification</h3>
				<p className="mt-2 break-all text-sm muted">{status?.email||'Email unavailable'}</p>
				<p className="mt-1 text-sm" role="status">Status: <b>{status?.emailVerified?'Verified':'Not verified'}</b></p>
				{!status?.emailVerified&&<div className="mt-3 grid gap-3">
					<button type="button" className="btn w-fit bg-white/5" onClick={()=>void sendEmailCode()} disabled={emailBusy||!status?.emailDeliveryAvailable||emailCooldown>0}>
						{emailBusy?'Sending…':emailPending?'Resend email code':'Verify Email'}
					</button>
					{emailCooldown>0&&<p className="text-xs muted">You can request another code in {emailCooldown}s.</p>}
					{emailPending&&<form className="grid max-w-sm gap-2" onSubmit={event=>void verifyEmailCode(event)}>
						<label className="account-label" htmlFor="settings-email-verification-code">Enter the six-digit code</label>
						<input id="settings-email-verification-code" className="input" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={emailCode} onChange={event=>setEmailCode(event.target.value.replace(/\D/g,'').slice(0,6))}/>
						<button type="submit" className="btn w-fit bg-gold text-black" disabled={emailBusy||emailCode.length!==6}>{emailBusy?'Checking…':'Confirm Email'}</button>
					</form>}
					{!status?.emailDeliveryAvailable&&<p className="text-xs text-loss">Email verification is unavailable. Required server configuration: {status?.emailConfigurationMissing.join(', ')||'email provider credentials'}.</p>}
				</div>}
			</section>
			<section aria-labelledby="phone-verification-heading">
				<h3 id="phone-verification-heading" className="font-semibold">Phone Number Verification</h3>
				<p className="mt-2 break-all text-sm muted">{status?.phone||'No phone number saved yet'}</p>
				<p className="mt-1 text-sm" role="status">Status: <b>{status?.phoneVerified?'Verified':'Not verified'}</b></p>
				{!status?.phoneVerified&&<div className="mt-3 grid max-w-xl gap-3">
					<label className="account-label">Country
						<select className="input" value={countryCode} onChange={event=>{
							const selected=phoneCountries.find(item=>item.country===event.target.value);
							if(selected)setCountryCode(selected.country);
						}}>
							{phoneCountries.map(item=><option key={item.country} value={item.country}>{item.name} (+{item.callingCode})</option>)}
						</select>
					</label>
					<label className="account-label">Phone number
						<input className="input" type="tel" autoComplete="tel-national" value={phoneEntry} onChange={event=>setPhoneEntry(event.target.value)} placeholder="Enter your number"/>
					</label>
					{status?.pendingPhone&&<p className="text-xs muted">Verification pending for {status.pendingPhone}.</p>}
					<button type="button" className="btn w-fit bg-white/5" onClick={()=>void sendPhoneCode()} disabled={phoneBusy||!status?.phoneDeliveryAvailable||phoneCooldown>0||!phoneEntry.trim()}>
						{phoneBusy?'Working…':phonePending?'Resend phone code':'Verify Phone Number'}
					</button>
					{phoneCooldown>0&&<p className="text-xs muted">You can request another code in {phoneCooldown}s.</p>}
					{phonePending&&status?.phoneProvider&&<form className="otp-verify-form grid max-w-sm gap-3" onSubmit={event=>void verifyPhoneCode(event)}>
						<div className="otp-verify-header">
							<span className="otp-verify-icon" aria-hidden="true">📱</span>
							<div>
								<label className="account-label" htmlFor="settings-phone-verification-code">Confirmation</label>
								<p className="text-xs muted">Enter the 6-digit code sent to {status.pendingPhone||status.phone||'your phone'}</p>
							</div>
						</div>
						<div className="otp-digit-row" role="group" aria-label="Six-digit verification code">
							{[0,1,2,3,4,5].map(index=>{
								const digit=phoneCode[index]||'';
								const hasError=Boolean(error&&phoneCode.length===6);
								return <input
									key={index}
									id={index===0?'settings-phone-verification-code':undefined}
									className={`otp-digit input ${hasError?'otp-digit-error':''}`}
									type="text"
									inputMode="numeric"
									autoComplete={index===0?'one-time-code':'off'}
									maxLength={1}
									value={digit}
									aria-label={`Digit ${index+1}`}
									onChange={event=>{
										const next=event.target.value.replace(/\D/g,'').slice(-1);
										const chars=phoneCode.padEnd(6,' ').split('');
										chars[index]=next||' ';
										const joined=chars.join('').replace(/ /g,'').slice(0,6);
										setPhoneCode(joined);
										setError('');
										if(next){
											const parent=event.currentTarget.parentElement;
											const inputs=parent?Array.from(parent.querySelectorAll<HTMLInputElement>('input.otp-digit')):[];
											const nextInput=inputs[index+1];
											if(nextInput)nextInput.focus();
										}
									}}
									onKeyDown={event=>{
										if(event.key==='Backspace'&&!phoneCode[index]&&index>0){
											const parent=event.currentTarget.parentElement;
											const inputs=parent?Array.from(parent.querySelectorAll<HTMLInputElement>('input.otp-digit')):[];
											const prev=inputs[index-1];
											if(prev)prev.focus();
										}
									}}
									onPaste={event=>{
										event.preventDefault();
										const pasted=(event.clipboardData.getData('text')||'').replace(/\D/g,'').slice(0,6);
										if(pasted){setPhoneCode(pasted);setError('');}
									}}
								/>;
							})}
						</div>
						{error&&phonePending?<p className="otp-error text-sm text-loss" role="alert">Wrong code. Try again.</p>:null}
						<button type="submit" className="btn w-fit bg-gold text-black" disabled={phoneBusy||phoneCode.length!==6}>
							{phoneBusy?'Verifying…':'Confirm Phone Number'}
						</button>
						{phoneCooldown>0&&<p className="text-xs muted">Resend code in {phoneCooldown}s</p>}
					</form>}
					{status?.phoneVerified&&<div className="otp-success" role="status">
						<span className="otp-success-badge" aria-hidden="true">✓</span>
						<div>
							<strong>You&apos;re verified</strong>
							<p className="text-sm muted">{status.phone} is confirmed.</p>
						</div>
					</div>}
				</div>}
			</section>
		</div>}
		{error&&!phonePending&&<p className="mt-4 text-sm text-loss" role="alert">{error}</p>}
		{message&&<p className="mt-4 text-sm text-profit" role="status">{message}</p>}
	</section>;
}
