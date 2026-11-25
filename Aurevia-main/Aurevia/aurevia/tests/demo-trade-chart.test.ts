import {describe,expect,it} from 'vitest';
import {normalizeDemoTradeCandles} from '@/lib/demo-trade-chart';

describe('DEMO trade chart candles',()=>{
	it('normalizes stored simulated candles and preserves their OHLCV values',()=>{
		expect(normalizeDemoTradeCandles([{
			ts:'2026-11-18T19:00:00.000Z',
			open:'99.5',
			high:'101',
			low:'98',
			close:'100.5',
			volume:'12.25',
		}],100,Date.parse('2026-11-18T19:01:00Z'))).toEqual([{
			time:Date.parse('2026-11-18T19:00:00Z')/1000,
			open:99.5,
			high:101,
			low:98,
			close:100.5,
			volume:12.25,
		}]);
	});

	it('shows a clearly limited current-mark candle before simulated history exists',()=>{
		expect(normalizeDemoTradeCandles([],125,Date.parse('2026-11-18T19:01:42Z'),'1m')).toEqual([{
			time:Date.parse('2026-11-18T19:01:00Z')/1000,
			open:125,
			high:125,
			low:125,
			close:125,
			volume:null,
		}]);
		expect(normalizeDemoTradeCandles([],0,Date.now())).toEqual([]);
	});

	it('aggregates stored candles into the selected chart interval',()=>{
		const candles=normalizeDemoTradeCandles([
			{ts:'2026-11-18T19:00:00Z',open:'99',high:'101',low:'98',close:'100',volume:'2'},
			{ts:'2026-11-18T19:01:00Z',open:'100',high:'103',low:'99',close:'102',volume:'3'},
		],102,Date.parse('2026-11-18T19:02:00Z'),'5m');
		expect(candles).toEqual([{
			time:Math.floor(Date.parse('2026-11-18T19:00:00Z')/300_000)*300,
			open:99,
			high:103,
			low:98,
			close:102,
			volume:5,
		}]);
	});

	it('drops invalid stored bars instead of charting malformed prices',()=>{
		expect(normalizeDemoTradeCandles([{
			ts:'2026-11-18T19:00:00.000Z',
			open:'100',
			high:'99',
			low:'98',
			close:'101',
			volume:'1',
		}],125,Date.parse('2026-11-18T19:01:42Z'),'1m')[0]).toMatchObject({
			open:125,high:125,low:125,close:125,volume:null,
		});
	});
});
