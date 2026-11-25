import {NextResponse} from 'next/server';
import {NewsFeedCategory,NewsFeedItemStatus,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {jsonSafe} from '@/lib/serializers';
import {editorialMediaSource} from '@/lib/news-feed/editorial';
import {syncAllEnabledNewsSources} from '@/lib/news-feed/sync';

export const dynamic='force-dynamic';
export const maxDuration=60;

const pageSizeMax=30;

export async function GET(request:Request){
	try{
		const {searchParams}=new URL(request.url);
		const page=Math.max(1,Number(searchParams.get('page')||'1')||1);
		const pageSize=Math.min(pageSizeMax,Math.max(1,Number(searchParams.get('pageSize')||'12')||12));
		const category=searchParams.get('category');
		const sourceKey=searchParams.get('source');
		const mediaOnly=searchParams.get('mediaOnly')==='true';
		const where:Prisma.NewsFeedItemWhereInput={
			status:NewsFeedItemStatus.ACTIVE,
			...(mediaOnly?{contentType:'editorial-link'}:{}),
			...(category&&Object.values(NewsFeedCategory).includes(category as NewsFeedCategory)?{category:category as NewsFeedCategory}:{}),
			...(sourceKey?{source:{key:sourceKey}}:{}),
		};
		const activeItems=await db.newsFeedItem.count({where:{status:NewsFeedItemStatus.ACTIVE}});
		if(activeItems===0)await syncAllEnabledNewsSources();
		const [total,items,sources]=await Promise.all([
			db.newsFeedItem.count({where}),
			db.newsFeedItem.findMany({
				where,
				include:{source:{select:{key:true,displayName:true,providerType:true,lastSuccessAt:true,lastError:true}}},
				orderBy:[{publishedAt:'desc'},{importedAt:'desc'}],
				skip:(page-1)*pageSize,
				take:pageSize,
			}),
			db.newsFeedSource.findMany({where:{enabled:true},select:{key:true,displayName:true,category:true,lastSuccessAt:true,lastError:true,providerType:true},orderBy:{displayName:'asc'}}),
		]);
		const newestSuccess=sources.reduce((latest,source)=>{
			if(!source.lastSuccessAt)return latest;
			if(!latest||source.lastSuccessAt>latest)return source.lastSuccessAt;
			return latest;
		},null as Date|null);
		const stale=Boolean(newestSuccess&&Date.now()-newestSuccess.getTime()>45*60_000);
		return NextResponse.json(jsonSafe({
			items:items.map(item=>({
				id:item.id,
				title:item.title,
				summary:item.summary,
				canonicalUrl:item.canonicalUrl,
				publisher:item.publisher||item.source.displayName,
				author:item.author,
				category:item.category,
				contentType:item.contentType,
				publishedAt:item.publishedAt,
				thumbnailUrl:item.thumbnailUrl,
				mediaSource:item.contentType==='editorial-link'?editorialMediaSource(item.canonicalUrl):null,
				source:{key:item.source.key,displayName:item.source.displayName,providerType:item.source.providerType},
			})),
			page,
			pageSize,
			total,
			hasMore:page*pageSize<total,
			sources,
			stale,
			lastSuccessAt:newestSuccess,
		}),{headers:{'Cache-Control':'public, max-age=30'}});
	}catch(error){
		console.error('news-feed read failed',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'News feed is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
