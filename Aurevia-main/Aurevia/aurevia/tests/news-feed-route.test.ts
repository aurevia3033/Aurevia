import {NewsFeedItemStatus} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	itemCount:vi.fn(),
	itemFindMany:vi.fn(),
	sourceFindMany:vi.fn(),
	syncAllEnabledNewsSources:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	newsFeedItem:{count:mocks.itemCount,findMany:mocks.itemFindMany},
	newsFeedSource:{findMany:mocks.sourceFindMany},
}}));
vi.mock('@/lib/news-feed/sync',()=>({syncAllEnabledNewsSources:mocks.syncAllEnabledNewsSources}));

import {GET} from '@/app/api/news-feed/route';

const request=()=>new Request('https://aurevia.test/api/news-feed');
const article={
	id:'article-1',
	title:'Central bank maintains rates',
	summary:'The committee held rates steady.',
	canonicalUrl:'https://publisher.test/article-1',
	publisher:'Publisher',
	author:null,
	category:'ECONOMIC_NEWS',
	contentType:'article',
	publishedAt:new Date('2026-11-23T02:00:00.000Z'),
	thumbnailUrl:null,
	source:{key:'federal-reserve-press-all',displayName:'Federal Reserve',providerType:'RSS'},
};

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.itemCount.mockResolvedValue(1);
	mocks.itemFindMany.mockResolvedValue([article]);
	mocks.sourceFindMany.mockResolvedValue([]);
	mocks.syncAllEnabledNewsSources.mockResolvedValue([]);
});

describe('public news feed route',()=>{
	it('syncs configured sources when the feed has no articles yet',async()=>{
		mocks.itemCount.mockResolvedValueOnce(0);
		const response=await GET(request());

		expect(response.status).toBe(200);
		expect((await response.json()).items).toHaveLength(1);
		expect(mocks.syncAllEnabledNewsSources).toHaveBeenCalledOnce();
		expect(mocks.itemCount).toHaveBeenCalledWith({where:{status:NewsFeedItemStatus.ACTIVE}});
	});

	it('does not resync sources once active articles are available',async()=>{
		const response=await GET(request());

		expect(response.status).toBe(200);
		expect(mocks.syncAllEnabledNewsSources).not.toHaveBeenCalled();
	});
});
