'use client';

import Image from 'next/image';
import {useEffect,useState} from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const DISMISS_KEY='aurevia-pwa-install-dismissed';

export default function PwaInstallPrompt(){
  const [prompt,setPrompt]=useState<BeforeInstallPromptEvent | null>(null);
  const [visible,setVisible]=useState(false);
  const [manualInstall,setManualInstall]=useState(false);

  useEffect(()=>{
    if(typeof window==='undefined')return;
    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(registration=>registration.update()).catch(error=>{
        console.error('Service worker registration failed.', error);
      });
    }
    const dismissed=window.localStorage.getItem(DISMISS_KEY)==='1';
    const standalone=window.matchMedia('(display-mode: standalone)').matches;
    if(dismissed||standalone){return;}
    const isAndroid=/android/i.test(window.navigator.userAgent);
    if(!isAndroid){return;}

    setVisible(true);
    const handleBeforeInstallPrompt=(event:Event)=>{
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const handleAppInstalled=()=>{
      setVisible(false);
      window.localStorage.setItem(DISMISS_KEY,'1');
    };

    window.addEventListener('beforeinstallprompt',handleBeforeInstallPrompt);
    window.addEventListener('appinstalled',handleAppInstalled);
    return()=>{
      window.removeEventListener('beforeinstallprompt',handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled',handleAppInstalled);
    };
  },[]);

  if(!visible)return null;

  const install=async()=>{
    if(!prompt){
      setManualInstall(true);
      return;
    }
    await prompt.prompt();
    const choice=await prompt.userChoice;
    if(choice.outcome==='accepted'){
      window.localStorage.setItem(DISMISS_KEY,'1');
    }
    setVisible(false);
    setPrompt(null);
  };

  const dismiss=()=>{
    window.localStorage.setItem(DISMISS_KEY,'1');
    setVisible(false);
    setPrompt(null);
  };

  return <div className="pwa-install-banner" role="dialog" aria-live="polite" aria-label="Install Aurevia App">
    <div className="pwa-install-icon-wrap"><Image src="/icons/icon-192.png" alt="Aurevia app icon" width={44} height={44}/></div>
    <div className="pwa-install-copy">
      <strong>Install Aurevia App</strong>
      {!manualInstall&&<p className="pwa-install-tip">If the prompt does not appear, open the browser menu and choose Install app.</p>}
      {manualInstall&&<p className="pwa-install-tip">Open Chrome’s menu, tap Install app, then confirm to add Aurevia to your home screen.</p>}
    </div>
    <div className="pwa-install-actions">
      <button type="button" className="btn bg-gold text-black" onClick={()=>void install()}>Install</button>
      <button type="button" className="btn bg-white/5" onClick={()=>{setManualInstall(value=>!value);}}>Options</button>
      <button type="button" className="btn bg-white/5" onClick={dismiss}>Not now</button>
    </div>
  </div>;
}
