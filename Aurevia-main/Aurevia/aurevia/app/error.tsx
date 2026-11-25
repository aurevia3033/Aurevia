'use client';
import {useEffect} from 'react';
import {ErrorState} from '@/components/ui/error-state';
export default function Error({error,reset}:{error:Error&{digest?:string};reset:()=>void}){useEffect(()=>{console.error(JSON.stringify({event:'ROUTE_RENDER_ERROR',errorName:error.name,digest:error.digest}))},[error]);return <main className="flex min-h-screen items-center justify-center bg-black px-6"><div className="card max-w-lg p-7"><div className="gold mb-4 text-sm font-bold tracking-[.25em]">AUREVIA EXCHANGE</div><ErrorState title="Something went wrong" description="The page could not complete the requested operation." errorAction={<button onClick={()=>reset()} className="emerald-button btn bg-gold text-black">Try again</button>}/></div></main>}
