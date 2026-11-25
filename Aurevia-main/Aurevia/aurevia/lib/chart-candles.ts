export type ChartCandle = {
	time:number;
	open:number;
	high:number;
	low:number;
	close:number;
	volume:number|null;
};

export function chartIntervalSeconds(interval:string|undefined,fallback=60){
	const match=interval?.match(/^(\d+)(m|h|d|w|wk|mo)$/);
	if(!match)return fallback;
	const amount=Number(match[1]);
	const unitSeconds:Record<string,number>={m:60,h:3_600,d:86_400,w:604_800,wk:604_800,mo:2_592_000};
	const unit=match[2];
	if(!Number.isFinite(amount)||amount<1||!(unit in unitSeconds))return fallback;
	return amount*unitSeconds[unit];
}

export function normalizeChartCandles(candles:ChartCandle[]):ChartCandle[]{
	const byTime=new Map<number,ChartCandle>();
	for(const candle of candles){
		if(!Number.isFinite(candle.time)||!Number.isInteger(candle.time)||
			![candle.open,candle.high,candle.low,candle.close].every(value=>Number.isFinite(value)&&value>0)||
			candle.high<Math.max(candle.open,candle.close)||candle.low>Math.min(candle.open,candle.close)||
			candle.volume!==null&&(!Number.isFinite(candle.volume)||candle.volume<0))continue;
		byTime.set(candle.time,candle);
	}
	return [...byTime.values()].sort((left,right)=>left.time-right.time);
}

export function aggregateChartCandles(candles:ChartCandle[],interval:'4h'|'1wk'|'1mo'):ChartCandle[]{
	const normalized=normalizeChartCandles(candles);
	const grouped=new Map<number,ChartCandle[]>();
	for(const candle of normalized){
		let time:number;
		if(interval==='4h')time=Math.floor(candle.time/14_400)*14_400;
		else if(interval==='1wk'){
			const date=new Date(candle.time*1000);
			date.setUTCHours(0,0,0,0);
			date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
			time=Math.floor(date.getTime()/1000);
		}else{
			const date=new Date(candle.time*1000);
			time=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
		}
		grouped.set(time,[...(grouped.get(time)??[]),candle]);
	}
	return [...grouped].map(([time,rows])=>({
		time,
		open:rows[0].open,
		high:Math.max(...rows.map(row=>row.high)),
		low:Math.min(...rows.map(row=>row.low)),
		close:rows[rows.length-1].close,
		volume:rows.every(row=>row.volume!==null)?rows.reduce((total,row)=>total+(row.volume??0),0):null,
	}));
}

export function updateChartCandle(candles:ChartCandle[],price:number,timestamp:number,limit:number,intervalSeconds=60,interval?:string):ChartCandle[]{
	if(!Number.isFinite(price)||price<=0||!Number.isFinite(timestamp)||!Number.isInteger(limit)||limit<1||!Number.isFinite(intervalSeconds)||intervalSeconds<1)return candles;
	const time=candleStart(timestamp,intervalSeconds,interval);
	const latest=candles[candles.length-1];
	if(latest&&time<latest.time)return candles;
	if(latest&&time===latest.time){
		return [
			...candles.slice(0,-1),
			{...latest,high:Math.max(latest.high,price),low:Math.min(latest.low,price),close:price},
		].slice(-limit);
	}

	function candleStart(timestamp:number,intervalSeconds:number,interval?:string){
		const date=new Date(timestamp);
		if(interval==='1wk'){
			date.setUTCHours(0,0,0,0);
			date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);
			return Math.floor(date.getTime()/1000);
		}
		if(interval==='1mo')return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
		return Math.floor(timestamp/1000/intervalSeconds)*intervalSeconds;
	}
	return [
		...candles,
		{time,open:price,high:price,low:price,close:price,volume:null},
	].slice(-limit);
}

export function createQuoteOnlyCandle(price:number,timestamp:number,interval:string):ChartCandle[]{
	return updateChartCandle([],price,timestamp,1,chartIntervalSeconds(interval),interval);
}
