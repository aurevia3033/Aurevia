'use client';

import {type FormEvent,useCallback,useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {ArrowDownLeft,ArrowUpRight,Download,RefreshCw,ShieldCheck,Wallet} from 'lucide-react';
import Nav from '@/components/Nav';

type CardRow={id:string;displayName:string;referenceNumber:string;status:'ACTIVE'|'SUSPENDED'|'REVOKED'|'PENDING_ISSUANCE';balance:string};
type BankSummary={
	account:{accountIdentifier:string;status:'ACTIVE'|'FROZEN'|'CLOSED';statusReason:string|null};
	currency:string;ledgerBalance:string;available:string;reserved:string;totalCredited:string;totalDebited:string;
	accountRestricted:boolean;cards:CardRow[];
};
type TransactionRow={id:string;reference:string;description:string;createdAt:string;entries:Array<{type:'DEBIT'|'CREDIT';amount:string}>};
type TransactionResult={transactions:TransactionRow[];page:number;pageSize:number;pageCount:number;totalCount:number};

const money=(value:string|number|undefined)=>value===undefined?'—':new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(value));
const readable=(value:string)=>value.replaceAll('_',' ').toLowerCase().replace(/(^|\s)\S/g,letter=>letter.toUpperCase());

export default function AureviaBankPage(){
	const [summary,setSummary]=useState<BankSummary|null>(null);
	const [history,setHistory]=useState<TransactionResult|null>(null);
	const [page,setPage]=useState(1);
	const [searchInput,setSearchInput]=useState('');
	const [search,setSearch]=useState('');
	const [cardId,setCardId]=useState('');
	const [amount,setAmount]=useState('');
	const [requestKey,setRequestKey]=useState('');
	const [loading,setLoading]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');

	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const query=new URLSearchParams({page:String(page)});
			if(search)query.set('search',search);
			const [bankResponse,historyResponse]=await Promise.all([
				fetch('/api/bank',{cache:'no-store'}),
				fetch(`/api/bank/transactions?${query}`,{cache:'no-store'}),
			]);
			const [bankData,historyData]=await Promise.all([bankResponse.json(),historyResponse.json()]);
			if(!bankResponse.ok)throw new Error(bankData.error||'Unable to load your Aurevia Bank account.');
			if(!historyResponse.ok)throw new Error(historyData.error||'Unable to load transaction history.');
			setSummary(bankData as BankSummary);
			setHistory(historyData as TransactionResult);
			setCardId(current=>current&&bankData.cards.some((card:CardRow)=>card.id===current&&card.status==='ACTIVE')?current:(bankData.cards.find((card:CardRow)=>card.status==='ACTIVE')?.id||''));
			setError('');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load Aurevia Bank.');
		}finally{setLoading(false)}
	},[page,search]);

	useEffect(()=>{void load()},[load]);

	const selectedCard=summary?.cards.find(card=>card.id===cardId);
	const transferAmount=Number(amount);
	const validAmount=Number.isFinite(transferAmount)&&transferAmount>=1&&summary!==null&&transferAmount<=Number(summary.available);
	const resultingCardBalance=selectedCard?Number(selectedCard.balance)+(Number.isFinite(transferAmount)?transferAmount:0):0;
	const canFund=Boolean(summary&&selectedCard?.status==='ACTIVE'&&summary.account.status==='ACTIVE'&&!summary.accountRestricted&&validAmount);

	async function submitFunding(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!selectedCard||!canFund||submitting)return;
		const idempotencyKey=requestKey||crypto.randomUUID();
		setRequestKey(idempotencyKey);
		setSubmitting(true);setError('');setNotice('');
		try{
			const response=await fetch(`/api/bank/cards/${selectedCard.id}/funding`,{
				method:'POST',
				headers:{'content-type':'application/json'},
				body:JSON.stringify({amount,idempotencyKey}),
			});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'The card transfer could not be completed.');
			setNotice(`${money(amount)} transferred to ${selectedCard.displayName}. Reference: ${result.reference}`);
			setAmount('');setRequestKey('');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'The card transfer could not be completed.')}
		finally{setSubmitting(false)}
	}

	function applySearch(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		setPage(1);
		setSearch(searchInput.trim());
	}

	const activeCards=useMemo(()=>summary?.cards.filter(card=>card.status==='ACTIVE')||[],[summary]);

	return <div data-section="bank">
		<Nav/>
		<main className="account-page">
			<header className="account-heading">
				<div><span className="account-kicker">AUREVIA · INTERNAL PLATFORM BANK</span><h1>Aurevia Bank</h1></div>
				<div className="flex flex-wrap gap-2">
					<a className="btn bg-white/5" href="/api/bank/statement"><Download size={15}/>Download statement</a>
					<button className="btn bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={14}/>Refresh</button>
				</div>
			</header>

			{error&&<div className="card mt-4 flex flex-wrap items-center justify-between gap-3 border border-loss/30 p-4 text-sm" role="alert"><span>{error}</span><button type="button" className="btn bg-white/10" onClick={()=>void load()}>Try again</button></div>}
			{notice&&<p className="card mt-4 border border-profit/30 p-4 text-sm text-profit" role="status">{notice}</p>}

			<section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="REAL account summary">
				<article className="card p-5"><span className="text-xs muted">AVAILABLE REAL BALANCE</span><p className="mt-2 text-2xl font-semibold">{loading? '—':money(summary?.available)}</p><small className="muted">Authoritative ledger-derived funds</small></article>
				<article className="card p-5"><span className="text-xs muted">RESERVED</span><p className="mt-2 text-2xl font-semibold">{loading?'—':money(summary?.reserved)}</p><small className="muted">Includes pending withdrawals and open-order collateral</small></article>
				<article className="card p-5"><span className="text-xs muted">TOTAL CREDITED</span><p className="mt-2 text-2xl font-semibold">{loading?'—':money(summary?.totalCredited)}</p></article>
				<article className="card p-5"><span className="text-xs muted">TOTAL DEBITED</span><p className="mt-2 text-2xl font-semibold">{loading?'—':money(summary?.totalDebited)}</p></article>
			</section>

			<section className="card mt-4 flex flex-wrap items-center justify-between gap-4 p-5" aria-label="Account details">
				<div><span className="account-kicker">ACCOUNT IDENTIFIER</span><p className="mt-2 font-mono text-lg">{loading?'—':summary?.account.accountIdentifier||'—'}</p><small className="muted">Aurevia account reference for identification and transactions.</small></div>
				<div className="text-sm"><span className="muted">Account status</span><p className={`mt-1 font-semibold ${summary?.account.status==='ACTIVE'?'text-profit':'text-loss'}`}>{loading?'—':readable(summary?.account.status||'')}</p>{summary?.account.statusReason&&<small className="muted">{summary.account.statusReason}</small>}</div>
			</section>

			{summary?.accountRestricted&&<p className="mt-4 rounded-xl border border-loss/30 bg-loss/5 p-4 text-sm" role="status">Some REAL account actions are restricted. Existing eligibility, withdrawal, and review controls remain in effect.</p>}

			<section className="mt-5 grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
				<div className="card p-5">
					<div className="flex items-start gap-3"><span className="rounded-xl bg-gold/10 p-2 text-gold"><Wallet size={19}/></span><div><h2 className="text-lg font-semibold">Add funds to an Aurevia card</h2></div></div>
					{activeCards.length===0?<div className="mt-5 rounded-xl border border-white/10 p-4 text-sm"><p>No active cards are available for funding.</p><Link className="mt-3 inline-flex text-gold" href="/cards">View card management</Link></div>:<form className="mt-5 grid gap-4" onSubmit={event=>void submitFunding(event)}>
						<label className="account-label">Active card<select className="input mt-1" value={cardId} onChange={event=>{setCardId(event.target.value);setRequestKey('')}} required>{activeCards.map(card=><option key={card.id} value={card.id}>{card.displayName} · {card.referenceNumber}</option>)}</select></label>
						<label className="account-label">Transfer amount (USD)<input className="input mt-1" type="number" min="1.00" max={summary?.available} step="0.01" value={amount} onChange={event=>{setAmount(event.target.value);setRequestKey('')}} required/></label>
						{selectedCard&&<div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm">
							<h3 className="font-semibold">Transfer confirmation</h3>
							<dl className="mt-3 grid grid-cols-2 gap-y-2"><dt className="muted">Wallet available</dt><dd className="text-right">{money(summary?.available)}</dd><dt className="muted">Current card balance</dt><dd className="text-right">{money(selectedCard.balance)}</dd><dt className="muted">Transfer amount</dt><dd className="text-right">{amount?money(amount):'—'}</dd><dt className="muted">Aurevia transfer fee</dt><dd className="text-right">{money(0)}</dd><dt className="font-medium">Resulting card balance</dt><dd className="text-right font-medium">{amount?money(resultingCardBalance):money(selectedCard.balance)}</dd></dl>
						</div>}
						<button className="btn min-h-11 bg-gold text-black" type="submit" disabled={!canFund||submitting}>{submitting?'Transferring…':'Confirm internal transfer'}</button>
					</form>}
					<p className="mt-4 flex items-start gap-2 text-xs muted"><ShieldCheck size={15} className="mt-0.5 shrink-0"/> Card balances are available for external payments and ATM withdrawals, subject to applicable limits and approval.</p>
				</div>

				<div className="card p-5">
					<div className="flex items-start gap-3"><span className="rounded-xl bg-white/5 p-2"><ShieldCheck size={19}/></span><div><h2 className="text-lg font-semibold">Financial Disclosures</h2></div></div>
					<ul className="mt-5 space-y-3 text-sm muted">
						<li>REAL account transactions are based on verified wallet balances.</li>
						<li>Investment returns are not guaranteed.</li>
						<li>Withdrawal approval is subject to the applicable settlement process.</li>
						<li>Deposits and funding entries require appropriate verification and approval.</li>
					</ul>
					<div className="mt-5 flex flex-wrap gap-3"><Link href="/wallet" className="btn bg-white/5"><ArrowDownLeft size={15}/>Wallet & funding</Link><Link href="/cards" className="btn bg-white/5"><ArrowUpRight size={15}/>Card management</Link></div>
				</div>
			</section>

			<section className="card mt-5 p-5" aria-labelledby="bank-transactions-title">
				<div className="flex flex-wrap items-center justify-between gap-3"><div><span className="account-kicker">ACCOUNT ACTIVITY</span><h2 id="bank-transactions-title" className="mt-1 text-lg font-semibold">Recent ledger transactions</h2></div>
					<form className="flex flex-wrap gap-2" onSubmit={applySearch}><input className="input min-w-48" aria-label="Search transaction history" placeholder="Search reference or description" value={searchInput} onChange={event=>setSearchInput(event.target.value)}/><button className="btn bg-white/10" type="submit">Search</button></form>
				</div>
				{loading&&!history?<p className="mt-5 muted" role="status">Loading transaction history…</p>:history?.transactions.length?<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-white/10 text-xs muted"><th className="py-3 pr-4">Transaction</th><th className="py-3 pr-4">Reference</th><th className="py-3 pr-4">Date</th><th className="py-3 text-right">Amount</th></tr></thead><tbody>{history.transactions.map(transaction=>{const entry=transaction.entries[0];return <tr key={transaction.id} className="border-b border-white/5"><td className="py-3 pr-4"><b>{transaction.description}</b><span className="mt-1 block text-xs muted">{entry?readable(entry.type):'Ledger'}</span></td><td className="py-3 pr-4 font-mono text-xs">{transaction.reference}</td><td className="py-3 pr-4 muted">{new Date(transaction.createdAt).toLocaleString()}</td><td className={`py-3 text-right font-medium ${entry?.type==='CREDIT'?'text-profit':'text-loss'}`}>{entry?.type==='CREDIT'?'+':'−'}{money(entry?.amount)}</td></tr>})}</tbody></table></div>:<p className="mt-5 rounded-xl border border-white/10 p-4 text-sm muted">{search?'No transactions match this search.':'No REAL wallet transactions have been recorded yet.'}</p>}
				<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"><span className="muted">{history?`${history.totalCount} matching transactions · page ${history.page} of ${history.pageCount}`:' '}</span><div className="flex gap-2"><button className="btn bg-white/5" type="button" disabled={!history||page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}>Previous</button><button className="btn bg-white/5" type="button" disabled={!history||page>=history.pageCount||loading} onClick={()=>setPage(value=>value+1)}>Next</button></div></div>
			</section>
		</main>
	</div>;
}
