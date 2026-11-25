'use client';

import {useEffect,useState} from 'react';
import {Check,ChevronDown,Globe,Languages,LoaderCircle,Wallet} from 'lucide-react';
import {useLocale} from '@/lib/i18n-context';
import {localeMeta,locales,type Locale} from '@/lib/i18n';
import {SUPPORTED_CURRENCIES,type SupportedCurrency} from '@/lib/config/simulation';

const currencyNames:Record<SupportedCurrency,string>={USD:'US Dollar',EUR:'Euro',GBP:'British Pound',NGN:'Nigerian Naira',CAD:'Canadian Dollar',AUD:'Australian Dollar',CHF:'Swiss Franc',JPY:'Japanese Yen'};
const currencySymbols:Record<SupportedCurrency,string>={USD:'$',EUR:'€',GBP:'£',NGN:'₦',CAD:'C$',AUD:'A$',CHF:'CHF',JPY:'¥'};

export default function AccountAppPreferences(){
  const {locale,setLocale}=useLocale();
  const [currency,setCurrency]=useState<SupportedCurrency>('USD');
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<'language'|'currency'|null>(null);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  useEffect(()=>{
    let active=true;
    Promise.all([fetch('/api/currency-preference',{cache:'no-store'}),fetch('/api/language-preference',{cache:'no-store'})]).then(async([currencyResponse,languageResponse])=>{
      const [currencyData,languageData]=await Promise.all([currencyResponse.json(),languageResponse.json()]);
      if(!currencyResponse.ok)throw new Error(currencyData.error||'Unable to load currency preference.');
      if(!languageResponse.ok)throw new Error(languageData.error||'Unable to load language preference.');
      if(!active)return;
      if(SUPPORTED_CURRENCIES.includes(currencyData.currency))setCurrency(currencyData.currency);
      if(locales.includes(languageData.locale))setLocale(languageData.locale as Locale);
    }).catch(exception=>{if(active)setError(exception instanceof Error?exception.message:'Unable to load app preferences.')}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[setLocale]);
  async function saveLanguage(next:Locale){
    if(next===locale||busy)return;setBusy('language');setError('');setMessage('');
    try{const response=await fetch('/api/language-preference',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({locale:next})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save language.');setLocale(next);setMessage('Language preference saved across your account.');}
    catch(exception){setError(exception instanceof Error?exception.message:'Unable to save language preference.');}
    finally{setBusy(null)}
  }
  async function saveCurrency(next:SupportedCurrency){
    if(next===currency||busy)return;setBusy('currency');setError('');setMessage('');
    try{const response=await fetch('/api/currency-preference',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({currency:next})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to save currency.');setCurrency(next);window.dispatchEvent(new CustomEvent('aurevia:display-currency-change',{detail:{currency:next}}));setMessage('Display currency saved. This changes display preferences, not wallet balances or ledger entries.');}
    catch(exception){setError(exception instanceof Error?exception.message:'Unable to save currency preference.');}
    finally{setBusy(null)}
  }
  return <section className="account-panel card settings-app-preferences" aria-labelledby="settings-app-preferences-title">
    <div className="account-panel-title"><div><span className="settings-app-preferences-eyebrow">PERSONALIZATION</span><h2 id="settings-app-preferences-title">App preferences</h2></div><Globe size={18} className="gold"/></div>
    <div className="settings-app-preference-grid">
      <fieldset className="settings-app-preference-field" disabled={loading||busy!==null}>
        <legend><span className="settings-app-preference-icon"><Languages size={16}/></span><span><b>App language</b><small>Interface and reading direction</small></span></legend>
        <div className="settings-app-preference-select">
          <select aria-label="App language" className="input" value={locale} onChange={event=>void saveLanguage(event.target.value as Locale)}>{locales.map(value=><option key={value} value={value}>{localeMeta[value].flag}  {localeMeta[value].nativeName}</option>)}</select>
          <ChevronDown size={15} aria-hidden="true"/>
        </div>
        <p className="settings-app-preference-note">Arabic automatically uses right-to-left layout.</p>
      </fieldset>
      <fieldset className="settings-app-preference-field settings-currency-preference" disabled={loading||busy!==null}>
        <legend><span className="settings-app-preference-icon"><Wallet size={16}/></span><span><b>Preferred display currency</b><small>Presentation only — ledger values stay unchanged</small></span></legend>
        <div className="settings-currency-summary" aria-live="polite">
          <span className="settings-currency-symbol" aria-hidden="true">{currencySymbols[currency]}</span>
          <span><b>{currency}</b><small>{currencyNames[currency]}</small></span>
          <span className="settings-currency-saved"><Check size={12}/> Account preference</span>
        </div>
        <div className="settings-app-preference-select">
          <select aria-label="Preferred display currency" className="input" value={currency} onChange={event=>void saveCurrency(event.target.value as SupportedCurrency)}>{SUPPORTED_CURRENCIES.map(value=><option key={value} value={value}>{value} · {currencyNames[value]}</option>)}</select>
          <ChevronDown size={15} aria-hidden="true"/>
        </div>
        <p className="settings-app-preference-note">This changes display formatting only. It never credits, debits or converts wallet balances.</p>
      </fieldset>
    </div>
    {loading&&<p className="muted text-sm" role="status"><LoaderCircle size={14} className="mr-2 inline animate-spin"/>Loading account preferences…</p>}
    {busy&&<p className="muted text-sm" role="status"><LoaderCircle size={14} className="mr-2 inline animate-spin"/>Saving {busy==='language'?'language':'currency'} preference…</p>}
    {error&&<p className="account-callout" role="alert">{error}</p>}
    {message&&<p className="text-sm text-profit" role="status"><Check size={14} className="mr-1 inline"/>{message}</p>}
  </section>;
}
