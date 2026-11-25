import {afterEach,describe,expect,it,vi} from 'vitest';
import {getFreeMarketCryptoHistory} from '@/lib/free-market-quotes';

afterEach(()=>vi.unstubAllGlobals());

describe('free crypto market history',()=>{
	it('parses CoinGecko OHLC candles for supported crypto instruments',async()=>{
		const timestamp=Date.UTC(2026,0,1);
		const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify([
			[timestamp+60_000,100,110,95,105],
			[timestamp,90,102,88,100],
		]),{status:200,headers:{'content-type':'application/json'}}));
		vi.stubGlobal('fetch',fetcher);

		await expect(getFreeMarketCryptoHistory('BTC','5d')).resolves.toEqual([
			{time:timestamp/1000,open:90,high:102,low:88,close:100,volume:null},
			{time:(timestamp+60_000)/1000,open:100,high:110,low:95,close:105,volume:null},
		]);
		expect(String(fetcher.mock.calls[0][0])).toBe('https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=7');
	});

	it('does not request history for an unsupported asset or timeframe',async()=>{
		const fetcher=vi.fn();
		vi.stubGlobal('fetch',fetcher);

		await expect(getFreeMarketCryptoHistory('DOGE','1d')).resolves.toEqual([]);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
