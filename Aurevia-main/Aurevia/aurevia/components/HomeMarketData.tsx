'use client';

import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {getMarketAsset,type MarketQuote} from '@/lib/live-market';

export type HomeMarketItem={id:string;symbol:string;name:string;price:number;change?:number;quote:MarketQuote};
export type HomeMarketDataStatus='LIVE'|'PARTIAL'|'INTERNAL'|'UNAVAILABLE';
type HomeMarketDataValue={
	markets:HomeMarketItem[];
	status:'loading'|'ready'|'error';
	marketDataStatus:HomeMarketDataStatus;
	updatedAt:number|null;
};

const marketSymbols=['DJI','SPX','NASDAQ','BTC','AAPL','MSFT','NVDA','AMZN','GOOGL','TSLA','EURGBP'].join(',');
const refreshIntervalMs=3_000;
const HomeMarketDataContext=createContext<HomeMarketDataValue|null>(null);

export function mapSimulatedHomeMarketFeed(payload:unknown):HomeMarketItem[]{
	if(!Array.isArray(payload))return [];
	return payload.flatMap((value):HomeMarketItem[]=>{
		if(!value||typeof value!=='object'||Array.isArray(value))return [];
		const instrument=value as Record<string,unknown>;
		if(instrument.dataMode!=='SIMULATED')return [];
		const symbol=typeof instrument.symbol==='string'?instrument.symbol:'';
		const baseAsset=typeof instrument.baseAsset==='string'?instrument.baseAsset:'';
		const quoteAsset=typeof instrument.quoteAsset==='string'?instrument.quoteAsset:'';
		const asset=[symbol,baseAsset,baseAsset&&quoteAsset?`${baseAsset}${quoteAsset}`:'']
			.map(getMarketAsset)
			.find((candidate):candidate is NonNullable<typeof candidate>=>!!candidate);
		const price=typeof instrument.price==='number'||typeof instrument.price==='string'?Number(instrument.price):NaN;
		if(!asset||!Number.isFinite(price)||price<=0)return [];
		const sourceDate=typeof instrument.lastUpdatedAt==='string'
			?instrument.lastUpdatedAt
			:typeof instrument.updatedAt==='string'?instrument.updatedAt:null;
		const timestamp=sourceDate?Date.parse(sourceDate):NaN;
		const updatedAt=Number.isFinite(timestamp)?new Date(timestamp).toISOString():new Date(0).toISOString();
		const isStale=!Number.isFinite(timestamp)||Date.now()-timestamp>5*60_000||timestamp>Date.now()+5_000;
		const quote:MarketQuote={
			asset,
			price,
			bid:null,
			ask:null,
			change:0,
			changePercent:0,
			marketStatus:'UNKNOWN',
			previousClose:null,
			open:null,
			volume:null,
			dayLow:null,
			dayHigh:null,
			fiftyTwoWeekLow:null,
			fiftyTwoWeekHigh:null,
			updatedAt,
			isStale,
			...(isStale?{staleReason:'Simulated DEMO market data may be delayed.'}:{}),
			sparkline:[],
			source:'Aurevia DEMO market feed',
		};
		return [{id:asset.id,symbol:asset.id,name:asset.name,price,quote}];
	});
}

export function HomeMarketDataProvider({children}:{children:ReactNode}){
	const [data,setData]=useState<HomeMarketDataValue>({
		markets:[],
		status:'loading',
		marketDataStatus:'UNAVAILABLE',
		updatedAt:null,
	});

	useEffect(()=>{
		let active=true;
		let refreshing=false;
		async function refresh(){
			if(refreshing)return;
			refreshing=true;
			try{
				try{
					const response=await fetch(`/api/live-markets?symbols=${encodeURIComponent(marketSymbols)}`,{cache:'no-store'});
					const payload=await response.json() as {quotes?:Array<MarketQuote|{asset?:{id?:string};error?:string}>;marketDataStatus?:string};
					const quotes=(payload.quotes??[]).filter((item):item is MarketQuote=>'price'in item&&Number.isFinite(item.price)&&typeof item.asset?.id==='string');
					const marketDataStatus=payload.marketDataStatus==='LIVE'||payload.marketDataStatus==='PARTIAL'||payload.marketDataStatus==='INTERNAL'?payload.marketDataStatus:'UNAVAILABLE';
					if(response.ok&&quotes.length&&marketDataStatus!=='UNAVAILABLE'){
						if(!active)return;
						setData({
							markets:quotes.map(item=>({
								id:item.asset.id,
								symbol:item.asset.id,
								name:item.asset.name||item.asset.id,
								price:Number(item.price),
								change:Number(item.changePercent)/100,
								quote:item,
							})),
							status:'ready',
							marketDataStatus,
							updatedAt:Date.now(),
						});
						return;
					}
				}catch{/* fall through to simulated demo prices */}
				const demoResponse=await fetch('/api/market',{cache:'no-store'});
				const demoMarkets=mapSimulatedHomeMarketFeed(await demoResponse.json());
				if(!demoResponse.ok||!demoMarkets.length)throw new Error('Market data unavailable');
				if(!active)return;
				const latestUpdate=Math.max(...demoMarkets.map(item=>Date.parse(item.quote.updatedAt)).filter(Number.isFinite));
				setData({
					markets:demoMarkets,
					status:'ready',
					marketDataStatus:'INTERNAL',
					updatedAt:Number.isFinite(latestUpdate)?latestUpdate:Date.now(),
				});
			}catch{
				if(active)setData(current=>current.status==='ready'?current:{...current,status:'error'});
			}finally{
				refreshing=false;
			}
		}

		void refresh();
		const timer=window.setInterval(()=>void refresh(),refreshIntervalMs);
		return()=>{
			active=false;
			window.clearInterval(timer);
		};
	},[]);

	return <HomeMarketDataContext.Provider value={data}>{children}</HomeMarketDataContext.Provider>;
}

export function useHomeMarketData(){
	const data=useContext(HomeMarketDataContext);
	if(!data)throw new Error('useHomeMarketData must be used within HomeMarketDataProvider.');
	return data;
}
