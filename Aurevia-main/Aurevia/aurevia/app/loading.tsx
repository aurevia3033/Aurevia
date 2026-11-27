'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import AureviaLoading from '@/components/AureviaLoading';

const loadingTimeoutMs=15_000;

export default function Loading(){
	const router=useRouter();
	const [timedOut,setTimedOut]=useState(false);
	useEffect(()=>{
		const timeout=window.setTimeout(()=>setTimedOut(true),loadingTimeoutMs);
		return()=>window.clearTimeout(timeout);
	},[]);

	if(timedOut)return <main className="aurevia-loading-timeout" role="alert">
		<h1>This page is taking longer than expected.</h1>
		<p>Your account and legal protections remain in place. Try loading the page again.</p>
		<button type="button" onClick={()=>router.refresh()}>Try again</button>
	</main>;
	return <AureviaLoading label="Loading Aurevia Exchange" detail="Opening your page"/>;
}
