'use client';

import {type FormEvent,useCallback,useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {Download,Landmark,RefreshCw,ShieldCheck,UsersRound} from 'lucide-react';
import AdminNav from '@/components/AdminNav';

type UserInfo={id:string;name:string|null;email:string;status?:string}|null;
type BankAccountRow={id:string;userId:string;accountIdentifier:string;status:'ACTIVE'|'FROZEN'|'CLOSED';statusReason:string|null;ledgerBalance:string;available:string;reserved:string;user:UserInfo};
type BankOperationRow={id:string;reference:string;type:string;direction:string|null;status:string;userId:string|null;amount:string;currency:string;sourceClassification:string;reason:string;createdAt:string;initiatedById:string|null;user:UserInfo;initiatedBy:{id:string;name:string|null;email:string}|null;reviewedBy:{name:string|null;email:string}|null};
type AdminBankData={treasury:{currency:string;available:string;allocatedFunds:string;internalOnly:true;externalFundsVerified:false;reconciliation:{calculatedBalance:string;difference:string;balanced:boolean}};accounts:BankAccountRow[];pendingOperations:BankOperationRow[];recentOperations:BankOperationRow[]};
type OperationForm={type:'TREASURY_FUNDING'|'TREASURY_ADJUSTMENT'|'WALLET_CREDIT'|'WALLET_DEBIT';direction:'INCREASE'|'DECREASE';userId:string;amount:string;sourceClassification:string;reason:string};
type ActivityFilters={search:string;type:string;from:string;to:string;administratorId:string};

const money=(value:string|number|undefined)=>value===undefined?'—':new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(value));
const readable=(value:string)=>value.replaceAll('_',' ').toLowerCase().replace(/(^|\s)\S/g,letter=>letter.toUpperCase());
const initialForm:OperationForm={type:'TREASURY_FUNDING',direction:'INCREASE',userId:'',amount:'',sourceClassification:'AUTHORIZED_CAPITAL',reason:''};

export default function AdminBankPage(){
	const {data:session}=useSession();
	const [data,setData]=useState<AdminBankData|null>(null);
	const [searchInput,setSearchInput]=useState('');
	const [search,setSearch]=useState('');
	const [activitySearchInput,setActivitySearchInput]=useState('');
	const [typeInput,setTypeInput]=useState('');
	const [fromInput,setFromInput]=useState('');
	const [toInput,setToInput]=useState('');
	const [adminInput,setAdminInput]=useState('');
	const [activityFilters,setActivityFilters]=useState<ActivityFilters>({search:'',type:'',from:'',to:'',administratorId:''});
	const [form,setForm]=useState<OperationForm>(initialForm);
	const [operationKey,setOperationKey]=useState('');
	const [freezeReason,setFreezeReason]=useState('');
	const [accountUserId,setAccountUserId]=useState('');
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const query=new URLSearchParams();
			if(search)query.set('search',search);
			if(activityFilters.search)query.set('activitySearch',activityFilters.search);
			if(activityFilters.type)query.set('type',activityFilters.type);
			if(activityFilters.from)query.set('from',activityFilters.from);
			if(activityFilters.to)query.set('to',activityFilters.to);
			if(activityFilters.administratorId)query.set('administratorId',activityFilters.administratorId);
			const response=await fetch(`/api/admin/bank${query.size?`?${query}`:''}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load Platform Bank.');
			setData(result as AdminBankData);
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load Platform Bank.')}
		finally{setLoading(false)}
	},[activityFilters,search]);

	useEffect(()=>{void load()},[load]);

	function updateForm(field:keyof OperationForm,value:string){
		setForm(current=>({...current,[field]:value}));
		setOperationKey('');
	}

	async function submitOperation(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		const key=operationKey||crypto.randomUUID();
		setOperationKey(key);setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/bank',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
				...form,
				direction:form.type==='TREASURY_ADJUSTMENT'?form.direction:undefined,
				userId:form.type==='WALLET_CREDIT'||form.type==='WALLET_DEBIT'?form.userId:undefined,
				currency:'USD',
				idempotencyKey:key,
			})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit the bank operation.');
			setNotice(`${readable(result.type)} ${result.status==='PENDING'?'submitted for distinct-admin approval':'recorded'} · ${money(result.amount)} USD · ${result.reference}. No funds move until approval.`);
			setForm(initialForm);setOperationKey('');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit the bank operation.')}
		finally{setBusy(false)}
	}

	async function reviewOperation(id:string,decision:'APPROVE'|'REJECT'){
		if(busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch(`/api/admin/bank/operations/${id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({decision})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to review this operation.');
			setNotice(`${readable(result.operation.status)} · ${result.operation.reference}.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to review this operation.')}
		finally{setBusy(false)}
	}

	async function createAccount(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/bank/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:accountUserId.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to open the account.');
			setNotice(`REAL internal account ${result.accountIdentifier} is ready. Existing REAL ledger reused.`);
			setAccountUserId('');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to open the account.')}
		finally{setBusy(false)}
	}

	async function changeAccountStatus(account:BankAccountRow,action:'FREEZE'|'UNFREEZE'){
		if(busy)return;
		if(freezeReason.trim().length<3){setError('Enter an administrative reason of at least three characters.');return}
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch(`/api/admin/bank/accounts/${account.userId}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({action,reason:freezeReason.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update account status.');
			setNotice(`REAL account ${result.accountIdentifier} ${readable(result.status).toLowerCase()}.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update account status.')}
		finally{setBusy(false)}
	}

	function applySearch(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setSearch(searchInput.trim());
	}

	function applyActivityFilters(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setActivityFilters({search:activitySearchInput.trim(),type:typeInput,from:fromInput,to:toInput,administratorId:adminInput.trim()});
	}

	const walletOperation=form.type==='WALLET_CREDIT'||form.type==='WALLET_DEBIT';

	return <>
		<AdminNav/>
		<main className="account-page">
			<header className="account-heading"><div><span className="account-kicker">ADMIN · REAL INTERNAL LEDGER</span><h1>Platform Bank</h1><p>Treasury accounting, customer REAL accounts, and dual-admin financial controls.</p></div><button className="btn bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>Refresh</button></header>
			{error&&<p className="card mt-4 border border-loss/30 p-4 text-sm" role="alert">{error}</p>}
			{notice&&<p className="card mt-4 border border-profit/30 p-4 text-sm text-profit" role="status">{notice}</p>}

			<section className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]">
				<article className="card flex flex-wrap items-center justify-between gap-5 p-5">
					<div className="flex items-center gap-3"><span className="rounded-xl bg-gold/10 p-3 text-gold"><Landmark size={21}/></span><div><span className="account-kicker">REAL INTERNAL TREASURY · USD</span><p className="mt-1 text-2xl font-semibold">{loading?'—':money(data?.treasury.available)}</p><small className="muted">Debit-normal ledger balance · not proof of external funds</small><p className="mt-2 text-xs muted">Net customer allocations · {loading?'—':money(data?.treasury.allocatedFunds)}</p><p className={`mt-1 text-xs ${data?.treasury.reconciliation.balanced?'text-profit':'text-loss'}`}>Ledger reconciliation · {loading?'—':data?.treasury.reconciliation.balanced?'Balanced':'Variance detected'}</p></div></div>
					<a className="btn bg-white/5" href="/api/admin/bank/statement"><Download size={15}/>Export treasury statement</a>
				</article>
				<article className="card flex items-center gap-3 p-5"><UsersRound size={20} className="text-gold"/><div><span className="account-kicker">CUSTOMER REAL ACCOUNTS</span><p className="mt-1 text-2xl font-semibold">{loading?'—':data?.accounts.length??0}</p><small className="muted">Showing up to 30 matches</small></div></article>
			</section>

			<section className="mt-4 grid gap-4 xl:grid-cols-2">
				<form className="card grid gap-3 p-5 sm:grid-cols-2" onSubmit={event=>void submitOperation(event)}>
					<div className="sm:col-span-2"><h2 className="text-lg font-semibold">Request a treasury or REAL wallet operation</h2><p className="mt-1 text-sm muted">Every request waits for approval by a different active administrator. The entry is posted atomically only after approval.</p></div>
					<label className="account-label">Operation<select className="input mt-1" value={form.type} onChange={event=>updateForm('type',event.target.value as OperationForm['type'])}><option value="TREASURY_FUNDING">Treasury funding entry</option><option value="TREASURY_ADJUSTMENT">Treasury adjustment</option><option value="WALLET_CREDIT">Customer REAL wallet credit</option><option value="WALLET_DEBIT">Customer REAL wallet debit</option></select></label>
					{form.type==='TREASURY_ADJUSTMENT'&&<label className="account-label">Adjustment direction<select className="input mt-1" value={form.direction} onChange={event=>updateForm('direction',event.target.value)}><option value="INCREASE">Increase treasury</option><option value="DECREASE">Decrease treasury</option></select></label>}
					{walletOperation&&<label className="account-label">Customer REAL account<select className="input mt-1" required value={form.userId} onChange={event=>updateForm('userId',event.target.value)}><option value="">Select customer</option>{data?.accounts.filter(account=>account.user?.status==='ACTIVE').map(account=><option key={account.userId} value={account.userId}>{account.user?.name||account.user?.email} · {account.accountIdentifier}</option>)}</select></label>}
					<label className="account-label">Amount (USD)<input className="input mt-1" required type="number" min="0.01" step="0.01" value={form.amount} onChange={event=>updateForm('amount',event.target.value)}/></label>
					<label className="account-label">Source / category<input className="input mt-1" required minLength={2} maxLength={64} value={form.sourceClassification} onChange={event=>updateForm('sourceClassification',event.target.value)}/></label>
					<label className="account-label sm:col-span-2">Reason<textarea className="input mt-1 min-h-20" required minLength={3} maxLength={300} value={form.reason} onChange={event=>updateForm('reason',event.target.value)}/></label>
					<button className="btn min-h-11 bg-gold text-black sm:col-span-2" type="submit" disabled={busy||loading||walletOperation&&!form.userId}>{busy?'Submitting…':'Submit for second-admin approval'}</button>
					<p className="sm:col-span-2 text-xs muted">Treasury entries are internal accounting records only. They are not external-funds evidence and do not initiate a bank transfer.</p>
				</form>

				<div className="grid gap-4">
					<form className="card flex flex-wrap items-end gap-3 p-5" onSubmit={event=>void createAccount(event)}>
						<div className="w-full"><h2 className="text-lg font-semibold">Open a customer REAL account</h2><p className="mt-1 text-sm muted">Uses the existing REAL ledger; creation is idempotent and never resets an existing balance.</p></div>
						<label className="account-label min-w-56 flex-1">Registered customer ID<input className="input mt-1" required value={accountUserId} onChange={event=>setAccountUserId(event.target.value)} placeholder="User ID"/></label>
						<button className="btn min-h-11 bg-white/10" type="submit" disabled={busy||!accountUserId.trim()}>Open / reuse account</button>
					</form>
					<div className="card p-5"><h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck size={18} className="text-gold"/> Account freeze controls</h2><p className="mt-1 text-sm muted">Freeze blocks new REAL wallet outflows, card transfers, and investment subscriptions. It does not erase ledger history.</p><label className="account-label mt-3 block">Administrative reason<input className="input mt-1" minLength={3} maxLength={300} value={freezeReason} onChange={event=>setFreezeReason(event.target.value)} placeholder="Reason required for freeze or reactivation"/></label></div>
				</div>
			</section>

			<section className="card mt-5 p-5">
				<div className="flex flex-wrap items-end justify-between gap-3"><div><span className="account-kicker">CUSTOMER MANAGEMENT</span><h2 className="mt-1 text-lg font-semibold">REAL internal accounts</h2></div><form className="flex gap-2" onSubmit={applySearch}><input className="input min-w-56" aria-label="Search customer accounts" placeholder="Name, email, ID, or account ID" value={searchInput} onChange={event=>setSearchInput(event.target.value)}/><button className="btn bg-white/10" type="submit">Search</button></form></div>
				{loading&&!data?<p className="mt-4 muted" role="status">Loading accounts…</p>:data?.accounts.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[880px] text-left text-sm"><thead><tr className="border-b border-white/10 text-xs muted"><th className="py-3 pr-4">Customer</th><th className="py-3 pr-4">Internal account</th><th className="py-3 pr-4">Status</th><th className="py-3 pr-4 text-right">Available</th><th className="py-3 pr-4 text-right">Reserved</th><th className="py-3">Controls</th></tr></thead><tbody>{data.accounts.map(account=><tr key={account.id} className="border-b border-white/5"><td className="py-3 pr-4"><b>{account.user?.name||'Customer'}</b><span className="mt-1 block text-xs muted">{account.user?.email||account.userId}</span></td><td className="py-3 pr-4 font-mono text-xs">{account.accountIdentifier}</td><td className="py-3 pr-4">{readable(account.status)}</td><td className="py-3 pr-4 text-right">{money(account.available)}</td><td className="py-3 pr-4 text-right">{money(account.reserved)}</td><td className="py-3">{account.status==='FROZEN'?<button type="button" className="btn bg-white/10" disabled={busy} onClick={()=>void changeAccountStatus(account,'UNFREEZE')}>Reactivate</button>:account.status==='ACTIVE'?<button type="button" className="btn bg-loss/80" disabled={busy} onClick={()=>void changeAccountStatus(account,'FREEZE')}>Freeze</button>:<span className="muted">Closed</span>}</td></tr>)}</tbody></table></div>:<p className="mt-4 rounded-xl border border-white/10 p-4 text-sm muted">No matching bank accounts. Search registered customers or open a REAL account by user ID.</p>}
			</section>

			<section className="card mt-5 p-5">
				<div><span className="account-kicker">SEPARATION OF DUTIES</span><h2 className="mt-1 text-lg font-semibold">Awaiting a second administrator</h2></div>
				{data?.pendingOperations.length?<ul className="mt-4 divide-y divide-white/10">{data.pendingOperations.map(operation=><li key={operation.id} className="flex flex-wrap items-center justify-between gap-4 py-4"><div className="min-w-60 flex-1"><b>{readable(operation.type)} · {money(operation.amount)}</b><p className="mt-1 text-xs muted">{operation.user?.email||'Treasury'} · {operation.sourceClassification} · {operation.reason}</p><p className="mt-1 font-mono text-xs muted">{operation.reference} · requested by {operation.initiatedBy?.name||operation.initiatedBy?.email||'Unavailable admin'}</p></div><div className="flex gap-2"><button className="btn bg-profit text-black" type="button" disabled={busy||operation.initiatedById===session?.user?.id} title={operation.initiatedById===session?.user?.id?'A different administrator must approve this request.':'Approve and post atomically'} onClick={()=>void reviewOperation(operation.id,'APPROVE')}>Approve & post</button><button className="btn bg-white/10" type="button" disabled={busy||operation.initiatedById===session?.user?.id} title="A different administrator must review this request." onClick={()=>void reviewOperation(operation.id,'REJECT')}>Reject</button></div></li>)}</ul>:<p className="mt-4 text-sm muted">No operations are awaiting approval.</p>}
			</section>

			<section className="card mt-5 p-5"><div><span className="account-kicker">AUDIT TRAIL</span><h2 className="mt-1 text-lg font-semibold">Treasury and account operations</h2></div>
				<form className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6" onSubmit={applyActivityFilters}>
					<input className="input lg:col-span-2" aria-label="Search operations" placeholder="Reference, source, reason, customer email" value={activitySearchInput} onChange={event=>setActivitySearchInput(event.target.value)}/>
					<select className="input" aria-label="Filter operation type" value={typeInput} onChange={event=>setTypeInput(event.target.value)}><option value="">All operation types</option><option value="TREASURY_FUNDING">Treasury funding</option><option value="TREASURY_ADJUSTMENT">Treasury adjustment</option><option value="WALLET_CREDIT">Wallet credit</option><option value="WALLET_DEBIT">Wallet debit</option></select>
					<input className="input" aria-label="From date" type="date" value={fromInput} onChange={event=>setFromInput(event.target.value)}/>
					<input className="input" aria-label="To date" type="date" value={toInput} onChange={event=>setToInput(event.target.value)}/>
					<div className="flex gap-2"><input className="input min-w-0" aria-label="Filter administrator ID" placeholder="Admin ID" value={adminInput} onChange={event=>setAdminInput(event.target.value)}/><button className="btn bg-white/10" type="submit">Filter</button></div>
				</form>
				{data?.recentOperations.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead><tr className="border-b border-white/10 text-xs muted"><th className="py-3 pr-4">Reference</th><th className="py-3 pr-4">Operation</th><th className="py-3 pr-4">Customer / source</th><th className="py-3 pr-4 text-right">Amount</th><th className="py-3 pr-4">Status</th><th className="py-3">Reviewed by</th></tr></thead><tbody>{data.recentOperations.map(operation=><tr key={operation.id} className="border-b border-white/5"><td className="py-3 pr-4 font-mono text-xs">{operation.reference}</td><td className="py-3 pr-4">{readable(operation.type)}</td><td className="py-3 pr-4">{operation.user?.email||operation.sourceClassification}</td><td className="py-3 pr-4 text-right">{money(operation.amount)}</td><td className="py-3 pr-4">{readable(operation.status)}</td><td className="py-3">{operation.reviewedBy?.name||operation.reviewedBy?.email||'—'}</td></tr>)}</tbody></table></div>:<p className="mt-4 text-sm muted">No reviewed bank operations yet.</p>}
			</section>

			<p className="mt-4 flex items-start gap-2 text-xs muted"><ShieldCheck size={14} className="mt-0.5 shrink-0"/> Balances are internal ledger values; no external bank, payment, card issuer, or network is connected. Wallets, card balances, and prior REAL entries remain in the existing ledger.</p>
		</main>
	</>;
}
