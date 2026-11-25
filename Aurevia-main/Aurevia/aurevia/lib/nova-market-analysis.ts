import type {MarketCandle,TimeframeId} from '@/lib/live-market';

export type NovaSpecialist=
	|'Market Analyst'
	|'Technical Analyst'
	|'Stock Analyst'
	|'Forex Analyst'
	|'Cryptocurrency Analyst'
	|'Economic Analyst'
	|'Trading Coach'
	|'Risk Management Advisor'
	|'Portfolio Assistant'
	|'Aurevia Platform Support';

export type TechnicalIndicators={
	rsi14:number|null;
	macd:number|null;
	macdSignal:number|null;
	ema20:number|null;
	sma20:number|null;
	sma50:number|null;
	atr14:number|null;
	rangeLow:number|null;
	rangeHigh:number|null;
};

const specialistRules:Array<[RegExp,NovaSpecialist]>=[
	[/\b(wallet|deposit|withdraw|account|verification|kyc|tier|notification|aurevia|platform|demo|real)\b/i,'Aurevia Platform Support'],
	[/\b(portfolio|holdings|allocation|diversif)\b/i,'Portfolio Assistant'],
	[/\b(position size|risk|stop.?loss|drawdown|leverage)\b/i,'Risk Management Advisor'],
	[/\b(psychology|discipline|journal|revenge trade|fomo|coach)\b/i,'Trading Coach'],
	[/\b(fed|federal reserve|inflation|cpi|employment|payroll|interest rate|economic|announcement)\b/i,'Economic Analyst'],
	[/\b(forex|fx|currency pair|eur\/|gbp\/|usd\/|exchange rate)\b/i,'Forex Analyst'],
	[/\b(crypto|bitcoin|btc|ethereum|eth|solana|sol)\b/i,'Cryptocurrency Analyst'],
	[/\b(stock|share|equity|company|earnings|ticker)\b/i,'Stock Analyst'],
	[/\b(rsi|macd|ema|sma|atr|candles|support|resistance|technical)\b/i,'Technical Analyst'],
];

export function detectNovaSpecialist(question:string):NovaSpecialist{
	return specialistRules.find(([pattern])=>pattern.test(question))?.[1]||'Market Analyst';
}

export function detectNovaTimeframe(question:string):TimeframeId|null{
	const text=question.toLowerCase();
	const match=text.match(/\b(1m|5m|15m|30m|1h|4h|1d|1w|1mo|1y|5y)\b/);
	if(match)return match[1] as TimeframeId;
	if(/\b(daily|day|1 day)\b/.test(text))return '1d';
	if(/\b(weekly|week|1 week)\b/.test(text))return '1w';
	if(/\b(monthly|month|1 month)\b/.test(text))return '1mo';
	if(/\b(15 minutes?|15min)\b/.test(text))return '15m';
	if(/\b(5 minutes?|5min)\b/.test(text))return '5m';
	if(/\b(hourly|1 hour)\b/.test(text))return '1h';
	return null;
}

function average(values:number[]){
	return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
}

function sma(values:number[],period:number){
	return values.length>=period?average(values.slice(-period)):null;
}

function emaSeries(values:number[],period:number){
	if(values.length<period)return [];
	const initial=average(values.slice(0,period));
	if(initial===null)return [];
	const result=[initial];
	const multiplier=2/(period+1);
	for(const value of values.slice(period)){
		result.push(value*multiplier+result.at(-1)!*(1-multiplier));
	}
	return result;
}

function rounded(value:number|null){
	return value===null?null:Number(value.toFixed(4));
}

export function calculateTechnicalIndicators(candles:MarketCandle[]):TechnicalIndicators{
	const valid=candles
		.filter(candle=>[candle.time,candle.open,candle.high,candle.low,candle.close].every(Number.isFinite)
			&&candle.open>0&&candle.high>0&&candle.low>0&&candle.close>0
			&&candle.high>=candle.low)
		.sort((left,right)=>left.time-right.time);
	const closes=valid.map(candle=>candle.close);

	let rsi14:number|null=null;
	if(closes.length>=15){
		let gains=0;
		let losses=0;
		for(let index=1;index<=14;index++){
			const difference=closes[index]-closes[index-1];
			if(difference>0)gains+=difference;
			else losses-=difference;
		}
		let averageGain=gains/14;
		let averageLoss=losses/14;
		for(let index=15;index<closes.length;index++){
			const difference=closes[index]-closes[index-1];
			averageGain=(averageGain*13+Math.max(0,difference))/14;
			averageLoss=(averageLoss*13+Math.max(0,-difference))/14;
		}
		rsi14=averageLoss===0?averageGain===0?50:100:100-(100/(1+averageGain/averageLoss));
	}

	const ema12=emaSeries(closes,12);
	const ema26=emaSeries(closes,26);
	const macdSeries:number[]=[];
	const offset=ema12.length-ema26.length;
	for(let index=0;index<ema26.length;index++)macdSeries.push(ema12[index+offset]-ema26[index]);
	const signalSeries=emaSeries(macdSeries,9);

	const trueRanges=valid.slice(1).map((candle,index)=>{
		const previousClose=valid[index].close;
		return Math.max(candle.high-candle.low,Math.abs(candle.high-previousClose),Math.abs(candle.low-previousClose));
	});
	let atr14:number|null=null;
	if(trueRanges.length>=14){
		atr14=average(trueRanges.slice(0,14));
		for(const value of trueRanges.slice(14))atr14=atr14===null?value:(atr14*13+value)/14;
	}

	const range=valid.slice(-20);
	return {
		rsi14:rounded(rsi14),
		macd:rounded(macdSeries.at(-1)??null),
		macdSignal:rounded(signalSeries.at(-1)??null),
		ema20:rounded(emaSeries(closes,20).at(-1)??null),
		sma20:rounded(sma(closes,20)),
		sma50:rounded(sma(closes,50)),
		atr14:rounded(atr14),
		rangeLow:range.length?rounded(Math.min(...range.map(candle=>candle.low))):null,
		rangeHigh:range.length?rounded(Math.max(...range.map(candle=>candle.high))):null,
	};
}

export function formatNovaMarketAnalysis(input:{
	symbol:string;
	name:string;
	timeframe:TimeframeId;
	provider:string;
	candles:MarketCandle[];
	quote?:{price:number;updatedAt:string;source:string;change:number;changePercent:number}|null;
}){
	const candles=[...input.candles].sort((left,right)=>left.time-right.time);
	const latest=candles.at(-1);
	const indicators=calculateTechnicalIndicators(candles);
	const lastCandleAt=latest?new Date(latest.time*1000).toISOString():null;
	const quote=input.quote;
	const latestPrice=quote?.price??latest?.close??null;
	const trend=latestPrice===null?'not assessed':indicators.ema20===null?'insufficient candles':latestPrice>indicators.ema20?'above EMA(20)':'at or below EMA(20)';
	const macdState=indicators.macd===null||indicators.macdSignal===null
		?'unavailable (requires at least 34 candles)'
		:indicators.macd>indicators.macdSignal?'above its signal line in the supplied sample':'at or below its signal line in the supplied sample';
	const rsiState=indicators.rsi14===null
		?'unavailable (requires at least 15 candles)'
		:indicators.rsi14>=70?'elevated relative to the commonly used 70 threshold'
			:indicators.rsi14<=30?'depressed relative to the commonly used 30 threshold':'between the commonly used 30/70 thresholds';
	const levels=indicators.rangeLow===null||indicators.rangeHigh===null
		?'Not calculated: no valid candles were returned.'
		:`Recent ${Math.min(candles.length,20)}-candle range low: ${indicators.rangeLow}; high: ${indicators.rangeHigh}. These are observed range extremes, not validated support or resistance.`;
	const technical=[
		`EMA(20): ${indicators.ema20??'not available'}; SMA(20): ${indicators.sma20??'not available'}; SMA(50): ${indicators.sma50??'not available'}.`,
		`RSI(14): ${indicators.rsi14??'not available'} (${rsiState}).`,
		`MACD(12,26,9): ${indicators.macd===null||indicators.macdSignal===null?'not available':`${indicators.macd} vs signal ${indicators.macdSignal} (${macdState})`}.`,
		`ATR(14): ${indicators.atr14??'not available'} in price units; it estimates recent range, not direction.`,
	].map(value=>`- ${value}`).join('\n');
	const quoteLine=quote
		?`${quote.price} (daily change ${quote.change} / ${quote.changePercent}%) from ${quote.source}, provider timestamp ${quote.updatedAt}; freshness is based on provider timestamp and live-versus-delayed status is not declared by this integration.`
		:`No fresh external quote was returned; the latest historical close is ${latest?.close??'unavailable'} at ${lastCandleAt??'an unavailable timestamp'}.`;
	const bullish=indicators.rangeHigh===null
		?'A bullish scenario cannot be quantified from the available candles.'
		:`A bullish scenario would require follow-through and a hold above the recent range; a break above ${indicators.rangeHigh} would need confirmation.`;
	const bearish=indicators.rangeLow===null
		?'A bearish scenario cannot be quantified from the available candles.'
		:`A bearish scenario would involve rejection near the recent range high or a confirmed move below ${indicators.rangeLow}; neither is a forecast.`;
	const assessment=latestPrice===null?'Unavailable: no verified price or historical close is available.'
		:`The supplied ${input.timeframe} sample is ${trend} and MACD is ${macdState}. This is a limited technical snapshot, not a directional prediction.`;

	return [
		`Market overview\n${input.name} (${input.symbol}) · ${input.timeframe} timeframe · ${candles.length} historical candles.`,
		`Current verified conditions\n${quoteLine}\nHistorical source: ${input.provider}; last candle: ${lastCandleAt??'unavailable'}.`,
		`Technical observations\n${technical}`,
		`Bullish scenario\n${bullish}`,
		`Bearish scenario\n${bearish}`,
		`Support and resistance\n${levels}`,
		`Risk considerations\nATR and recent range describe past movement, not future risk limits. Prices can gap, liquidity and fees matter, and no indicator guarantees a result. Company fundamentals and a verified economic-event calendar are not included in this technical snapshot.`,
		`Overall assessment\n${assessment}`,
		'Market data timestamp and provider are shown above. The provider does not declare whether this feed is real-time or delayed. Educational information only; this is not a recommendation.',
	].join('\n\n');
}
