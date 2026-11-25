'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {ArrowDownLeft,ArrowLeft,ArrowUpRight,Clock3,RefreshCw,WalletCards} from 'lucide-react';
import Nav from '@/components/Nav';
import DisplayCurrencyPanel from '@/components/DisplayCurrencyPanel';
import {formatUsd} from '@/lib/currency-format';

type FundingRecord={id:string;type:'DEPOSIT'|'WITHDRAWAL';method:string;amount:string|number;currency:string;status:string;accountMode:'DEMO'|'REAL';createdAt:string;updatedAt:string};
type WalletData={accountMode:'DEMO'|'REAL';transactions:FundingRecord[];type:Filter;page:number;pageSize:number;pageCount:number;filteredCount:number;totalCount:number;pendingCount:number;totalUsdDeposits:string|number;totalUsdWithdrawals:string|number};
type Filter='ALL'|'DEPOSIT'|'WITHDRAWAL';

const statusLabels:Record<string,string>={PENDING:'Pending',PENDING_REVIEW:'Pending review',PROCESSING:'Processing',APPROVED:'Approved',COMPLETED:'Completed',REJECTED:'Rejected',CANCELLED:'Cancelled'};
const money=(value:string|number,currency:string)=>currency.toUpperCase()==='USD'?formatUsd(value):`${Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:8})} ${currency}`;

export default function TransactionsPage(){
	const {data:session,status:sessionStatus}=useSession();
	const activeMode=session?.user?.accountMode;
	const [data,setData]=useState<WalletData|null>(null);
	const [filter,setFilter]=useState<Filter>('ALL');
	const [loading,setLoading]=useState(true);
	const [error,setError]=useState('');
	const [historyHidden,setHistoryHidden]=useState(true);
	const [historyPreferenceReady,setHistoryPreferenceReady]=useState(false);
	const [preferenceError,setPreferenceError]=useState('');
	const [page,setPage]=useState(1);
	const latestRequest=useRef(0);
	const inFlightRequests=useRef(new Set<string>());
	const preferenceKey=session?.user?.id&&activeMode?`aurevia:funding-history:hidden:${session.user.id}:${activeMode}`:null;

	const load=useCallback(async(showLoading=false)=>{
		const requestKey=`${session?.user?.id??'anonymous'}:${activeMode??'unknown'}:${filter}:${page}`;
		if(inFlightRequests.current.has(requestKey))return;
		inFlightRequests.current.add(requestKey);
		const requestId=++latestRequest.current;
		if(showLoading)setLoading(true);
		setError('');
		try{const query=new URLSearchParams({type:filter,page:String(page)});const response=await fetch(`/api/wallet/transactions?${query}`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to load transaction history.');if(requestId===latestRequest.current){setData(result);setPage(result.page)}}
		catch(exception){if(requestId===latestRequest.current)setError(exception instanceof Error?exception.message:'Unable to load transaction history.')}
		finally{inFlightRequests.current.delete(requestKey);if(requestId===latestRequest.current)setLoading(false)}
	},[activeMode,filter,page,session?.user?.id]);
	useEffect(()=>{
		if(sessionStatus!=='authenticated')return;
		void load(true);
		const refresh=()=>{if(document.visibilityState==='visible')void load()};
		const timer=window.setInterval(refresh,15_000);
		window.addEventListener('focus',refresh);
		document.addEventListener('visibilitychange',refresh);
		return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
	},[load,sessionStatus,activeMode]);
	useEffect(()=>{setData(null);setPage(1)},[activeMode]);
	useEffect(()=>{
		setHistoryPreferenceReady(false);
		setPreferenceError('');
		if(sessionStatus==='loading')return;
		if(sessionStatus!=='authenticated'||!preferenceKey){setHistoryPreferenceReady(true);return}
		try{setHistoryHidden(window.localStorage.getItem(preferenceKey)!=='false')}
		catch{setPreferenceError('History visibility could not be loaded from this browser.')}
		finally{setHistoryPreferenceReady(true)}
	},[preferenceKey,sessionStatus]);
	const setHistoryVisibility=(hidden:boolean)=>{
		if(!preferenceKey){setPreferenceError('Sign in again to change transaction history visibility.');return}
		try{window.localStorage.setItem(preferenceKey,String(hidden));setHistoryHidden(hidden);setPreferenceError('')}
		catch{setPreferenceError('History visibility could not be saved in this browser.')}
	};
	const pageIsCurrent=data?.page===page&&data.type===filter;
	const transactions=pageIsCurrent?data.transactions:[];
	const pageCount=data?.pageCount??1;
	const displayValues=transactions.filter(item=>item.currency.toUpperCase()==='USD').slice(0,5).map(item=>({label:`${item.type==='DEPOSIT'?'Deposit':'Withdrawal'} · ${item.method}`,amount:String(item.amount)}));

	return <><Nav/><main className="account-page transaction-history-page wallet-transactions-page">
		<Link href="/dashboard" className="text-link"><ArrowLeft size={15}/> Back to account</Link>
		<header className="account-heading wallet-transactions-heading mt-5"><div><span className="account-kicker">{data?.accountMode||'ACCOUNT'} · WALLET</span><h1>Transaction history</h1></div><div className="wallet-transactions-heading-actions"><span className={`status-pill ${data?.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{data?`${data.accountMode} ACCOUNT`:'Loading account'}</span><Link href="/wallet" className="wallet-transactions-wallet-link"><WalletCards size={15}/> Open wallet</Link></div></header>
		{preferenceError&&<div className="account-callout mb-3" role="alert">{preferenceError}</div>}
		{!historyPreferenceReady?<section className="account-panel card p-5" role="status">Loading history…</section>:historyHidden?<section className="account-panel card p-5"><div className="account-panel-title"><div><h2>Transaction history hidden</h2></div><button type="button" className="btn min-h-10 bg-white/5" onClick={()=>setHistoryVisibility(false)}>View history</button></div></section>:<>
		<section className="wallet-transactions-summary" aria-label="Funding request summary">
			<div><span><WalletCards size={15}/> All requests</span><b>{data?data.totalCount:'—'}</b><small>Deposits and withdrawals</small></div>
			<div><span><Clock3 size={15}/> In progress</span><b>{data?data.pendingCount:'—'}</b><small>Pending, review, or processing</small></div>
			<div><span><ArrowDownLeft size={15}/> USD deposits</span><b>{data?formatUsd(data.totalUsdDeposits):'—'}</b><small>Requested amount · USD only</small></div>
			<div><span><ArrowUpRight size={15}/> USD withdrawals</span><b>{data?formatUsd(data.totalUsdWithdrawals):'—'}</b><small>Requested amount · USD only</small></div>
		</section>
		<DisplayCurrencyPanel values={displayValues}/>
		<section className="account-panel card p-5 wallet-transactions-panel"><div className="account-panel-title"><div><span className="account-kicker">ACCOUNT ACTIVITY</span><h2><WalletCards size={17} className="gold"/> Funding requests</h2><p className="account-panel-subtitle">Each request shows its latest recorded review state. A request is not confirmation of payment or settlement.</p></div><button type="button" className="icon-action" aria-label="Refresh transaction history" onClick={()=>void load(true)}><RefreshCw size={15}/></button></div>
			<div className="mb-3 flex justify-end"><button type="button" className="text-link" disabled={!historyPreferenceReady} onClick={()=>setHistoryVisibility(true)}>Hide history</button></div>
			<div className="transaction-history-filters" role="group" aria-label="Filter transactions">{(['ALL','DEPOSIT','WITHDRAWAL'] as const).map(value=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>{setFilter(value);setPage(1)}}>{value==='ALL'?'All':value==='DEPOSIT'?'Deposits':'Withdrawals'}</button>)}</div>
			{error?<div className="account-empty transaction-history-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={()=>void load(true)}><RefreshCw size={14}/> Retry</button></div>:loading&&!pageIsCurrent?<div className="account-empty" role="status">Loading history…</div>:transactions.length?<><div className="transaction-history-list">{transactions.map(item=><Link className="transaction-history-row" href={`/wallet/transactions/${encodeURIComponent(item.id)}`} key={item.id}><span className={`transaction-history-icon ${item.type==='DEPOSIT'?'is-deposit':'is-withdrawal'}`}>{item.type==='DEPOSIT'?<ArrowDownLeft size={17}/>:<ArrowUpRight size={17}/>}</span><span className="transaction-history-main"><b>{item.type==='DEPOSIT'?'Deposit':'Withdrawal'} · {item.method}</b><small>{item.id}</small><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span><span className="transaction-history-amount">{money(item.amount,item.currency)}<small className={`status-pill status-${item.status.toLowerCase().replaceAll('_','-')}`}>{statusLabels[item.status]||item.status.replaceAll('_',' ')}</small></span></Link>)}</div><div className="activity-pagination"><span>Page {page} of {pageCount} · {data?.filteredCount??0} requests</span><div className="flex gap-2"><button type="button" className="button-secondary" disabled={page<=1} onClick={()=>setPage(value=>Math.max(1,value-1))}><ArrowLeft size={13}/>Previous</button><button type="button" className="button-secondary" disabled={page>=pageCount} onClick={()=>setPage(value=>Math.min(pageCount,value+1))}>Next<ArrowUpRight size={13}/></button></div></div></>:<div className="notification-empty-state"><WalletCards size={25} aria-hidden="true"/><h3>{data?.totalCount?'No matching requests':'No transactions yet'}</h3><p>{data?.totalCount?'Choose another filter to see your requests.':'Funding requests will appear here after you submit them.'}</p><Link href="/wallet" className="text-link">Open wallet</Link></div>}
		</section>
		</>}
	</main></>;
}