'use client';

import {useEffect,useState} from 'react';
import {RefreshCw} from 'lucide-react';

type ServiceStatus='AVAILABLE'|'UNAVAILABLE'|'DISABLED';
type ProviderStatus={
	checkedAt:string;
	internalSimulation:{simulationEngine:ServiceStatus;accountLedger:ServiceStatus;adminAuthorization:ServiceStatus;simulatedTradeExecution:ServiceStatus;simulatedDepositsAndWithdrawals:ServiceStatus;simulatedInvestmentSettlement:ServiceStatus;externalBrokerExecution:'DISABLED';externalPaymentProcessing:'DISABLED';externalInvestmentSettlement:'DISABLED';externalMoneyMovement:'DISABLED'};
	marketData:{
		status:string;provider:string;apiAuthenticationStatus:string;lastSuccessfulRequestAt:string|null;lastDataAt:string|null;freshness:string;
		rateLimitErrors:number;providerErrors:number;errorCode:string|null;capabilities:string[];usedForOrderExecution:false;
		historicalData:{status:string;symbol:string;timeframe:string;provider:string|null};
		providers:Array<{id:string;name:string;status:string;configured:boolean;capabilities:string[];responseTimeMs?:number|null;lastSuccessfulRequestAt?:string|null;rateLimitErrors?:number;errorCode?:string}>;
	};
	identity:{status:string;adminReviewAvailable:ServiceStatus;externalVerification:'DISABLED'};
};

const statusClass=(status:string)=>['AVAILABLE','CONFIGURED','HEALTHY','CONNECTED','AUTHENTICATED'].includes(status)?'text-profit':['DISABLED','NOT_CONFIGURED','NOT_CHECKED'].includes(status)?'muted':'text-loss';

export default function AdminProvidersPanel(){
	const [data,setData]=useState<ProviderStatus|null>(null);
	const [error,setError]=useState('');
	const [loading,setLoading]=useState(true);
	async function load(){
		setLoading(true);
		try{
			const response=await fetch('/api/admin/providers/status',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Internal service health is unavailable.');
			setData(result);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Internal service health is unavailable.')}
		finally{setLoading(false)}
	}
	useEffect(()=>{void load()},[]);
	const services=data?.internalSimulation;
	return <section id="providers" className="card p-4 sm:p-5">
		<header className="flex flex-wrap items-start justify-between gap-3">
			<div><h2 className="font-bold">Internal service health</h2><p className="mt-1 text-sm muted">Status reflects database and service checks, not user transactions.</p></div>
			<button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void load()} disabled={loading}><RefreshCw size={15}/>Refresh</button>
		</header>
		{error?<p className="mt-3 text-sm text-loss" role="alert">{error}</p>:loading&&!data?<p className="mt-3 muted" role="status">Checking internal services…</p>:data&&<div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
			<article className="rounded-lg border border-white/10 p-3"><h3 className="font-semibold">Internal financial operations</h3>
				{([
					['DEMO price service',services!.simulationEngine],['Account ledger',services!.accountLedger],['Admin authorization',services!.adminAuthorization],['Internal simulated trade execution',services!.simulatedTradeExecution],['Internal deposits and withdrawals',services!.simulatedDepositsAndWithdrawals],['Investment settlement',services!.simulatedInvestmentSettlement],
				] as [string,ServiceStatus][]).map(([label,status])=><p className="mt-2 flex justify-between gap-3 text-sm" key={label}><span>{label}</span><b className={statusClass(status)}>{status}</b></p>)}
			</article>
			<article className="rounded-lg border border-white/10 p-3"><h3 className="font-semibold">Live financial services</h3>
				{([
					['Live broker execution',services!.externalBrokerExecution],['Payment processing',services!.externalPaymentProcessing],['Investment settlement',services!.externalInvestmentSettlement],['Money movement',services!.externalMoneyMovement],
				] as [string,'DISABLED'][]).map(([label,status])=><p className="mt-2 flex justify-between gap-3 text-sm" key={label}><span>{label}</span><b className={statusClass(status)}>{status}</b></p>)}
			</article>
			<article className="rounded-lg border border-white/10 p-3"><h3 className="font-semibold">Market data</h3>
				<p className="mt-2 text-sm">Primary provider: <b>{data.marketData.provider}</b></p>
				<p className="text-sm">Connection: <b className={statusClass(data.marketData.status)}>{data.marketData.status}</b></p>
				<p className="text-sm">API authentication: <b className={statusClass(data.marketData.apiAuthenticationStatus)}>{data.marketData.apiAuthenticationStatus}</b></p>
				{data.marketData.providers.filter(provider=>provider.configured).map(provider=><p className="text-sm" key={provider.id}>{provider.name}: <b className={statusClass(provider.status)}>{provider.status}</b> · {provider.responseTimeMs===null||provider.responseTimeMs===undefined?'No latency sample':`${provider.responseTimeMs} ms`} · Last success {provider.lastSuccessfulRequestAt?new Date(provider.lastSuccessfulRequestAt).toLocaleString():'none'} · Rate limits {provider.rateLimitErrors??0}{provider.errorCode?` · ${provider.errorCode}`:''}</p>)}
				<p className="mt-2 text-sm">Last successful request: {data.marketData.lastSuccessfulRequestAt?new Date(data.marketData.lastSuccessfulRequestAt).toLocaleString():'None'}</p>
				<p className="text-sm">Latest data timestamp: {data.marketData.lastDataAt?new Date(data.marketData.lastDataAt).toLocaleString():'None'}</p>
				<p className="text-sm">Data freshness: <b className={statusClass(data.marketData.freshness)}>{data.marketData.freshness}</b></p>
				<p className="text-sm">Rate-limit errors: <b>{data.marketData.rateLimitErrors}</b> · Provider errors: <b>{data.marketData.providerErrors}</b></p>
				{data.marketData.errorCode&&<p className="mt-2 text-xs text-loss">Provider diagnostic: {data.marketData.errorCode}</p>}
				<p className="mt-2 text-sm">Chart candles (AAPL, 1d): <b className={statusClass(data.marketData.historicalData.status)}>{data.marketData.historicalData.status}</b></p>
				<p className="text-sm">Chart history provider: {data.marketData.historicalData.provider??'None'}</p>
				<p className="mt-2 text-sm">Capabilities: {data.marketData.capabilities.length?data.marketData.capabilities.join(', '):'None verified'}</p>
				<p className="mt-2 text-xs muted">Provider data is read-only and never used to move funds or price order execution. Availability depends on each configured provider’s plan and symbol access.</p>
			</article>
			<article className="rounded-lg border border-white/10 p-3"><h3 className="font-semibold">Identity review</h3><p className="mt-2 text-sm">Admin review: <b className={statusClass(data.identity.adminReviewAvailable)}>{data.identity.adminReviewAvailable}</b></p><p className="text-sm">External verification: <b className={statusClass(data.identity.externalVerification)}>{data.identity.externalVerification}</b></p><p className="mt-2 text-xs muted">Tier 3 reflects internal administrator review only.</p></article>
		</div>}
		{data&&<p className="mt-3 text-xs muted">Checked {new Date(data.checkedAt).toLocaleString()}</p>}
	</section>;
}