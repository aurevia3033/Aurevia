import {chartIntervalSeconds,normalizeChartCandles,type ChartCandle} from '@/lib/chart-candles';

type DemoCandleRecord={
	ts:string|Date;
	open:number|string;
	high:number|string;
	low:number|string;
	close:number|string;
	volume:number|string|null;
};

export function candleBucket(time:number,interval:string){
	if(interval==='1wk'){
		const date=new Date(time*1000);
		date.setUTCHours(0,0,0,0);
		date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
		return Math.floor(date.getTime()/1000);
	}
	if(interval==='1mo'){
		const date=new Date(time*1000);
		return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
	}
	const seconds=chartIntervalSeconds(interval);
	return Math.floor(time/seconds)*seconds;
}

function aggregateCandles(candles:ChartCandle[],interval:string):ChartCandle[]{
	const groups=new Map<number,ChartCandle[]>();
	for(const candle of candles){
		const bucket=candleBucket(candle.time,interval);
		groups.set(bucket,[...(groups.get(bucket)??[]),candle]);
	}
	return [...groups].map(([time,rows])=>({
		time,
		open:rows[0].open,
		high:Math.max(...rows.map(row=>row.high)),
		low:Math.min(...rows.map(row=>row.low)),
		close:rows[rows.length-1].close,
		volume:rows.every(row=>row.volume!==null)?rows.reduce((total,row)=>total+(row.volume??0),0):null,
	}));
}

export function normalizeDemoTradeCandles(records:DemoCandleRecord[],currentPrice:number,now=Date.now(),interval='1m'):ChartCandle[]{
	const normalized=normalizeChartCandles(records.map(record=>({
		time:Math.floor((record.ts instanceof Date?record.ts.getTime():Date.parse(record.ts))/1000),
		open:Number(record.open),
		high:Number(record.high),
		low:Number(record.low),
		close:Number(record.close),
		volume:record.volume===null?null:Number(record.volume),
	})));
	const candles=aggregateCandles(normalized,interval);
	if(candles.length)return candles;
	if(!Number.isFinite(currentPrice)||currentPrice<=0)return [];
	const time=candleBucket(Math.floor(now/1000),interval);
	return [{time,open:currentPrice,high:currentPrice,low:currentPrice,close:currentPrice,volume:null}];
}
