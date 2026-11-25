import {describe,expect,it} from 'vitest';
import {calculateTechnicalIndicators,detectNovaSpecialist,detectNovaTimeframe,formatNovaMarketAnalysis} from '@/lib/nova-market-analysis';
import type {MarketCandle} from '@/lib/live-market';

function risingCandles(count=60):MarketCandle[]{
	return Array.from({length:count},(_,index)=>{
		const close=100+index;
		return {time:1_700_000_000+index*86_400,open:close-0.5,high:close+2,low:close-2,close,volume:1000+index};
	});
}

describe('Nova market intelligence',()=>{
	it('calculates indicators from historical candles and leaves short histories unavailable',()=>{
		const indicators=calculateTechnicalIndicators(risingCandles());
		expect(indicators.rsi14).toBe(100);
		expect(indicators.macd).not.toBeNull();
		expect(indicators.macdSignal).not.toBeNull();
		expect(indicators.sma20).toBe(149.5);
		expect(indicators.sma50).toBe(134.5);
		expect(indicators.atr14).toBeGreaterThan(0);
		expect(indicators.rangeLow).toBe(138);
		expect(indicators.rangeHigh).toBe(161);
		expect(calculateTechnicalIndicators(risingCandles(14))).toMatchObject({
			rsi14:null,macd:null,macdSignal:null,ema20:null,sma20:null,sma50:null,atr14:null,
		});
	});

	it('treats a flat market as neutral RSI rather than a zero-loss overbought reading',()=>{
		const candles=risingCandles(20).map(candle=>({...candle,open:100,high:101,low:99,close:100}));
		expect(calculateTechnicalIndicators(candles).rsi14).toBe(50);
	});

	it('identifies specialist focus and recognizes supported natural-language timeframes',()=>{
		expect(detectNovaSpecialist('Explain RSI for EUR/USD')).toBe('Forex Analyst');
		expect(detectNovaSpecialist('What was the latest Fed announcement?')).toBe('Economic Analyst');
		expect(detectNovaSpecialist('How do I manage position risk?')).toBe('Risk Management Advisor');
		expect(detectNovaTimeframe('Analyze BTC on 1d')).toBe('1d');
		expect(detectNovaTimeframe('Review the weekly trend')).toBe('1w');
		expect(detectNovaTimeframe('Analyze BTC')).toBeNull();
	});

	it('formats sourced market analysis with conditional scenarios and explicit data caveats',()=>{
		const candles=risingCandles();
		const answer=formatNovaMarketAnalysis({
			symbol:'BTC',name:'Bitcoin USD',timeframe:'1d',provider:'Twelve Data',candles,
			quote:{price:160,updatedAt:'2026-11-18T12:00:00.000Z',source:'Twelve Data',change:1,changePercent:0.6},
		});
		expect(answer).toContain('from Twelve Data');
		expect(answer).toContain('RSI(14): 100');
		expect(answer).toContain('Bullish scenario');
		expect(answer).toContain('Bearish scenario');
		expect(answer).toContain('not validated support or resistance');
		expect(answer).toContain('live-versus-delayed status is not declared');
		expect(answer).toContain('not a recommendation');
	});
});
