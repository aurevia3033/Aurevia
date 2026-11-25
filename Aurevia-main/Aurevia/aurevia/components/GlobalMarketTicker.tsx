'use client';

import {useEffect,useState} from 'react';
import type {MarketQuote} from '@/lib/live-market';

const symbols=['DJI','SPX','NASDAQ','BTC','AAPL','MSFT','NVDA','AMZN','GOOGL','TSLA','EURGBP'].join(',');

type MarketResult={quotes?:Array<MarketQuote|{error?:string}>;marketDataStatus?:string};

function isQuote(value:MarketQuote|{error?:string}|undefined):value is MarketQuote{
	return !!value&&'price'in value&&Number.isFinite(value.price);
}

export default function GlobalMarketTicker(){
	const [quotes,setQuotes]=useState<MarketQuote[]>([]);
	const [status,setStatus]=useState<'loading'|'ready'|'unavailable'>('loading');

	useEffect(()=>{
		let active=true;
		let refreshing=false;
		async function refresh(){
			if(refreshing)return;
			refreshing=true;
			try{
				const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(symbols)}`,{cache:'no-store'});
				const payload=await response.json() as MarketResult;
				const next=(payload.quotes??[]).filter(isQuote);
				if(!response.ok||!next.length)throw new Error('Market updates unavailable');
				if(active){
					setQuotes(next);
					setStatus('ready');
				}
			}catch{
				if(active)setStatus(current=>current==='ready'?current:'unavailable');
			}finally{
				refreshing=false;
			}
		}
		void refresh();
		const timer=window.setInterval(()=>void refresh(),3_000);
		return()=>{
			active=false;
			window.clearInterval(timer);
		};
	},[]);

	const items=quotes.map(quote=>{
		const change=Number.isFinite(quote.changePercent)?quote.changePercent:0;
		return (
			<span className="global-market-update" key={quote.asset.id}>
				<strong>{quote.asset.id}</strong>
				<span>{quote.price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:quote.asset.currency==='JPY'?0:4})}</span>
				<i className={change>=0?'is-positive':'is-negative'}>{change>=0?'+':''}{change.toFixed(2)}%</i>
			</span>
		);
	});

	return (
		<aside className="global-market-ticker" aria-label="Live market updates" aria-live="polite">
			<div className="global-market-ticker-label"><i aria-hidden="true"/><span>MARKET UPDATES</span></div>
			<div className="global-market-ticker-window">
				{status==='ready'&&items.length>0?
					<div className="global-market-ticker-track" aria-hidden="false">
						<div className="global-market-ticker-set">{items}</div>
						<div className="global-market-ticker-set" aria-hidden="true">{items}</div>
					</div>
					:<span className="global-market-ticker-state">{status==='loading'?'Loading market updates…':'Market updates unavailable'}</span>}
			</div>
		</aside>
	);
}
