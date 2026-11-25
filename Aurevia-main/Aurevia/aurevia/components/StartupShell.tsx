'use client';

import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {MouseEvent,ReactNode} from 'react';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';
import AureviaLoading from '@/components/AureviaLoading';
import AureviaStartup,{AureviaStartupLoader} from '@/components/AureviaStartup';

const startupKey='aurevia-startup-complete';
const exitDurationMs=120;
const introExitDurationMs=450;
const maximumStartupWaitMs=350;
const navigationLoaderDelayMs=250;
const navigationLoaderTimeoutMs=15_000;
type StartupMode='loading'|'hidden';

export default function StartupShell({children}:{children:ReactNode}){
	const {status}=useSession();
	const pathname=usePathname();
	const currentPath=useRef(pathname);
	const startupInitialized=useRef(false);
	const autoIntroStarted=useRef(false);
	const navigationLoaderTimer=useRef<number|undefined>(undefined);
	const navigationTimeoutTimer=useRef<number|undefined>(undefined);
	const introExitTimer=useRef<number|undefined>(undefined);
	const [ready,setReady]=useState(false);
	const [startupMode,setStartupMode]=useState<StartupMode>(pathname==='/'?'hidden':'loading');
	const [isExiting,setIsExiting]=useState(false);
	const [showPageTransition,setShowPageTransition]=useState(false);
	const [showIntro,setShowIntro]=useState(false);
	const [isIntroExiting,setIsIntroExiting]=useState(false);
	const showStartup=startupMode!=='hidden';

	const clearNavigationTimers=useCallback(()=>{
		if(navigationLoaderTimer.current!==undefined)window.clearTimeout(navigationLoaderTimer.current);
		if(navigationTimeoutTimer.current!==undefined)window.clearTimeout(navigationTimeoutTimer.current);
		navigationLoaderTimer.current=undefined;
		navigationTimeoutTimer.current=undefined;
	},[]);

	const startNavigation=useCallback(()=>{
		if(!ready||startupMode!=='hidden')return;
		clearNavigationTimers();
		navigationLoaderTimer.current=window.setTimeout(()=>setShowPageTransition(true),navigationLoaderDelayMs);
		navigationTimeoutTimer.current=window.setTimeout(()=>{
			setShowPageTransition(false);
			clearNavigationTimers();
		},navigationLoaderTimeoutMs);
	},[clearNavigationTimers,ready,startupMode]);

	const handleNavigationClick=useCallback((event:MouseEvent<HTMLDivElement>)=>{
		if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
		if(!(event.target instanceof Element))return;
		const anchor=event.target.closest('a');
		if(!anchor||anchor.target&&anchor.target!=='_self'||anchor.hasAttribute('download'))return;
		if(anchor.origin!==window.location.origin||anchor.pathname===window.location.pathname)return;
		startNavigation();
	},[startNavigation]);

	const markStartupComplete=useCallback(()=>{
		try{sessionStorage.setItem(startupKey,'1')}catch{}
		document.documentElement.dataset.aureviaStartupComplete='true';
		setStartupMode('hidden');
	},[]);

	const completeIntro=useCallback(()=>{
		delete document.documentElement.dataset.aureviaIntroPending;
		setShowIntro(false);
		setIsIntroExiting(false);
		introExitTimer.current=undefined;
	},[]);

	const finishIntro=useCallback(()=>{
		if(introExitTimer.current!==undefined)return;
		setIsIntroExiting(true);
		introExitTimer.current=window.setTimeout(completeIntro,introExitDurationMs);
	},[completeIntro]);

	const replayIntro=useCallback(()=>{
		if(introExitTimer.current!==undefined)window.clearTimeout(introExitTimer.current);
		introExitTimer.current=undefined;
		document.documentElement.dataset.aureviaIntroPending='true';
		setIsIntroExiting(false);
		setShowIntro(true);
	},[]);

	useLayoutEffect(()=>{
		if(introExitTimer.current!==undefined)window.clearTimeout(introExitTimer.current);
		introExitTimer.current=undefined;
		setIsIntroExiting(false);
		if(pathname!=='/'){
			setShowIntro(false);
			delete document.documentElement.dataset.aureviaIntroPending;
			return;
		}
		if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
			delete document.documentElement.dataset.aureviaIntroPending;
			setShowIntro(false);
			return;
		}
		if(!autoIntroStarted.current){
			autoIntroStarted.current=true;
			document.documentElement.dataset.aureviaIntroPending='true';
			setShowIntro(true);
			return;
		}
		delete document.documentElement.dataset.aureviaIntroPending;
		setShowIntro(false);
	},[pathname]);

	useEffect(()=>()=>{if(introExitTimer.current!==undefined)window.clearTimeout(introExitTimer.current)},[]);

	// Shared cinematic scroll interactions across signed-in, public, and admin workspaces.
	useEffect(()=>{
		const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
		if(reducedMotion.matches||!('IntersectionObserver' in window))return;
		// Apply the same reveal choreography to every route family, including
		// public, account, trading, wallet, settings, support and admin pages.
		// Explicit opt-in attributes are also available for complex page sections.
		const selector=[
			'.account-page > *',
			'.account-page .admin-panel',
			'.account-page .account-panel',
			'.admin-shell-chrome > main > *',
			'.admin-shell-chrome main > .admin-panel',
			'.scene-content main > section',
			'.scene-content main > article',
			'.scene-content main > [data-aurevia-motion]',
			'.scene-content [data-page-section]',
			'.scene-content .page-motion-section',
		].join(',');
		const observer=new IntersectionObserver(entries=>{
			for(const entry of entries){
				if(!entry.isIntersecting)continue;
				const element=entry.target as HTMLElement;
				element.dataset.aureviaReveal='visible';
				observer.unobserve(element);
			}
		},{threshold:.06,rootMargin:'0px 0px -28px 0px'});
		const reveal=(element:Element)=>{
			if(!(element instanceof HTMLElement)||element.dataset.aureviaReveal)return;
			if(element.closest('.home-root'))return;
			element.dataset.aureviaReveal='pending';
			observer.observe(element);
		};
		const scan=(root:ParentNode)=>root.querySelectorAll(selector).forEach(reveal);
		scan(document);
		document.documentElement.classList.add('aurevia-motion-enabled');
		const mutations=new MutationObserver(records=>{
			for(const record of records)for(const node of record.addedNodes){
				if(node instanceof HTMLElement){
					if(node.matches(selector))reveal(node);
					scan(node);
				}
			}
		});
		mutations.observe(document.body,{childList:true,subtree:true});
		return()=>{
			mutations.disconnect();
			observer.disconnect();
			document.documentElement.classList.remove('aurevia-motion-enabled');
			document.querySelectorAll<HTMLElement>('[data-aurevia-reveal]').forEach(element=>delete element.dataset.aureviaReveal);
		};
	},[pathname]);

	// A restrained route entrance runs on every client-side navigation without
	// remounting providers, resetting forms, or interrupting chart subscriptions.
	useEffect(()=>{
		const content=document.querySelector<HTMLElement>('.scene-content');
		if(!content||window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
		content.dataset.aureviaRouteEnter='true';
		const frame=window.requestAnimationFrame(()=>{
			content.dataset.aureviaRouteEnter='active';
		});
		const timer=window.setTimeout(()=>{
			delete content.dataset.aureviaRouteEnter;
		},680);
		return()=>{
			window.cancelAnimationFrame(frame);
			window.clearTimeout(timer);
		};
	},[pathname]);

	useEffect(()=>{
		const root=document.documentElement;
		let frame=0;
		const update=()=>{
			if(frame)return;
			frame=window.requestAnimationFrame(()=>{
				frame=0;
				const scrollable=root.scrollHeight-window.innerHeight;
				const progress=scrollable>0?Math.min(1,Math.max(0,window.scrollY/scrollable)):0;
				root.style.setProperty('--aurevia-scroll-progress',String(progress));
			});
		};
		update();
		window.addEventListener('scroll',update,{passive:true});
		window.addEventListener('resize',update);
		return()=>{
			window.removeEventListener('scroll',update);
			window.removeEventListener('resize',update);
			if(frame)window.cancelAnimationFrame(frame);
			root.style.removeProperty('--aurevia-scroll-progress');
		};
	},[]);

	useEffect(()=>{
		if(startupInitialized.current){
			setReady(true);
			return;
		}
		startupInitialized.current=true;
		let startupSeen=false;
		try{
			startupSeen=sessionStorage.getItem(startupKey)==='1';
		}catch{}
		if(pathname==='/'||startupSeen){
			try{sessionStorage.setItem(startupKey,'1')}catch{}
			document.documentElement.dataset.aureviaStartupComplete='true';
			setStartupMode('hidden');
		}
		setReady(true);
	},[pathname]);

	useLayoutEffect(()=>{
		if(currentPath.current===pathname)return;
		currentPath.current=pathname;
		clearNavigationTimers();
		setShowPageTransition(false);
	},[clearNavigationTimers,pathname]);

	useEffect(()=>{
		window.addEventListener('popstate',startNavigation);
		return()=>{
			window.removeEventListener('popstate',startNavigation);
			clearNavigationTimers();
		};
	},[clearNavigationTimers,startNavigation]);

	useEffect(()=>{
		if(!ready||startupMode!=='loading')return;
		if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
			markStartupComplete();
			return;
		}
		let exitTimer:number|undefined;
		const timer=window.setTimeout(()=>{
			setIsExiting(true);
			exitTimer=window.setTimeout(markStartupComplete,exitDurationMs);
		},status==='loading'?maximumStartupWaitMs:0);
		return()=>{
			window.clearTimeout(timer);
			if(exitTimer!==undefined)window.clearTimeout(exitTimer);
		};
	},[markStartupComplete,ready,startupMode,status]);

	return <div className="app-shell" onClickCapture={handleNavigationClick}>
		<div className="aurevia-scroll-progress" aria-hidden="true"/>
		<div className="scene-depth" aria-hidden="true"/>
		<div className="scene-content"><div inert={showStartup||showIntro} aria-hidden={showStartup||showIntro}>{children}</div>
			{startupMode==='loading'&&<AureviaStartupLoader isExiting={isExiting}/>}
			{showPageTransition&&<div className="page-transition-loader">
				<AureviaLoading variant="inline" label="Loading the next page"/>
			</div>}
			{pathname==='/'&&<AureviaStartup isVisible={showIntro} isExiting={isIntroExiting} onSkip={finishIntro} onReplay={replayIntro}/>}
		</div>
	</div>;
}
