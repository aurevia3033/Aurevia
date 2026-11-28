'use client';

import Image from 'next/image';
import {useEffect,useRef,useState} from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const DISMISS_KEY='aurevia-pwa-install-dismissed';

export default function PwaInstallPrompt(){
  const [prompt,setPrompt]=useState<BeforeInstallPromptEvent | null>(null);
  const [visible,setVisible]=useState(false);
  const [manualInstall,setManualInstall]=useState(false);
  const [isIos,setIsIos]=useState(false);
  const [updateAvailable,setUpdateAvailable]=useState(false);
  const registration=useRef<ServiceWorkerRegistration|null>(null);
  const reloadAfterUpdate=useRef(false);

  useEffect(()=>{
    if(typeof window==='undefined')return;
    let updateFoundListener:(()=>void)|undefined;
    let cancelled=false;
    const userAgent=window.navigator.userAgent;
    const isAppleMobile=/iphone|ipad|ipod/i.test(userAgent)
      ||(window.navigator.platform==='MacIntel'&&window.navigator.maxTouchPoints>1);
    const isStandalone=window.matchMedia('(display-mode: standalone)').matches
      ||Boolean((window.navigator as Navigator&{standalone?:boolean}).standalone);
    const isDismissed=()=>{
      try{return window.localStorage.getItem(DISMISS_KEY)==='1'}
      catch(error){console.warn('Unable to read the Aurevia install preference.',{errorName:error instanceof Error?error.name:'UnknownError'});return false}
    };
    const markDismissed=()=>{
      try{window.localStorage.setItem(DISMISS_KEY,'1')}
      catch(error){console.warn('Unable to save the Aurevia install preference.',{errorName:error instanceof Error?error.name:'UnknownError'})}
    };
    const dismissed=isDismissed();
    setIsIos(isAppleMobile);
    if(!dismissed&&!isStandalone){
      if(isAppleMobile){setManualInstall(true);setVisible(true)}
      else if(/android/i.test(userAgent))setVisible(true);
    }

    const handleBeforeInstallPrompt=(event:Event)=>{
      if(isAppleMobile||isStandalone||dismissed)return;
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const handleAppInstalled=()=>{
      setVisible(false);
      markDismissed();
    };
    const handleControllerChange=()=>{
      if(reloadAfterUpdate.current)window.location.reload();
    };
    const refreshServiceWorker=()=>{
      if(document.visibilityState!=='visible')return;
      const currentRegistration=registration.current;
      if(currentRegistration)void currentRegistration.update().catch(error=>{
        console.error('Aurevia service worker refresh failed.',error);
      });
    };
    window.addEventListener('beforeinstallprompt',handleBeforeInstallPrompt);
    window.addEventListener('appinstalled',handleAppInstalled);
    window.addEventListener('online',refreshServiceWorker);
    document.addEventListener('visibilitychange',refreshServiceWorker);
    const serviceWorkers='serviceWorker' in navigator?navigator.serviceWorker:null;
    const serviceWorkersAvailable=Boolean(
      serviceWorkers
      &&typeof serviceWorkers.addEventListener==='function'
      &&typeof serviceWorkers.register==='function',
    );
    if(serviceWorkersAvailable&&serviceWorkers)serviceWorkers.addEventListener('controllerchange',handleControllerChange);

    if(serviceWorkersAvailable&&serviceWorkers){
      void serviceWorkers.register('/sw.js',{updateViaCache:'none'})
        .then(serviceWorkerRegistration=>{
          if(cancelled||!serviceWorkerRegistration||typeof serviceWorkerRegistration.addEventListener!=='function')return;
          registration.current=serviceWorkerRegistration;
          const offerWaitingUpdate=()=>{
            if(serviceWorkerRegistration.waiting&&serviceWorkers.controller)setUpdateAvailable(true);
          };
          updateFoundListener=()=>{
            const installing=serviceWorkerRegistration.installing;
            if(!installing)return;
            installing.addEventListener('statechange',()=>{
              if(installing.state==='installed'&&serviceWorkers.controller)setUpdateAvailable(true);
            });
          };
          serviceWorkerRegistration.addEventListener('updatefound',updateFoundListener);
          offerWaitingUpdate();
          void serviceWorkers.ready.then(readyRegistration=>{
            const resourceUrls=performance.getEntriesByType('resource').flatMap(resource=>{
              const url=new URL(resource.name,window.location.href);
              const publicAsset=url.pathname==='/aurevia-logo.png'||url.pathname.startsWith('/icons/')
                ||url.pathname.startsWith('/images/')||url.pathname.startsWith('/fonts/')
                ||url.pathname.startsWith('/_next/static/');
              return url.origin===window.location.origin&&publicAsset
                &&/\.(?:css|woff2?|ttf|otf|eot|png|jpe?g|webp|svg|ico|js)$/.test(url.pathname)?[url.href]:[];
            });
            const urls=Array.from(new Set(resourceUrls)).slice(0,100);
            if(urls.length)readyRegistration.active?.postMessage({type:'AUREVIA_CACHE_ASSETS',urls});
          }).catch(error=>{
            console.error('Unable to warm Aurevia static assets for offline use.',error);
          });
          void serviceWorkerRegistration.update().catch(error=>{
            console.error('Aurevia service worker update check failed.',error);
          });
        })
        .catch(error=>{
          console.error('Service worker registration failed.', error);
        });
    }
    return()=>{
      window.removeEventListener('beforeinstallprompt',handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled',handleAppInstalled);
      window.removeEventListener('online',refreshServiceWorker);
      document.removeEventListener('visibilitychange',refreshServiceWorker);
      if(serviceWorkersAvailable&&serviceWorkers){
        serviceWorkers.removeEventListener('controllerchange',handleControllerChange);
        if(updateFoundListener)registration.current?.removeEventListener('updatefound',updateFoundListener);
      }
      cancelled=true;
    };
  },[]);

  if(!visible&&!updateAvailable)return null;

  const install=async()=>{
    if(isIos){
      setManualInstall(true);
      return;
    }
    if(!prompt){
      setManualInstall(true);
      return;
    }
    try{
      await prompt.prompt();
      const choice=await prompt.userChoice;
      if(choice.outcome==='accepted'){
        try{window.localStorage.setItem(DISMISS_KEY,'1')}
        catch(error){console.warn('Unable to save the Aurevia install preference.',{errorName:error instanceof Error?error.name:'UnknownError'})}
      }
      setVisible(false);
      setPrompt(null);
    }catch(error){
      console.error('Aurevia installation prompt failed.',error);
      setManualInstall(true);
    }
  };

  const dismiss=()=>{
    try{window.localStorage.setItem(DISMISS_KEY,'1')}
    catch(error){console.warn('Unable to save the Aurevia install preference.',{errorName:error instanceof Error?error.name:'UnknownError'})}
    setVisible(false);
    setPrompt(null);
  };

  const updateNow=()=>{
    const waiting=registration.current?.waiting;
    if(!waiting){
      console.warn('Aurevia update is no longer waiting to activate.');
      setUpdateAvailable(false);
      return;
    }
    reloadAfterUpdate.current=true;
    waiting.postMessage({type:'AUREVIA_SKIP_WAITING'});
  };

  return <>
    {visible&&<div className="pwa-install-banner" role="dialog" aria-live="polite" aria-label="Install Aurevia App">
      <div className="pwa-install-icon-wrap"><Image src="/icons/icon-192.png" alt="Aurevia app icon" width={44} height={44}/></div>
      <div className="pwa-install-copy">
        <strong>{isIos?'Add Aurevia to your Home Screen':'Install Aurevia App'}</strong>
        {!manualInstall&&<p className="pwa-install-tip">Install Aurevia for a standalone app experience on this device.</p>}
        {manualInstall&&isIos&&<p className="pwa-install-tip">In Safari, tap Share, choose “Add to Home Screen”, then tap Add. Open Aurevia from its new home-screen icon.</p>}
        {manualInstall&&!isIos&&<p className="pwa-install-tip">Open your browser menu and choose “Install app” or “Add to Home screen”, then confirm.</p>}
      </div>
      <div className="pwa-install-actions">
        {!isIos&&<button type="button" className="btn bg-gold text-black" onClick={()=>void install()}>Install</button>}
        {!isIos&&!manualInstall&&<button type="button" className="btn bg-white/5" onClick={()=>setManualInstall(true)}>Options</button>}
        <button type="button" className="btn bg-white/5" onClick={dismiss}>Not now</button>
      </div>
    </div>}
    {updateAvailable&&<div className="pwa-update-banner" role="status" aria-live="polite">
      <span>Aurevia update ready. Your locally stored data will be preserved.</span>
      <button type="button" className="btn bg-gold text-black" onClick={updateNow}>Update now</button>
      <button type="button" className="btn bg-white/5" onClick={()=>setUpdateAvailable(false)}>Later</button>
    </div>}
  </>;
}
