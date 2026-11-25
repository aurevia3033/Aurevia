import {describe,expect,it} from 'vitest';
import {mapSimulatedHomeMarketFeed} from '@/components/HomeMarketData';

describe('homepage simulated market fallback',()=>{
	it('maps only supported simulated instruments to clearly sourced market items',()=>{
		const updatedAt=new Date().toISOString();
		const markets=mapSimulatedHomeMarketFeed([
			{symbol:'BTC/USD',baseAsset:'BTC',quoteAsset:'USD',name:'Bitcoin / USD',price:'92500',dataMode:'SIMULATED',lastUpdatedAt:updatedAt},
			{symbol:'EUR/USD',baseAsset:'EUR',quoteAsset:'USD',name:'Euro / US Dollar',price:'1.08',dataMode:'SIMULATED',lastUpdatedAt:updatedAt},
			{symbol:'AUR/USD',baseAsset:'AUR',quoteAsset:'USD',name:'Aurevia Dollar',price:'81',dataMode:'SIMULATED',lastUpdatedAt:updatedAt},
			{symbol:'NVDA',baseAsset:'NVDA',quoteAsset:'USD',name:'NVIDIA',price:'140',dataMode:'LIVE',lastUpdatedAt:updatedAt},
			{symbol:'ETH/USD',baseAsset:'ETH',quoteAsset:'USD',name:'Ethereum / USD',price:'0',dataMode:'SIMULATED',lastUpdatedAt:updatedAt},
		]);

		expect(markets.map(item=>item.id)).toEqual(['BTC','EURUSD']);
		expect(markets[0]).toMatchObject({
			price:92500,
			quote:{source:'Aurevia DEMO market feed',isStale:false},
		});
		expect(markets[1].quote.asset).toMatchObject({id:'EURUSD',currency:'USD'});
	});

	it('rejects malformed or non-array market-feed responses',()=>{
		expect(mapSimulatedHomeMarketFeed(null)).toEqual([]);
		expect(mapSimulatedHomeMarketFeed([{dataMode:'SIMULATED',symbol:'BTC',price:'not-a-price'}])).toEqual([]);
	});
});
