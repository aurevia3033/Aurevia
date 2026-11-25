import {describe,expect,it} from 'vitest';
import {aggregateChartCandles,chartIntervalSeconds,createQuoteOnlyCandle,normalizeChartCandles,updateChartCandle,type ChartCandle} from '@/lib/chart-candles';

const initial:ChartCandle[]=[{time:120,open:10,high:11,low:9,close:10.5,volume:12}];

describe('chart candle updates',()=>{
	it('converts provider intervals to candle durations',()=>{
		expect(chartIntervalSeconds('5m')).toBe(300);
		expect(chartIntervalSeconds('1h')).toBe(3_600);
		expect(chartIntervalSeconds('4h')).toBe(14_400);
		expect(chartIntervalSeconds('1wk')).toBe(604_800);
		expect(chartIntervalSeconds('1mo')).toBe(2_592_000);
		expect(chartIntervalSeconds('unknown')).toBe(60);
	});

	it('normalizes provider candles into unique chronological bars without altering OHLCV',()=>{
		const rows:ChartCandle[]=[
			{time:120,open:11,high:12,low:10,close:11.5,volume:2},
			{time:60,open:10,high:11,low:9,close:10.5,volume:1},
			{time:60,open:10,high:11,low:9,close:10.5,volume:1},
			{time:180,open:12,high:11,low:10,close:11,volume:3},
		];
		expect(normalizeChartCandles(rows)).toEqual(rows.slice(0,2).reverse());
	});

	it('aggregates four hourly provider bars without duplicating timestamps or inventing volume',()=>{
		const candles:ChartCandle[]=[
			{time:0,open:10,high:12,low:9,close:11,volume:3},
			{time:3_600,open:11,high:14,low:10,close:13,volume:4},
			{time:7_200,open:13,high:15,low:12,close:14,volume:null},
			{time:10_800,open:14,high:16,low:13,close:15,volume:2},
			{time:14_400,open:15,high:17,low:14,close:16,volume:5},
		];
		expect(aggregateChartCandles(candles,'4h')).toEqual([
			{time:0,open:10,high:16,low:9,close:15,volume:null},
			{time:14_400,open:15,high:17,low:14,close:16,volume:5},
		]);
	});

	it('starts forming weekly and monthly candles at calendar boundaries',()=>{
		const time=Date.parse('2026-11-18T12:00:00Z');
		const weekly=updateChartCandle([],12,time,10,604_800,'1wk');
		const monthly=updateChartCandle([],12,time,10,2_592_000,'1mo');
		expect(weekly[0].time).toBe(Date.parse('2026-11-16T00:00:00Z')/1000);
		expect(monthly[0].time).toBe(Date.parse('2026-11-01T00:00:00Z')/1000);
	});

	it('updates the forming interval candle without changing its open',()=>{
		const updated=updateChartCandle(initial,12,150_500,10,60);
		expect(updated).toEqual([{time:120,open:10,high:12,low:9,close:12,volume:12}]);
	});

	it('starts a candle at the next interval boundary and keeps the configured history length',()=>{
		const updated=updateChartCandle(initial,12,180_000,1,60);
		expect(updated).toEqual([{time:180,open:12,high:12,low:12,close:12,volume:null}]);
	});

	it('creates a single timestamp-aligned marker for a verified provider quote',()=>{
		expect(createQuoteOnlyCandle(42_000,Date.parse('2026-11-18T19:02:42Z'),'5m')).toEqual([{
			time:Math.floor(Date.parse('2026-11-18T19:02:42Z')/300_000)*300,
			open:42_000,
			high:42_000,
			low:42_000,
			close:42_000,
			volume:null,
		}]);
		expect(createQuoteOnlyCandle(0,Date.now(),'1m')).toEqual([]);
	});

	it('aggregates updates within a five-minute candle',()=>{
		const fiveMinuteInitial:ChartCandle[]=[{time:300,open:10,high:11,low:9,close:10.5,volume:12}];
		const updated=updateChartCandle(fiveMinuteInitial,12,540_000,10,300);
		expect(updated).toEqual([{time:300,open:10,high:12,low:9,close:12,volume:12}]);
	});

	it('ignores invalid prices and out-of-order ticks',()=>{
		expect(updateChartCandle(initial,0,180_000,10)).toBe(initial);
		expect(updateChartCandle(initial,12,119_000,10)).toBe(initial);
	});
});
