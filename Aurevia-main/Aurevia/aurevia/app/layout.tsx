import type {ReactNode} from 'react';
import {cookies,headers} from 'next/headers';
import Script from 'next/script';
import './globals.css';
import './kyc-camera.css';
import './status-notice.css';
import './policy-consent.css';
import './experience.css';
import './cinematic-interactions.css';
import './registration.css';
import './aurevia-loading.css';
import './cinematic-intro.css';
import './theme.css';
import '@/styles/appearance-settings.css';
import '@/styles/platform-upgrade.css';
import '@/styles/device-fit.css';
import 'swiper/css';
import 'swiper/css/effect-fade';
import StartupShell from '@/components/StartupShell';
import Providers from '@/components/Providers';
import AppearanceBootstrap from '@/components/AppearanceBootstrap';
import {normalizeLocale} from '@/lib/i18n';
import {getServerSession} from 'next-auth';
import type {Session} from 'next-auth';
import {authOptions} from '@/lib/auth-options';
import {isTheme,type Theme} from '@/lib/theme';

export const metadata={
  title:'Aurevia Exchange',
  description:'Aurevia Exchange — a secure, account-first digital markets platform',
  manifest:'/manifest.webmanifest',
  applicationName:'Aurevia Exchange',
  appleWebApp:{capable:true,title:'Aurevia Exchange',statusBarStyle:'black-translucent'},
  formatDetection:{telephone:false,email:false,address:false},
  icons:[
    {rel:'icon',url:'/icons/icon-192.png',sizes:'192x192',type:'image/png'},
    {rel:'icon',url:'/icons/icon-512.png',sizes:'512x512',type:'image/png'},
    {rel:'apple-touch-icon',url:'/icons/icon-192.png'},
  ],
  other:{
    'mobile-web-app-capable':'yes',
    'apple-mobile-web-app-capable':'yes',
    'apple-mobile-web-app-status-bar-style':'black-translucent',
  },
};
/** Fits phones, tablets, desktops, foldables; respects browser zoom accessibility. */
export const viewport={
  width:'device-width',
  initialScale:1,
  minimumScale:1,
  maximumScale:5,
  userScalable:true,
  viewportFit:'cover',
  themeColor:[
    {media:'(prefers-color-scheme: light)',color:'#F7F8F5'},
    {media:'(prefers-color-scheme: dark)',color:'#07110D'},
  ],
  colorScheme:'dark light',
};

export default async function RootLayout({children}:{children:ReactNode}){
  const cookieStore=await cookies();
  const initialLocale=normalizeLocale(cookieStore.get('aurevia-locale')?.value ?? null);
  const direction=initialLocale==='ar'?'rtl':'ltr';
  const anonymousPreference=cookieStore.get('aurevia-anonymous-theme')?.value;
  const initialTheme:Theme=isTheme(anonymousPreference)?anonymousPreference:'forest-green';
  let initialUserId:string|null=null;
  const isPublicLandingPage=(await headers()).get('x-aurevia-public-landing')==='1';
  const initialSession:Session|null|undefined=isPublicLandingPage?undefined:await getServerSession(authOptions);
  if(initialSession?.user?.id&&(initialSession.user.role==='USER'||initialSession.user.role==='ADMIN'))initialUserId=initialSession.user.id;
  const legacyTheme=initialTheme==='premium-dashboard'?'light':'dark';
  const themeBootstrap=`try{const root=document.documentElement;if(root.dataset.themeAccount!=='true'){const cookie=document.cookie.split('; ').find(value=>value.startsWith('aurevia-anonymous-theme='))?.split('=')[1];let theme=cookie==='premium-dashboard'?'premium-dashboard':cookie==='forest-green'?'forest-green':root.dataset.themeName;const cached=localStorage.getItem('aurevia-anonymous-theme');if(cached==='premium-dashboard'||cached==='forest-green')theme=cached;else{const legacy=localStorage.getItem('aurevia-theme');if(legacy==='light')theme='premium-dashboard';else if(legacy==='dark')theme='forest-green'}root.dataset.themeName=theme;root.dataset.theme=theme==='premium-dashboard'?'light':'dark';if(cookie!=='premium-dashboard'&&cookie!=='forest-green')document.cookie='aurevia-anonymous-theme='+theme+'; Path=/; Max-Age=31536000; SameSite=Lax';localStorage.removeItem('aurevia-theme')}root.style.colorScheme=root.dataset.themeName==='premium-dashboard'?'light':'dark';root.style.backgroundColor=root.dataset.themeName==='premium-dashboard'?'#F7F8F5':'#07110D';const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=root.dataset.themeName==='premium-dashboard'?'#F7F8F5':'#07110D'}catch{}try{const prefs=JSON.parse(localStorage.getItem('aurevia-appearance-prefs')||'{}');if(prefs.accent)root.dataset.accent=prefs.accent;if(prefs.textSize)root.dataset.textSize=prefs.textSize;if(prefs.uiStyle)root.dataset.uiStyle=prefs.uiStyle}catch{}`;
  return <html lang={initialLocale} dir={direction} data-theme={legacyTheme} data-theme-name={initialTheme} data-theme-account={initialUserId?'true':'false'} style={{backgroundColor:initialTheme==='premium-dashboard'?'#F7F8F5':'#07110D'}} suppressHydrationWarning><body><Script id="aurevia-startup-state" strategy="beforeInteractive">{themeBootstrap}</Script><Providers initialLocale={initialLocale} initialTheme={initialTheme} initialUserId={initialUserId} initialSession={initialSession}><AppearanceBootstrap/><StartupShell>{children}</StartupShell></Providers></body></html>;
}
