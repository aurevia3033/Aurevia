'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import Link from 'next/link';
import {ArrowLeft,ExternalLink,Eye,EyeOff,RefreshCw,Search,ShieldCheck,Trash2,Users} from 'lucide-react';
import AdminNav from '@/components/AdminNav';

type TierRequest={
	id:string;currentTier:number;requestedTier:number;status:'PENDING_REVIEW'|'NEEDS_INFORMATION'|'APPROVED'|'REJECTED';
	userMessage:string|null;adminReason:string|null;createdAt:string;reviewedAt:string|null;
	user:{id:string;name:string|null;email:string;accountMode:'DEMO'|'REAL';kycStatus:string;approvedTier:number;phone:string|null;phoneVerified:boolean;country:string|null;kyc:{submittedAt:string|null}|null;kycDocuments:Array<{id:string;status:string}>};
	reviewedBy:{name:string|null;email:string}|null;
};
type TierAccount={
	id:string;email:string;name:string|null;country:string|null;phone:string|null;status:string;accountMode:'DEMO'|'REAL';kycStatus:string;approvedTier:number;currentTier:number;createdAt:string;
	requirements:{nameComplete:boolean;countryComplete:boolean;phoneComplete:boolean;phoneVerified:boolean;profileComplete:boolean;verificationSubmitted:boolean;identityDocumentUploaded:boolean;identityDocumentApproved:boolean;identityApproved:boolean};
	tierRequests:Array<{id:string;currentTier:number;requestedTier:number;status:string;adminReason:string|null;reviewedAt:string|null;createdAt:string;reviewedBy:{name:string|null;email:string}|null}>;
};
type AdminData={requests:TierRequest[];accounts:TierAccount[];total:number;page:number;pageSize:number;totalPages:number};
type Outcome='NEEDS_INFORMATION'|'APPROVED'|'REJECTED';

const emptyData:AdminData={requests:[],accounts:[],total:0,page:1,pageSize:50,totalPages:0};
const hiddenAccountsStorageKey='aurevia-admin-hidden-tier-accounts';

export default function AdminTierReviews(){
	const [data,setData]=useState<AdminData>(emptyData);
	const [selectedId,setSelectedId]=useState('');
	const [reason,setReason]=useState('');
	const [filter,setFilter]=useState('PENDING_REVIEW');
	const [searchDraft,setSearchDraft]=useState('');
	const [search,setSearch]=useState('');
	const [tierFilter,setTierFilter]=useState('');
	const [statusFilter,setStatusFilter]=useState('');
	const [page,setPage]=useState(1);
	const [notice,setNotice]=useState('');
	const [error,setError]=useState('');
	const [busy,setBusy]=useState(false);
	const [busyAccountId,setBusyAccountId]=useState('');
	const [loading,setLoading]=useState(true);
	const [hiddenAccountIds,setHiddenAccountIds]=useState<string[]>([]);
	const [showHiddenAccounts,setShowHiddenAccounts]=useState(false);
	const selected=data.requests.find(item=>item.id===selectedId);
	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const params=new URLSearchParams({page:String(page)});
			if(search)params.set('search',search);
			if(tierFilter)params.set('tier',tierFilter);
			if(statusFilter)params.set('status',statusFilter);
			const response=await fetch(`/api/admin/tier-requests?${params}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Administrator authorization required.');
			setData(result);
			setError('');
			setSelectedId(current=>result.requests.some((item:TierRequest)=>item.id===current)?current:result.requests.find((item:TierRequest)=>item.status===filter)?.id||result.requests[0]?.id||'');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load tier records.')}
		finally{setLoading(false)}
	},[filter,page,search,statusFilter,tierFilter]);
	useEffect(()=>{void load()},[load]);
	useEffect(()=>{
		try{
			const stored=window.localStorage.getItem(hiddenAccountsStorageKey);
			if(!stored)return;
			const parsed:unknown=JSON.parse(stored);
			if(Array.isArray(parsed)&&parsed.every(item=>typeof item==='string'))setHiddenAccountIds(parsed);
			else throw new Error('Saved hidden-account settings are invalid.');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load hidden-account settings.');
		}
	},[]);
	const visibleRequests=data.requests.filter(item=>filter==='ALL'||item.status===filter);
	const hiddenAccountSet=new Set(hiddenAccountIds);
	const visibleAccounts=data.accounts.filter(account=>hiddenAccountSet.has(account.id)===showHiddenAccounts);

	function applySearch(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setPage(1);
		setSearch(searchDraft.trim());
	}

	async function review(status:Outcome){
		if(!selected||busy||reason.trim().length<3)return;
		setBusy(true);setNotice('');setError('');
		try{
			const response=await fetch('/api/admin/tier-requests',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:selected.id,status,reason:reason.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save tier review.');
			setNotice(status==='APPROVED'?'Tier 3 approved and recorded.':status==='REJECTED'?'Tier request rejected.':'More information requested.');
			setReason('');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save tier review.')}
		finally{setBusy(false)}
	}

	function updateHiddenAccounts(account:TierAccount,hide:boolean){
		const next=hide?[...new Set([...hiddenAccountIds,account.id])]:hiddenAccountIds.filter(id=>id!==account.id);
		try{
			window.localStorage.setItem(hiddenAccountsStorageKey,JSON.stringify(next));
			setHiddenAccountIds(next);
			setNotice(hide?`${account.name||account.email} hidden from this tiers list on this browser.`:`${account.name||account.email} restored to this tiers list.`);
			setError('');
		}catch(exception){
			setError(exception instanceof Error?`Could not save this view preference: ${exception.message}`:'Could not save this view preference.');
		}
	}

	async function moveToDeletedItems(account:TierAccount){
		if(busy)return;
		if(!window.confirm(`Move ${account.email} to Deleted Items? This disables sign-in. An administrator can restore the account later.`))return;
		setBusy(true);setBusyAccountId(account.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/users',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({userId:account.id,status:'DELETED'})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to move this account to Deleted Items.');
			setNotice(`Account ${account.email} moved to Deleted Items. Sign-in is disabled; the account can be restored in User Accounts.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to move this account to Deleted Items.')}
		finally{setBusy(false);setBusyAccountId('')}
	}

	return <><AdminNav/><main className="account-page admin-tier-page">
		<header className="account-heading admin-tier-hero"><div><span className="account-kicker">ADMINISTRATION · ACCOUNT ACCESS</span><h1>Tier management</h1><p>Review account progression, manage customer visibility, and handle access changes with audited controls.</p></div><div className="admin-tier-hero-actions"><Link className="button-secondary" href="/admin"><ArrowLeft size={14}/> Admin home</Link><button className="icon-action" type="button" aria-label="Refresh tier records" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/></button></div></header>
		{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mb-3 text-sm text-loss" role="alert">{error}</p>}
		<div className="admin-support-layout">
			<aside className="account-panel card p-4 admin-tier-queue"><div className="account-panel-title"><div><h2>Review queue</h2><p className="account-panel-subtitle">{visibleRequests.length} shown · {data.requests.length} loaded</p></div><ShieldCheck size={18} className="gold"/></div><label className="account-label">Request status<select className="input" value={filter} onChange={event=>setFilter(event.target.value)}><option value="PENDING_REVIEW">Pending review</option><option value="NEEDS_INFORMATION">Needs information</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="ALL">All requests</option></select></label>{loading?<p className="account-empty">Loading tier records…</p>:visibleRequests.length?<div className="support-ticket-list">{visibleRequests.map(item=><button key={item.id} type="button" className={`support-inbox-item ${selectedId===item.id?'is-selected':''}`} onClick={()=>setSelectedId(item.id)}><b>Tier {item.currentTier} → Tier {item.requestedTier}</b><span>{item.user.name||item.user.email}</span><small>{item.status.replaceAll('_',' ')} · {item.user.accountMode}</small><small>{new Date(item.createdAt).toLocaleString()}</small></button>)}</div>:<p className="account-empty">No tier requests in this state.</p>}</aside>
			<section className="account-panel card p-5 admin-tier-review">{!selected?<div className="account-empty">Choose a request to review.</div>:<><div className="account-panel-title"><div><span className="status-pill mode-demo">{selected.status.replaceAll('_',' ')}</span><h2 className="mt-3">{selected.user.name||'Account holder'}</h2><p className="account-panel-subtitle">{selected.user.email} · Tier {selected.currentTier} to Tier {selected.requestedTier}</p></div><span className="muted text-xs">{new Date(selected.createdAt).toLocaleString()}</span></div><dl className="support-context"><div><dt>Account</dt><dd>{selected.user.accountMode} · current persisted tier {selected.user.approvedTier}</dd></div><div><dt>Profile requirements</dt><dd>Name {selected.user.name?'complete':'missing'} · country {selected.user.country?'complete':'missing'} · phone {selected.user.phone?'provided':'missing'} ({selected.user.phoneVerified?'verified':'not verified'})</dd></div><div><dt>Identity review</dt><dd>{selected.user.kycStatus} · submitted {selected.user.kyc?.submittedAt?'yes':'no'} · identity documents {selected.user.kycDocuments.length} ({selected.user.kycDocuments.map(document=>document.status).join(', ')||'none'})</dd></div><div><dt>User note</dt><dd>{selected.userMessage||'No note provided.'}</dd></div>{selected.reviewedBy&&<div><dt>Previous review</dt><dd>{selected.reviewedBy.name||selected.reviewedBy.email} · {selected.adminReason||'No reason recorded'}</dd></div>}</dl>{!['APPROVED','REJECTED'].includes(selected.status)&&<div className="support-admin-reply"><label className="account-label">Required review reason<textarea className="input min-h-24" minLength={3} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Explain the decision or the information needed."/></label><div className="flex flex-wrap gap-2">{selected.requestedTier===3&&<button type="button" className="btn bg-gold text-black" disabled={busy||reason.trim().length<3} onClick={()=>void review('APPROVED')}>Approve Tier 3</button>}<button type="button" className="btn bg-white/5" disabled={busy||reason.trim().length<3} onClick={()=>void review('NEEDS_INFORMATION')}>Request information</button><button type="button" className="btn bg-white/5" disabled={busy||reason.trim().length<3} onClick={()=>void review('REJECTED')}>Reject request</button></div>{selected.requestedTier!==3&&<p className="text-xs muted">Legacy Tier 2 reviews cannot grant access; Tier 2 is automatic after profile completion.</p>}</div>}<p className="mt-4 text-xs leading-5 muted">Tier 3 requires a complete profile and approved KYC identity evidence. Tier status does not bypass separate account, provider, or financial controls.</p></>}</section>
		</div>

		<section className="account-panel card p-4 sm:p-5 mt-5 admin-tier-directory">
			<div className="admin-tier-directory-heading"><div className="admin-tier-directory-icon"><Users size={19}/></div><div><span className="account-kicker">CUSTOMER DIRECTORY</span><h2>Accounts & access</h2><p>{data.total} matching accounts · tier and requirements are recalculated from server records.</p></div><span className="admin-tier-count">{data.total} ACCOUNTS</span></div>
			<form className="admin-tier-filters" onSubmit={applySearch}>
				<label className="account-label">Search name, email, or account ID<input className="input" value={searchDraft} maxLength={120} onChange={event=>setSearchDraft(event.target.value)} placeholder="Find an account…"/></label>
				<label className="account-label">Tier<select className="input" value={tierFilter} onChange={event=>{setTierFilter(event.target.value);setPage(1)}}><option value="">All tiers</option><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option></select></label>
				<label className="account-label">Account status<select className="input" value={statusFilter} onChange={event=>{setStatusFilter(event.target.value);setPage(1)}}><option value="">Active and restricted</option><option value="ACTIVE">Active</option><option value="FROZEN">Frozen</option><option value="SUSPENDED">Suspended</option><option value="CLOSED">Closed</option><option value="DELETED">Deleted Items</option></select></label>
				<button className="btn min-h-11 self-end bg-gold px-4 text-black" type="submit"><Search size={15}/> Search</button>
			</form>
			<div className="admin-tier-list-toolbar"><span>{showHiddenAccounts?`${hiddenAccountIds.length} hidden on this browser`:'Account records'}</span><button type="button" className="admin-tier-text-action" onClick={()=>setShowHiddenAccounts(value=>!value)}><Eye size={14}/>{showHiddenAccounts?'Show accounts':'Show hidden accounts'}{hiddenAccountIds.length>0&&<b>{hiddenAccountIds.length}</b>}</button></div>
			{loading?<p className="account-empty" role="status">Loading accounts…</p>:visibleAccounts.length?<div className="admin-tier-account-list">{visibleAccounts.map(account=><article className={`admin-tier-account ${hiddenAccountSet.has(account.id)?'is-hidden':''}`} key={account.id}>
				<details className="admin-tier-account-details"><summary><span className="admin-tier-account-avatar" aria-hidden="true">{(account.name||account.email).trim().charAt(0).toUpperCase()}</span><span className="admin-tier-account-identity"><b>{account.name||'Account holder'}</b><small>{account.email}</small></span><span className="admin-tier-account-tier">Tier {account.currentTier}</span><span className={`status-pill ${account.accountMode==='REAL'?'mode-real':'mode-demo'}`}>{account.accountMode}</span><span className="admin-tier-account-state">{account.status.replaceAll('_',' ')}</span><span className="admin-tier-account-date">Joined {new Date(account.createdAt).toLocaleDateString()}</span><span className="admin-tier-account-expand">View details</span></summary>
					<div className="admin-tier-account-content"><div className="admin-tier-requirements"><p><b>Profile</b><span>Name {account.requirements.nameComplete?'complete':'missing'} · country {account.requirements.countryComplete?'complete':'missing'} · phone {account.requirements.phoneComplete?'provided':'missing'}</span></p><p><b>Identity</b><span>{account.kycStatus} · submitted {account.requirements.verificationSubmitted?'yes':'no'} · document uploaded {account.requirements.identityDocumentUploaded?'yes':'no'} · approved {account.requirements.identityDocumentApproved?'yes':'no'}</span></p>{account.tierRequests.length>0&&<div className="admin-tier-history"><b>Tier history</b><ul>{account.tierRequests.map(item=><li key={item.id}>Tier {item.currentTier} → {item.requestedTier} · {item.status.replaceAll('_',' ')} · {item.reviewedBy?.name||item.reviewedBy?.email||'reviewer not assigned'} · {item.adminReason||'No review note'}</li>)}</ul></div>}</div>
						<div className="admin-tier-account-actions">
							{hiddenAccountSet.has(account.id)?<button className="btn min-h-10 bg-white/5" type="button" onClick={()=>updateHiddenAccounts(account,false)}><Eye size={14}/>Unhide</button>:<button className="btn min-h-10 bg-white/5" type="button" onClick={()=>updateHiddenAccounts(account,true)}><EyeOff size={14}/>Hide from this list</button>}
							{account.status==='DELETED'?<Link className="btn min-h-10 bg-white/5" href={`/admin/users?search=${encodeURIComponent(account.id)}&showDeleted=true`}><ExternalLink size={14}/>Manage / restore</Link>:account.status!=='CLOSED'&&<button className="btn min-h-10 bg-loss text-black" type="button" disabled={busy} onClick={()=>void moveToDeletedItems(account)}><Trash2 size={14}/>{busyAccountId===account.id?'Moving…':'Move to Deleted Items'}</button>}
							<Link className="admin-tier-permanent-link" href={`/admin/users?search=${encodeURIComponent(account.id)}${account.status==='DELETED'?'&showDeleted=true':''}`}><Trash2 size={13}/>Permanent deletion controls <ExternalLink size={12}/></Link>
						</div>
						<p className="admin-tier-account-footnote">Hide is browser-only. Deleted Items suspends sign-in and allows restore; permanent deactivation uses the guarded user-management workflow.</p>
					</div>
				</details>
			</article>)}</div>:<p className="account-empty">{showHiddenAccounts?'No hidden accounts on this page.':'No accounts match these filters.'}</p>}
			<div className="admin-tier-pagination"><span>Page {data.page} of {Math.max(1,data.totalPages)}</span><div><button className="button-secondary" type="button" disabled={page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}>Previous</button><button className="button-secondary" type="button" disabled={page>=data.totalPages||loading} onClick={()=>setPage(value=>value+1)}>Next</button></div></div>
		</section>
	</main></>;
}
