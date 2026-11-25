import {describe,expect,it} from 'vitest';
import {marketHistoryCacheKey,readMarketHistoryCache,writeMarketHistoryCache} from '@/lib/market-history-cache';
import type {MarketHistoryResponse} from '@/lib/market-history-cache';

function createStorage(){
	const values=new Map<string,string>();
	return {
		getItem:(key:string)=>values.get(key)??null,
		setItem:(key:string,value:string)=>{values.set(key,value)},
	};
}

const history:MarketHistoryResponse={
	quote:null,
	candles:[{time:1_800_000_000,open:190,high:192,low:188,close:191,volume:10}],
	timeframe:'1d',
	interval:'1d',
	source:'Twelve Data',
};

describe('market history cache',()=>{
	it('returns previously verified history with an explicit cached marker',()=>{
		const storage=createStorage();
		const cacheKey=marketHistoryCacheKey('AAPL','1d');

		writeMarketHistoryCache(storage,cacheKey,history,1_800_000_100_000);

		expect(readMarketHistoryCache(storage,cacheKey,1_800_000_200_000)).toMatchObject({
			...history,isCached:true,cachedAt:new Date(1_800_000_100_000).toISOString(),
		});
	});

	it('ignores expired or invalid cached history',()=>{
		const storage=createStorage();
		const cacheKey=marketHistoryCacheKey('AAPL','1d');
		const now=Date.now();

		writeMarketHistoryCache(storage,cacheKey,history,now);
		expect(readMarketHistoryCache(storage,cacheKey,now+7*24*60*60_000+1)).toBeUndefined();

		const invalidStorage=createStorage();
		writeMarketHistoryCache(invalidStorage,cacheKey,{...history,candles:[{...history.candles[0],close:0}]},now);
		expect(readMarketHistoryCache(invalidStorage,cacheKey,now)).toBeUndefined();
	});
});
