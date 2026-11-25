import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	sourceUpsert:vi.fn(),
	sourceFindMany:vi.fn(),
	safeFetchText:vi.fn(),
	parseRssOrAtom:vi.fn(),
	fetchGnewsTopHeadlines:vi.fn(),
	isGnewsAllowed:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{newsFeedSource:{upsert:mocks.sourceUpsert,findMany:mocks.sourceFindMany}}}));
vi.mock('@/lib/news-feed/safe-fetch',()=>({safeFetchText:mocks.safeFetchText}));
vi.mock('@/lib/news-feed/rss',()=>({parseRssOrAtom:mocks.parseRssOrAtom}));
vi.mock('@/lib/news-feed/gnews',()=>({
	fetchGnewsTopHeadlines:mocks.fetchGnewsTopHeadlines,
	isGnewsAllowed:mocks.isGnewsAllowed,
}));

import {syncAllEnabledNewsSources} from '@/lib/news-feed/sync';

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.sourceUpsert.mockResolvedValue({});
	mocks.sourceFindMany.mockResolvedValue([{
		id:'source-1',
		key:'federal-reserve-press-all',
		pollIntervalMinutes:15,
		lastSuccessAt:null,
		lastSyncedAt:new Date(),
	}]);
});

describe('news source sync cooldown',()=>{
	it('does not retry a recent failed or incomplete sync on every public request',async()=>{
		const results=await syncAllEnabledNewsSources();

		expect(results).toEqual([expect.objectContaining({key:'federal-reserve-press-all',skipped:true,reason:'NOT_DUE'})]);
		expect(mocks.safeFetchText).not.toHaveBeenCalled();
	});
});
