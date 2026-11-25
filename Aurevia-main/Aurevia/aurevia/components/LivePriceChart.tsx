'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {
	AreaSeries,CandlestickSeries,ColorType,HistogramSeries,LineSeries,LineStyle,createChart,
	type IChartApi,type IPriceLine,type ISeriesApi,type UTCTimestamp,
} from 'lightweight-charts';
import {TIMEFRAMES,type MarketCandle,type MarketQuote,type TimeframeId,isExternalMarketDataSource} from '@/lib/live-market';
import {chartIntervalSeconds,normalizeChartCandles,updateChartCandle,type ChartCandle} from '@/lib/chart-candles';
import {readChartTheme} from '@/lib/chart-theme';

type CandleSeries=ISeriesApi<'Candlestick'>;
type LineSeriesApi=ISeriesApi<'Line'>;
type AreaSeriesApi=ISeriesApi<'Area'>;
type PriceSeries=CandleSeries|LineSeriesApi|AreaSeriesApi;
type ChartStyle='candles'|'line'|'area';
type IndicatorValue={time:number;value:number};

export default function LivePriceChart({candles,quote,timeframe,interval,loading,error,source,ariaLabel,allowSimulatedHistory=false,quoteOnly=false}:{candles:MarketCandle[];quote?:MarketQuote;timeframe:TimeframeId;interval?:string;loading:boolean;error:string;source?:string;ariaLabel?:string;allowSimulatedHistory?:boolean;quoteOnly?:boolean}){
	const wrap=useRef<HTMLDivElement>(null);
	const host=useRef<HTMLDivElement>(null);
	const chartRef=useRef<IChartApi|null>(null);
	const candleSeries=useRef<PriceSeries|null>(null);
	const volumeSeries=useRef<ISeriesApi<'Histogram'>|null>(null);
	const fastAverageSeries=useRef<LineSeriesApi|null>(null);
	const slowAverageSeries=useRef<LineSeriesApi|null>(null);
	const currentPriceLine=useRef<IPriceLine|null>(null);
	const currentTimeframe=useRef(timeframe);
	const fullscreenFallback=useRef(false);
	const hasFit=useRef(false);
	const candlesRef=useRef<ChartCandle[]>([]);
	const autoFollowRef=useRef(true);
	const [chartStyle,setChartStyle]=useState<ChartStyle>('candles');
	const [showAverages,setShowAverages]=useState(false);
	const [showRsi,setShowRsi]=useState(false);
	const [showMacd,setShowMacd]=useState(false);
	const [autoFollow,setAutoFollow]=useState(true);
	const [isFullscreen,setIsFullscreen]=useState(false);
	const [fullscreenError,setFullscreenError]=useState('');
	const [hovered,setHovered]=useState<ChartCandle|null>(null);
	const [currentCandle,setCurrentCandle]=useState<ChartCandle|null>(null);
	const [now,setNow]=useState<number|null>(null);

	const externalHistory=!!source&&isExternalMarketDataSource(source);
	const simulatedHistory=allowSimulatedHistory&&(source==='Aurevia Internal'||source==='Aurevia DEMO');
	const internalHistory=allowSimulatedHistory&&source==='Aurevia Internal';
	const chartHistoryAvailable=externalHistory||simulatedHistory||internalHistory;
	const displayCandles=useMemo(()=>chartHistoryAvailable?normalizeChartCandles(candles):[],[candles,chartHistoryAvailable]);
	const activeInterval=interval||TIMEFRAMES.find(item=>item.id===timeframe)?.interval||'1m';
	const candleIntervalSeconds=chartIntervalSeconds(activeInterval);
	const quoteTimestamp=quote?Date.parse(quote.updatedAt):NaN;
	const quoteAge=now===null?Infinity:now-quoteTimestamp;
	const quoteIsUsable=!!quote&&isExternalMarketDataSource(quote.source)&&
		Number.isFinite(quoteTimestamp)&&Number.isFinite(quote.price)&&quote.price>0&&quoteAge<=24*60*60_000&&quoteAge>=-5_000;
	const quoteIsCurrent=quoteIsUsable&&!quote?.isStale&&quoteAge<=60_000;
	const quotePrice=externalHistory&&quoteIsUsable?quote?.price:undefined;
	const rsiValues=useMemo(()=>calculateRsi(displayCandles),[displayCandles]);
	const macdValues=useMemo(()=>calculateMacd(displayCandles),[displayCandles]);

	useEffect(()=>{
		const refreshNow=()=>setNow(Date.now());
		refreshNow();
		const timer=window.setInterval(refreshNow,15_000);
		return()=>window.clearInterval(timer);
	},[]);

	useEffect(()=>{
		if(!host.current)return;
		const palette=readChartTheme();
		const chart=createChart(host.current,{
			autoSize:true,
			layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:palette.label,fontFamily:'Avenir Next, Segoe UI, sans-serif',fontSize:11},
			grid:{vertLines:{color:palette.grid},horzLines:{color:palette.grid}},
			crosshair:{vertLine:{color:palette.accent,labelBackgroundColor:palette.accent},horzLine:{color:palette.accent,labelBackgroundColor:palette.accent}},
			rightPriceScale:{borderColor:palette.border,scaleMargins:{top:.08,bottom:.22}},
			timeScale:{borderColor:palette.border,timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:7,minBarSpacing:2},
			handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},
			handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:{time:true,price:true}},
			localization:{priceFormatter:(value:number)=>formatChartPrice(value)},
		});
		const initialSeries=createPriceSeries(chart,'candles',palette);
		const volume=chart.addSeries(HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false});
		chart.priceScale('volume').applyOptions({scaleMargins:{top:.82,bottom:0},visible:false});
		chartRef.current=chart;
		candleSeries.current=initialSeries;
		volumeSeries.current=volume;
		const crosshairHandler=(param:Parameters<typeof chart.subscribeCrosshairMove>[0] extends (arg:infer T)=>void?T:never)=>{
			if(!param.time){setHovered(null);return}
			const time=Number(param.time);
			setHovered(candlesRef.current.find(candle=>candle.time===time)??null);
		};
		chart.subscribeCrosshairMove(crosshairHandler);
		const onVisibleRangeChange:Parameters<ReturnType<IChartApi['timeScale']>['subscribeVisibleLogicalRangeChange']>[0]=range=>{
			if(!range)return;
			const nearLatest=range.to>=candlesRef.current.length-2;
			if(nearLatest!==autoFollowRef.current){
				autoFollowRef.current=nearLatest;
				setAutoFollow(nearLatest);
			}
		};
		chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleRangeChange);
		const updateTheme=()=>{
			const next=readChartTheme();
			chart.applyOptions({
				layout:{textColor:next.label},
				grid:{vertLines:{color:next.grid},horzLines:{color:next.grid}},
				crosshair:{vertLine:{color:next.accent,labelBackgroundColor:next.accent},horzLine:{color:next.accent,labelBackgroundColor:next.accent}},
				rightPriceScale:{borderColor:next.border},
				timeScale:{borderColor:next.border},
			});
			volume.setData(volumeData(candlesRef.current,next));
		};
		window.addEventListener('aurevia-theme-change',updateTheme);
		const observer=new ResizeObserver(entries=>{
			const width=entries[0]?.contentRect.width;
			if(width)chart.applyOptions({width});
		});
		observer.observe(host.current);
		return()=>{
			observer.disconnect();
			window.removeEventListener('aurevia-theme-change',updateTheme);
			chart.unsubscribeCrosshairMove(crosshairHandler);
			chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange);
			chart.remove();
			chartRef.current=null;
			candleSeries.current=null;
			volumeSeries.current=null;
			fastAverageSeries.current=null;
			slowAverageSeries.current=null;
			currentPriceLine.current=null;
		};
	},[]);

	useEffect(()=>{
		if(!chartRef.current||!candleSeries.current)return;
		const palette=readChartTheme();
		if(candleSeries.current){
			chartRef.current.removeSeries(candleSeries.current);
			candleSeries.current=null;
		}
		currentPriceLine.current=null;
		const series=createPriceSeries(chartRef.current,chartStyle,palette);
		candleSeries.current=series;
		setPriceSeriesData(series,chartStyle,candlesRef.current);
		if(autoFollowRef.current)chartRef.current.timeScale().scrollToRealTime();
	},[chartStyle]);

	useEffect(()=>{
		if(!displayCandles.length&&(loading||error)){
			return;
		}
		candlesRef.current=displayCandles;
		if(!chartRef.current||!candleSeries.current||!volumeSeries.current)return;
		setPriceSeriesData(candleSeries.current,chartStyle,displayCandles);
		volumeSeries.current.setData(volumeData(displayCandles,readChartTheme()));
		setCurrentCandle(displayCandles[displayCandles.length-1]??null);
		if(!displayCandles.length){
			hasFit.current=false;
			currentTimeframe.current=timeframe;
			return;
		}
		if(!hasFit.current||currentTimeframe.current!==timeframe){
			chartRef.current.timeScale().fitContent();
			hasFit.current=true;
			currentTimeframe.current=timeframe;
		}else if(autoFollowRef.current){
			chartRef.current.timeScale().scrollToRealTime();
		}
	},[displayCandles,chartStyle,timeframe,loading,error]);

	useEffect(()=>{
		const chart=chartRef.current;
		if(!chart||!candleSeries.current)return;
		if(showAverages){
			const palette=readChartTheme();
			if(!fastAverageSeries.current)fastAverageSeries.current=chart.addSeries(LineSeries,{color:palette.accent,lineWidth:1,crosshairMarkerVisible:false,lastValueVisible:false,priceLineVisible:false});
			if(!slowAverageSeries.current)slowAverageSeries.current=chart.addSeries(LineSeries,{color:'#8fb39a',lineWidth:1,crosshairMarkerVisible:false,lastValueVisible:false,priceLineVisible:false});
			fastAverageSeries.current.setData(movingAverage(displayCandles,20));
			slowAverageSeries.current.setData(movingAverage(displayCandles,50));
		}else{
			if(fastAverageSeries.current)chart.removeSeries(fastAverageSeries.current);
			if(slowAverageSeries.current)chart.removeSeries(slowAverageSeries.current);
			fastAverageSeries.current=null;
			slowAverageSeries.current=null;
		}
	},[displayCandles,showAverages,chartStyle]);

	useEffect(()=>{
		const series=candleSeries.current;
		if(!externalHistory||!candlesRef.current.length||!series||!quoteIsCurrent||quotePrice===undefined||!quote)return;
		const timestamp=Date.parse(quote.updatedAt);
		const updated=updateChartCandle(candlesRef.current,quotePrice,timestamp,2_000,candleIntervalSeconds,activeInterval);
		if(updated!==candlesRef.current){
			const latest=updated[updated.length-1];
			if(latest){
				updatePriceSeries(series,chartStyle,latest);
				if(latest.volume!==null)volumeSeries.current?.update({time:latest.time as UTCTimestamp,value:latest.volume,color:latest.close>=latest.open?readChartTheme().positiveFill:readChartTheme().negativeFill});
				candlesRef.current=updated;
				setCurrentCandle(latest);
				if(autoFollowRef.current)chartRef.current?.timeScale().scrollToRealTime();
			}
		}
	},[activeInterval,candleIntervalSeconds,chartStyle,externalHistory,quote,quoteIsCurrent,quotePrice]);

	useEffect(()=>{
		const series=candleSeries.current;
		if(currentPriceLine.current&&series)series.removePriceLine(currentPriceLine.current);
		currentPriceLine.current=null;
		if(!quotePrice||!series)return;
		const palette=readChartTheme();
		currentPriceLine.current=series.createPriceLine({
			price:quotePrice,color:palette.accent,lineWidth:1,lineStyle:LineStyle.Dashed,
			axisLabelVisible:true,title:quoteIsCurrent?'CURRENT':'LAST',
		});
	},[chartStyle,quoteIsCurrent,quotePrice]);

	useEffect(()=>{
		const onFullscreenChange=()=>{
			const nativeFullscreen=document.fullscreenElement===wrap.current;
			setIsFullscreen(nativeFullscreen||fullscreenFallback.current);
		};
		document.addEventListener('fullscreenchange',onFullscreenChange);
		return()=>document.removeEventListener('fullscreenchange',onFullscreenChange);
	},[]);

	useEffect(()=>{
		if(!fullscreenFallback.current)return;
		const previousOverflow=document.body.style.overflow;
		const onKeyDown=(event:KeyboardEvent)=>{
			if(event.key==='Escape'){
				fullscreenFallback.current=false;
				setIsFullscreen(false);
			}
		};
		document.body.style.overflow='hidden';
		window.addEventListener('keydown',onKeyDown);
		return()=>{
			document.body.style.overflow=previousOverflow;
			window.removeEventListener('keydown',onKeyDown);
		};
	},[isFullscreen]);

	function zoom(direction:'in'|'out'){
		const timeScale=chartRef.current?.timeScale();
		const range=timeScale?.getVisibleLogicalRange();
		if(!timeScale||!range||displayCandles.length<2)return;
		const center=(range.from+range.to)/2;
		const factor=direction==='in'?.8:1.25;
		const halfWidth=Math.max(5,(range.to-range.from)*factor/2);
		timeScale.setVisibleLogicalRange({from:Math.max(0,center-halfWidth),to:Math.min(Math.max(0,displayCandles.length-1),center+halfWidth)});
	}

	async function toggleFullscreen(){
		setFullscreenError('');
		try{
			if(document.fullscreenElement)await document.exitFullscreen();
			else if(fullscreenFallback.current){
				fullscreenFallback.current=false;
				setIsFullscreen(false);
			}else{
				if(!wrap.current?.requestFullscreen)throw new Error('NATIVE_FULLSCREEN_UNAVAILABLE');
				await wrap.current.requestFullscreen();
			}
		}catch{
			fullscreenFallback.current=true;
			setIsFullscreen(true);
		}
	}

	function followLatest(){
		autoFollowRef.current=true;
		setAutoFollow(true);
		chartRef.current?.timeScale().scrollToRealTime();
	}

	const shown=hovered||currentCandle||displayCandles[displayCandles.length-1];
	const marketStatus=quoteOnly?'QUOTE ONLY':quoteIsCurrent?'CURRENT':quotePrice!==undefined?'DELAYED':simulatedHistory?'SIMULATED':externalHistory?'HISTORY':'UNAVAILABLE';
	const unavailableMessage=!chartHistoryAvailable&&source
		?`Provider-backed candles are unavailable (${source} is indicative, not live market history).`
		:!source?'Market data source is unavailable.':undefined;

	return <div className={`live-chart-wrap ${isFullscreen?'is-fullscreen':''}`} ref={wrap}>
		<div className="live-chart-toolbar" role="toolbar" aria-label="Chart display controls">
			<div className="live-chart-style" role="group" aria-label="Chart style">
				{(['candles','line','area'] as const).map(style=><button type="button" key={style} aria-pressed={chartStyle===style} onClick={()=>setChartStyle(style)}>{style==='candles'?'Candles':style==='line'?'Line':'Area'}</button>)}
			</div>
			<div className="live-chart-tools">
				<button type="button" aria-pressed={showAverages} onClick={()=>setShowAverages(value=>!value)}>MA</button>
				<button type="button" aria-pressed={showRsi} onClick={()=>setShowRsi(value=>!value)}>RSI</button>
				<button type="button" aria-pressed={showMacd} onClick={()=>setShowMacd(value=>!value)}>MACD</button>
				<button type="button" aria-label="Zoom in" title="Zoom in" onClick={()=>zoom('in')}>+</button>
				<button type="button" aria-label="Zoom out" title="Zoom out" onClick={()=>zoom('out')}>−</button>
				<button type="button" aria-pressed={autoFollow} onClick={followLatest}>Latest</button>
				<button type="button" aria-label={isFullscreen?'Exit full screen':'Enter full screen'} onClick={()=>void toggleFullscreen()}>{isFullscreen?'Exit full screen':'Full screen'}</button>
			</div>
			<span className={`live-chart-data-status is-${quoteOnly?'quote-only':marketStatus.toLowerCase()}`}>{marketStatus}{quote&&quoteIsCurrent?` · ${quote.source}`:source?` · ${source}`:''}</span>
		</div>
		<div className="live-chart-readout" aria-live="polite">
			{shown?quoteOnly?<><span className="live-chart-candle-time">{formatCandleTime(shown.time,activeInterval)}</span><span>Latest provider quote {formatChartPrice(shown.close)}</span></>:<><span className="live-chart-candle-time">{formatCandleTime(shown.time,activeInterval)}</span><span>O {formatChartPrice(shown.open)}</span><span>H {formatChartPrice(shown.high)}</span><span>L {formatChartPrice(shown.low)}</span><span>C {formatChartPrice(shown.close)}</span><span>V {shown.volume===null?'—':formatVolume(shown.volume)}</span></>:<span>{loading?'Loading chart…':unavailableMessage||'OHLC values unavailable'}</span>}
			{quote&&quoteIsUsable&&<span className="live-chart-update">{quoteIsCurrent?'QUOTE':'LAST QUOTE'} {new Date(quote.updatedAt).toLocaleTimeString()}</span>}
		</div>
		<div className="live-chart-canvas" ref={host} role={chartHistoryAvailable?'img':undefined} aria-label={chartHistoryAvailable?(quoteOnly?'Latest provider quote marker; historical candles unavailable':ariaLabel||(
			chartStyle==='candles'?'Interactive live market candlestick and volume chart':`Interactive live market ${chartStyle} chart with price and volume`
		)):undefined} aria-hidden={!chartHistoryAvailable}/>
		{(showRsi||showMacd)&&<div className="live-chart-indicators">
			{showRsi&&<IndicatorPanel title="RSI 14" values={rsiValues} fixedRange={[0,100]} lastValue={rsiValues.at(-1)?.value}/>}
			{showMacd&&<IndicatorPanel title="MACD 12 · 26 · 9" values={macdValues} lastValue={macdValues.at(-1)?.value}/>}
		</div>}
		{unavailableMessage&&<div className="live-chart-message" role="status">{unavailableMessage}</div>}
		{quoteOnly&&<div className="live-chart-message" role="status">Historical candles unavailable. Showing the latest verified provider quote only.</div>}
		{error&&<div className="live-chart-message" role="status">{error}</div>}
		{loading&&!displayCandles.length&&<div className="live-chart-message" role="status">Fetching historical candles…</div>}
		{fullscreenError&&<div className="live-chart-message" role="alert">{fullscreenError}</div>}
	</div>;
}

function createPriceSeries(chart:IChartApi,style:ChartStyle,palette:ReturnType<typeof readChartTheme>):PriceSeries{
	if(style==='candles')return chart.addSeries(CandlestickSeries,{
		upColor:palette.positive,downColor:palette.negative,borderVisible:false,wickUpColor:palette.positive,wickDownColor:palette.negative,
	});
	if(style==='line')return chart.addSeries(LineSeries,{color:palette.positive,lineWidth:2,crosshairMarkerVisible:true,lastValueVisible:false,priceLineVisible:false});
	return chart.addSeries(AreaSeries,{lineColor:palette.positive,topColor:palette.positiveFill,bottomColor:'rgba(0,0,0,0)',lineWidth:2,lastValueVisible:false,priceLineVisible:false});
}

function setPriceSeriesData(series:PriceSeries,style:ChartStyle,candles:ChartCandle[]){
	if(style==='candles'){
		(series as CandleSeries).setData(candles.map(({time,open,high,low,close})=>({time:time as UTCTimestamp,open,high,low,close})));
		return;
	}
	const data=candles.map(({time,close})=>({time:time as UTCTimestamp,value:close}));
	if(style==='line')(series as LineSeriesApi).setData(data);
	else (series as AreaSeriesApi).setData(data);
}

function updatePriceSeries(series:PriceSeries,style:ChartStyle,candle:ChartCandle){
	const time=candle.time as UTCTimestamp;
	if(style==='candles')(series as CandleSeries).update({time,open:candle.open,high:candle.high,low:candle.low,close:candle.close});
	else (series as LineSeriesApi|AreaSeriesApi).update({time,value:candle.close});
}

function volumeData(candles:ChartCandle[],palette:ReturnType<typeof readChartTheme>){
	return candles.flatMap(candle=>candle.volume===null?[]:[{
		time:candle.time as UTCTimestamp,value:candle.volume,
		color:candle.close>=candle.open?palette.positiveFill:palette.negativeFill,
	}]);
}

function movingAverage(candles:ChartCandle[],period:number){
	return candles.flatMap((candle,index)=>{
		if(index+1<period)return [];
		const values=candles.slice(index+1-period,index+1);
		return [{time:candle.time as UTCTimestamp,value:values.reduce((sum,row)=>sum+row.close,0)/period}];
	});
}

function calculateRsi(candles:ChartCandle[],period=14):IndicatorValue[]{
	if(candles.length<=period)return [];
	let gains=0,losses=0;
	for(let index=1;index<=period;index++){
		const change=candles[index].close-candles[index-1].close;
		gains+=Math.max(0,change);
		losses+=Math.max(0,-change);
	}
	let averageGain=gains/period,averageLoss=losses/period;
	const result:IndicatorValue[]=[];
	for(let index=period;index<candles.length;index++){
		if(index>period){
			const change=candles[index].close-candles[index-1].close;
			averageGain=(averageGain*(period-1)+Math.max(0,change))/period;
			averageLoss=(averageLoss*(period-1)+Math.max(0,-change))/period;
		}
		const value=averageLoss===0?(averageGain===0?50:100):100-100/(1+averageGain/averageLoss);
		result.push({time:candles[index].time,value});
	}
	return result;
}

function calculateMacd(candles:ChartCandle[]):IndicatorValue[]{
	if(candles.length<26)return [];
	const fast=ema(candles.map(candle=>candle.close),12);
	const slow=ema(candles.map(candle=>candle.close),26);
	return candles.flatMap((candle,index)=>index<25?[]:[{time:candle.time,value:fast[index]-slow[index]}]);
}

function ema(values:number[],period:number){
	const result=Array<number>(values.length);
	const multiplier=2/(period+1);
	result[0]=values[0];
	for(let index=1;index<values.length;index++)result[index]=values[index]*multiplier+result[index-1]*(1-multiplier);
	return result;
}

function IndicatorPanel({title,values,fixedRange,lastValue}:{title:string;values:IndicatorValue[];fixedRange?:[number,number];lastValue?:number}){
	const visible=values.slice(-80);
	const low=fixedRange?.[0]??Math.min(0,...visible.map(item=>item.value));
	const high=fixedRange?.[1]??Math.max(0,...visible.map(item=>item.value));
	const range=high-low||1;
	const points=visible.map((item,index)=>`${visible.length<=1?50:index/(visible.length-1)*100},${45-(item.value-low)/range*38}`).join(' ');
	return <div className="live-chart-indicator" role="img" aria-label={`${title}${lastValue===undefined?'':` ${lastValue.toFixed(2)}`}`}>
		<span>{title}</span><b>{lastValue===undefined?'—':lastValue.toFixed(2)}</b>
		<svg viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
			{fixedRange&&<><line x1="0" x2="100" y1="18.4" y2="18.4"/><line x1="0" x2="100" y1="33.6" y2="33.6"/></>}
			<polyline points={points}/>
		</svg>
	</div>;
}

function formatChartPrice(value:number){return value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:value<10?5:2});}
function formatVolume(value:number){return new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:2}).format(value);}
function formatCandleTime(value:number,interval:string){
	const date=new Date(value*1000);
	const options:Intl.DateTimeFormatOptions=/^\d+(m|h)$/.test(interval)
		?{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}
		:{year:'numeric',month:'short',day:'2-digit'};
	return date.toLocaleString(undefined,options);
}
