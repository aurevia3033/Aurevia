'use client';

import {FormEvent,useCallback,useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {ArrowDownRight,ArrowLeftRight,ArrowRight,ArrowUpRight,Check,LoaderCircle,RefreshCw} from 'lucide-react';
import Nav from '@/components/Nav';

type MarketInstrument={symbol:string;price:number|string};
type WalletSnapshot={accountMode:'DEMO'|'REAL'};
type ConversionPreview={
	direction:'BUY'|'SELL';
	sourceAsset:'USD'|'BTC';
	destinationAsset:'USD'|'BTC';
	rate:number|string;
	rateCurrency:'USD/BTC';
	sourceAmount:number|string;
	fee:number|string;
	feeCurrency:'USD';
	finalAmount:number|string;
	finalCurrency:'USD'|'BTC';
	observedAt:string;
	priceSource:string;
	simulated:true;
};
type ConversionResult=ConversionPreview&{
	order:{id:string;status:string;quantity:number|string;filledQuantity:number|string;averageFillPrice:number|string|null;reviewRequired?:boolean};
	executionProvider:'AUREVIA_INTERNAL_SIMULATION';
};

const usdFormat=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
export default function BitcoinConversionExperience(){
	const [accountMode,setAccountMode]=useState<WalletSnapshot['accountMode']|null>(null);
	const [price,setPrice]=useState<number|null>(null);
	const [direction,setDirection]=useState<'BUY'|'SELL'>('BUY');
	const [amount,setAmount]=useState('');
	const [loading,setLoading]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [previewing,setPreviewing]=useState(false);
	const [preview,setPreview]=useState<ConversionPreview|null>(null);
	const [confirmed,setConfirmed]=useState(false);
	const [error,setError]=useState('');
	const [result,setResult]=useState<ConversionResult|null>(null);

	const load=useCallback(async()=>{
		try{
			const [walletResponse,marketResponse]=await Promise.all([
				fetch('/api/wallet',{cache:'no-store'}),
				fetch('/api/market',{cache:'no-store'}),
			]);
			const [wallet,market]=await Promise.all([walletResponse.json(),marketResponse.json()]);
			if(!walletResponse.ok)throw new Error(wallet.error||'Unable to load your account mode.');
			if(!marketResponse.ok)throw new Error(market.error||'Bitcoin market data is unavailable.');
			setAccountMode((wallet as WalletSnapshot).accountMode);
			const bitcoin=(market as MarketInstrument[]).find(instrument=>instrument.symbol==='BTC/USD');
			const nextPrice=bitcoin?Number(bitcoin.price):NaN;
			setPrice(Number.isFinite(nextPrice)&&nextPrice>0?nextPrice:null);
			if(!bitcoin)setError('Bitcoin is not currently available for trading.');
			else setError('');
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load Bitcoin conversion.');
		}finally{setLoading(false);}
	},[]);

	useEffect(()=>{void load()},[load]);

	const amountValue=Number(amount);
	const amountFormatValid=direction==='BUY'?/^\d+(?:\.\d{1,2})?$/.test(amount):/^\d+(?:\.\d{1,10})?$/.test(amount);
	const invalidAmount=!Number.isFinite(amountValue)||amountValue<=0||!amountFormatValid;
	const canPreview=accountMode==='REAL'&&price!==null&&!loading&&!submitting&&!previewing&&!invalidAmount;
	const canSubmit=canPreview&&!!preview&&confirmed;

	async function createPreview(){
		if(!canPreview)return;
		setPreviewing(true);setError('');setPreview(null);setConfirmed(false);setResult(null);
		try{
			const query=new URLSearchParams({direction,amount});
			const response=await fetch(`/api/wallet/convert-bitcoin?${query}`,{cache:'no-store'});
			const payload=await response.json();
			if(!response.ok)throw new Error(payload.error||'Unable to preview this conversion.');
			setPreview(payload as ConversionPreview);
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to preview this conversion.');
		}finally{setPreviewing(false);}
	}

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!canSubmit||!preview)return;
		setSubmitting(true);setError('');setResult(null);
		try{
			const response=await fetch('/api/wallet/convert-bitcoin',{
				method:'POST',
				headers:{'content-type':'application/json','Idempotency-Key':window.crypto.randomUUID()},
				body:JSON.stringify({direction,amount,confirmed:true,referencePrice:String(preview.rate),observedAt:preview.observedAt}),
			});
			const payload=await response.json();
			if(!response.ok)throw new Error(payload.error||'Unable to submit the internal simulated Bitcoin order.');
			setResult(payload as ConversionResult);
			await load();
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to submit the internal simulated Bitcoin order.');
		}finally{setSubmitting(false);}
	}

	const orderStatus=useMemo(()=>result?.order.reviewRequired?'REVIEW':result?.order.status.replaceAll('_',' ').toUpperCase()||'', [result]);

	return <><Nav/><main className="account-page wallet-convert-icon-page">
		<section className="account-panel card wallet-convert-icon-panel" aria-label="Bitcoin conversion">
			{loading?<div className="wallet-convert-loader" role="status" aria-label="Loading"><LoaderCircle size={22} className="animate-spin"/></div>:accountMode===null?<div className="wallet-convert-state" role="alert" aria-label="Unavailable"><span aria-hidden="true">!</span></div>:accountMode!=='REAL'?<div className="wallet-convert-state"><Link className="wallet-convert-icon-button" href="/wallet" title="Open wallet" aria-label="Open wallet"><ArrowLeftRight size={19}/></Link></div>:<form className="wallet-convert-icon-form" onSubmit={submit}>
				<div className="wallet-convert-topline" role="group" aria-label="Conversion direction">
					<button type="button" className={`wallet-convert-icon-button ${direction==='BUY'?'is-active':''}`} title="Buy BTC" aria-label="Buy BTC" aria-pressed={direction==='BUY'} onClick={()=>{setDirection('BUY');setAmount('');setPreview(null);setConfirmed(false);setResult(null)}}><ArrowUpRight size={18}/></button>
					<button type="button" className={`wallet-convert-icon-button ${direction==='SELL'?'is-active':''}`} title="Sell BTC" aria-label="Sell BTC" aria-pressed={direction==='SELL'} onClick={()=>{setDirection('SELL');setAmount('');setPreview(null);setConfirmed(false);setResult(null)}}><ArrowDownRight size={18}/></button>
					<span className="wallet-convert-price" aria-label="BTC to USD price">{price===null?'—':usdFormat.format(price)}</span>
				</div>
				<label className="wallet-convert-icon-label">
					<span className="sr-only">{direction==='BUY'?'Spend USD':'Sell BTC'}</span>
					<input className="input wallet-convert-icon-input" aria-label={direction==='BUY'?'Spend USD':'Sell BTC'} type="text" value={amount} placeholder={direction==='BUY'?'0.00':'0.0000000000'} onChange={event=>{setAmount(event.target.value);setPreview(null);setConfirmed(false);setResult(null)}} inputMode="decimal" required/>
				</label>
				{amount&&!amountFormatValid&&<span className="sr-only" role="status">{direction==='BUY'?'Invalid USD amount':'Invalid BTC amount'}</span>}
				{preview&&<div className="wallet-convert-preview" role="status" aria-label="Conversion preview">
					<span>{preview.sourceAmount}</span><ArrowLeftRight size={14}/><span>{preview.destinationAsset==='BTC'?preview.finalAmount:preview.finalAmount} {preview.destinationAsset}</span>
					<small>{preview.rate}</small>
					<label className="wallet-convert-confirm" title="Confirm conversion" aria-label="Confirm conversion"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/></label>
				</div>}
				{error&&<span className="sr-only" role="alert">{error}</span>}
				{result&&<div className="wallet-convert-result" role="status" aria-label={`Conversion ${orderStatus||result.order.status}`}><Check size={15}/><span>{result.finalAmount} {result.finalCurrency}</span><Link className="wallet-convert-icon-button" href="/orders" title="View orders" aria-label="View orders"><ArrowRight size={17}/></Link></div>}
				<div className="wallet-convert-actions">
					<button className="wallet-convert-icon-button" type="button" title="Preview conversion" aria-label="Preview conversion" onClick={()=>void createPreview()} disabled={!canPreview}>{previewing?<LoaderCircle size={17} className="animate-spin"/>:<ArrowLeftRight size={17}/>}</button>
					<button className="wallet-convert-icon-button is-primary" type="submit" title={`Confirm ${direction==='BUY'?'buy':'sell'}`} aria-label={`Confirm ${direction==='BUY'?'buy':'sell'}`} disabled={!canSubmit}>{submitting?<LoaderCircle size={17} className="animate-spin"/>:<ArrowUpRight size={17}/>}</button>
					<button className="wallet-convert-icon-button" type="button" title="Refresh" aria-label="Refresh" onClick={()=>void load()} disabled={loading||submitting}><RefreshCw size={17}/></button>
					<Link className="wallet-convert-icon-button" href="/wallet" title="Back to wallet" aria-label="Back to wallet"><ArrowLeftRight size={17}/></Link>
				</div>
			</form>}
		</section>
	</main></>;
}
