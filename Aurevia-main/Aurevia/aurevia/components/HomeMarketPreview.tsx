'use client';

import {useEffect,useRef,useState} from 'react';
import LivePriceChart from '@/components/LivePriceChart';
import {useHomeMarketData} from '@/components/HomeMarketData';
import {useLocale} from '@/lib/i18n-context';
import {isExternalMarketDataSource,TIMEFRAMES,type MarketCandle,type MarketQuote,type TimeframeId} from '@/lib/live-market';

export default function HomeMarketPreview(){
	const {translate}=useLocale();
	const {markets,status,marketDataStatus,updatedAt}=useHomeMarketData();
	const [selected,setSelected]=useState('BTC');
	const [flash,setFlash]=useState<'up'|'down'|''>('');
	const [now,setNow]=useState(0);
	const [timeframe,setTimeframe]=useState<TimeframeId>('1m');
	const [history,setHistory]=useState<{symbol:string;candles:MarketCandle[];interval:string;quote:MarketQuote|null;source:string}|null>(null);
	const [historyLoading,setHistoryLoading]=useState(false);
	const [historyError,setHistoryError]=useState('');
	const [historyRetry,setHistoryRetry]=useState(0);
	const prevPrice=useRef<number|null>(null);
	const current=markets.find(item=>item.id===selected);
	const currentId=selected||'BTC';
	const currentPrice=current?.price;
	const currentQuoteSource=current?.quote.source;
	const visibleMarkets=markets.slice(0,4);

	useEffect(()=>{
		if(currentPrice===undefined)return;
		const previous=prevPrice.current;
		prevPrice.current=currentPrice;
		if(previous===null||previous===currentPrice)return;
		setFlash(currentPrice>previous?'up':'down');
		const timer=window.setTimeout(()=>setFlash(''),700);
		return()=>window.clearTimeout(timer);
	},[currentPrice,currentId]);

	useEffect(()=>{
		if(markets.length)setSelected(value=>markets.some(item=>item.id===value)?value:markets.find(item=>item.id==='BTC')?.id||markets[0].id);
	},[markets]);

	useEffect(()=>{
		if(updatedAt===null)return;
		setNow(Date.now());
		const timer=window.setInterval(()=>setNow(Date.now()),1_000);
		return()=>window.clearInterval(timer);
	},[updatedAt]);

	useEffect(()=>{
		if(!currentId){
			setHistory(null);setHistoryError('');setHistoryLoading(false);
			return;
		}
		let active=true;
		setHistory(null);setHistoryError('');setHistoryLoading(true);
		void fetch(`/api/live-markets/${encodeURIComponent(currentId)}?timeframe=${timeframe}`,{cache:'no-store'})
			.then(async response=>{
				const result=await response.json() as {candles?:MarketCandle[];interval?:string;quote?:MarketQuote|null;source?:string;error?:string};
				if(!response.ok)throw new Error(result.error||'Provider chart history is unavailable.');
				if(!result.source||!isExternalMarketDataSource(result.source))throw new Error('Provider market history is unavailable.');
				if(!Array.isArray(result.candles)||!result.candles.length)throw new Error('No provider candles are available for this range.');
				if(active)setHistory({symbol:currentId,candles:result.candles,interval:result.interval||'1m',quote:result.quote||null,source:result.source});
			})
			.catch(error=>{if(active)setHistoryError(error instanceof Error?error.message:'Provider chart history is unavailable.')})
			.finally(()=>{if(active)setHistoryLoading(false)});
		return()=>{active=false};
	},[currentId,timeframe,historyRetry,marketDataStatus]);

	const currentHistory=history?.symbol===currentId?history:null;
	const changePct=current?.change;
	const changeClass=changePct===undefined?'':changePct>=0?'is-up':'is-down';
	const ageLabel=updatedAt!==null?`${Math.max(0,Math.round((now-updatedAt)/1000))}s`:'—';
	const sourceStatus=marketDataStatus==='LIVE'?'LIVE':marketDataStatus==='PARTIAL'?'PARTIAL':marketDataStatus==='INTERNAL'?'DEMO':'UNAVAILABLE';

	return <div className="market-stage is-live" aria-label={translate('marketView')}>
		<div className="market-stage-top">
			<div className="market-source"><span className="source-dot"/>Market prices</div>
			<span className="market-time"><span className={`live-pill ${marketDataStatus==='LIVE'?'is-live':'is-reference'}`}>{sourceStatus}</span> {translate('marketView')} · {ageLabel}</span>
		</div>
		<div className="market-stage-instrument">
			<div>
				<p className="eyebrow">{translate('selectedInstrument')}</p>
				<h2>{current?.symbol||currentId||translate('marketOverview')}</h2>
				{current?.name&&<p className="market-instrument-name">{current.name}</p>}
			</div>
			<div className={`market-stage-price ${flash?`flash-${flash}`:''}`} aria-live="polite">
				{current?current.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:current.price<10?4:2}):status==='error'?translate('unavailable'):translate('loading')}
				<small>{marketDataStatus==='INTERNAL'?'Simulated DEMO price':'Latest price'} · USD{changePct!==undefined&&<em className={changeClass}>{changePct>=0?'+':''}{(changePct*100).toFixed(2)}%</em>}</small>
			</div>
		</div>
		<div className="market-stage-chart">
			<div className="trade-chart-timeframes home-market-timeframes" role="group" aria-label="Chart timeframe">
				{TIMEFRAMES.map(item=><button type="button" key={item.id} aria-pressed={timeframe===item.id} onClick={()=>setTimeframe(item.id)}>{item.label}</button>)}
			</div>
			{currentHistory&&isExternalMarketDataSource(currentHistory.source)
				?<>{marketDataStatus==='INTERNAL'&&<div className="market-chart-source-note" role="status">The displayed price is a simulated DEMO reference, not a live quote. The chart shows historical candles from {currentHistory.source}.</div>}<LivePriceChart candles={currentHistory.candles} quote={currentQuoteSource&&isExternalMarketDataSource(currentQuoteSource)?current.quote:undefined} timeframe={timeframe} interval={currentHistory.interval} source={currentHistory.source} loading={historyLoading} error={historyError}/></>
				:currentHistory
					?<div className="market-chart-empty" role="status">Provider-backed market history is unavailable; indicative prices are not plotted as live data.</div>
					:<div className="market-chart-empty" role={historyError?'alert':'status'}>{historyError||'Loading provider market history…'}{marketDataStatus==='INTERNAL'&&<> This simulated DEMO reference price is not a live market quote.</>}{historyError&&<button type="button" className="button-secondary mt-3" onClick={()=>setHistoryRetry(value=>value+1)} disabled={historyLoading}>Retry history</button>}</div>}
			<div className="chart-axis-labels"><span>{history&&isExternalMarketDataSource(history.source)?'PROVIDER MARKET DATA':'MARKET HISTORY'}</span><span>{translate('marketFeedLabel')}</span></div>
		</div>
		<div className="market-stage-footer">
			<div className="market-pair-list" aria-label={translate('marketView')}>
				{visibleMarkets.map(item=><button key={item.id} type="button" className={item.id===selected?'is-selected':''} aria-pressed={item.id===selected} onClick={()=>setSelected(item.id)}>
					<span>{item.symbol}</span><b>{item.price.toLocaleString(undefined,{maximumFractionDigits:4})}</b>
					{item.change!==undefined&&<i className={item.change>=0?'ticker-positive':'ticker-negative'}>{item.change>=0?'+':''}{(item.change*100).toFixed(2)}%</i>}
				</button>)}
				{!visibleMarkets.length&&<span className="muted">{'No instruments available'}</span>}
			</div>
			<span className="market-feed-status"><span className={`source-dot ${marketDataStatus==='LIVE'?'is-live':''}`}/>{status==='ready'?marketDataStatus==='LIVE'?'Current market prices':marketDataStatus==='PARTIAL'?'Some prices may be stale':marketDataStatus==='INTERNAL'?'Simulated DEMO prices · not live':'Indicative prices':translate('feedStatus',{status:status.toUpperCase()})}</span>
		</div>
	</div>;
}
