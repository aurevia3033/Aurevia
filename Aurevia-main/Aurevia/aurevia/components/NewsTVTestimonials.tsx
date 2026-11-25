'use client';

import {useCallback,useEffect,useState} from 'react';
import Image from 'next/image';
import {ArrowLeft,ArrowRight,LoaderCircle,RefreshCw,ShieldCheck,Star} from 'lucide-react';

type Testimonial={
	id:string;
	displayName:string;
	country:string|null;
	cityOrRegion:string|null;
	title:string|null;
	quote:string;
	imageUrl:string|null;
	rating:number|null;
	verifiedClientStory?:boolean;
	withdrawalAmount?:string;
	currency?:string;
};

const rotationDelayMs=10_000;

export default function NewsTVTestimonials(){
	const [stories,setStories]=useState<Testimonial[]>([]);
	const [index,setIndex]=useState(0);
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [retry,setRetry]=useState(0);
	const [brokenImages,setBrokenImages]=useState<string[]>([]);
	const [reducedMotion,setReducedMotion]=useState(false);

	const load=useCallback(async(signal:AbortSignal)=>{
		setLoading(true);
		setError('');
		try{
			const response=await fetch('/api/client-stories',{cache:'no-store',signal});
			const result=await response.json();
			if(!response.ok)throw new Error(typeof result?.error==='string'?result.error:'Testimonials are temporarily unavailable.');
			const next=Array.isArray(result)?result as Testimonial[]:[];
			setStories(next);
			setIndex(0);
			setBrokenImages([]);
		}catch(exception){
			if(!signal.aborted)setError(exception instanceof Error?exception.message:'Testimonials are temporarily unavailable.');
		}finally{
			if(!signal.aborted)setLoading(false);
		}
	},[]);

	useEffect(()=>{
		const controller=new AbortController();
		void load(controller.signal);
		return()=>controller.abort();
	},[load,retry]);

	useEffect(()=>{
		const media=window.matchMedia('(prefers-reduced-motion: reduce)');
		const update=()=>setReducedMotion(media.matches);
		update();
		media.addEventListener('change',update);
		return()=>media.removeEventListener('change',update);
	},[]);

	useEffect(()=>{
		if(reducedMotion||stories.length<2)return;
		const timer=window.setInterval(()=>{
			if(document.visibilityState==='visible')setIndex(current=>(current+1)%stories.length);
		},rotationDelayMs);
		return()=>window.clearInterval(timer);
	},[reducedMotion,stories.length]);

	const current=stories[index]||null;
	const move=(direction:-1|1)=>setIndex(value=>(value+direction+stories.length)%stories.length);

	return <div className="news-tv-testimonials" aria-label="Published customer testimonials">
		<div className="news-tv-testimonials-heading"><span>CLIENT TESTIMONIES</span><span>{stories.length?`${index+1} / ${stories.length}`:'AUREVIA COMMUNITY'}</span></div>
		{loading&&!current&&<div className="news-tv-testimonials-state" role="status"><LoaderCircle size={20} className="animate-spin"/><span>Loading published testimonies…</span></div>}
		{error&&!current&&<div className="news-tv-testimonials-state" role="alert"><span>{error}</span><button type="button" onClick={()=>setRetry(value=>value+1)}><RefreshCw size={14}/> Retry</button></div>}
		{!loading&&!error&&!current&&<div className="news-tv-testimonials-state"><strong>No published testimonies yet</strong><span>Approved, consented client stories will appear here automatically.</span></div>}
		{current&&<>
			<article className="news-tv-testimonial" aria-label={`Testimony ${index+1} of ${stories.length}`}>
				<div className="news-tv-testimonial-person">
					{current.imageUrl&&!brokenImages.includes(current.id)
						?<Image src={current.imageUrl} alt={`Portrait of ${current.displayName}`} width={68} height={68} unoptimized onError={()=>setBrokenImages(items=>items.includes(current.id)?items:[...items,current.id])}/>
						:<Image src="/client-story-avatar.svg" alt={`Illustrated avatar for ${current.displayName}`} width={68} height={68}/>}
					<div><strong>{current.displayName}</strong><small>{[current.cityOrRegion,current.country].filter(Boolean).join(', ')||'Aurevia client'}</small>
						{current.verifiedClientStory&&<em><ShieldCheck size={12}/> Verified client story</em>}
					</div>
				</div>
				{current.title&&<p className="news-tv-testimonial-title">{current.title}</p>}
				{current.rating&&<p className="news-tv-testimonial-rating" aria-label={`Rated ${current.rating} out of 5`}>{Array.from({length:current.rating},(_,star)=><Star key={star} size={12} fill="currentColor"/>)}<span>{current.rating}/5</span></p>}
				<blockquote>“{current.quote}”</blockquote>
				{current.withdrawalAmount&&<p className="news-tv-testimonial-proof">Verified withdrawal · {Number(current.withdrawalAmount).toLocaleString()} {current.currency}</p>}
			</article>
			{stories.length>1&&<div className="news-tv-testimonial-controls">
				<button type="button" onClick={()=>move(-1)} aria-label="Previous testimony"><ArrowLeft size={15}/></button>
				<div>{stories.map((story,storyIndex)=><button key={story.id} type="button" aria-label={`Show testimony ${storyIndex+1}`} aria-pressed={storyIndex===index} className={storyIndex===index?'is-active':''} onClick={()=>setIndex(storyIndex)}/>)}</div>
				<button type="button" onClick={()=>move(1)} aria-label="Next testimony"><ArrowRight size={15}/></button>
			</div>}
		</>}
	</div>;
}
