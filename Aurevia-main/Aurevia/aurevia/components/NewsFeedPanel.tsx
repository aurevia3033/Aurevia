'use client';

import {useCallback,useEffect,useState} from 'react';
import {ExternalLink,LoaderCircle,MonitorPlay,Newspaper,RefreshCw,Sparkles} from 'lucide-react';
import NewsMediaPlayer from '@/components/NewsMediaPlayer';
import NewsTVTestimonials from '@/components/NewsTVTestimonials';

type FeedItem={
	id:string;
	title:string;
	summary:string|null;
	canonicalUrl:string;
	publisher:string;
	category:string;
	publishedAt:string|null;
	thumbnailUrl:string|null;
	contentType:string;
	mediaSource:{kind:'video'|'embed';url:string}|null;
	source:{key:string;displayName:string;providerType:string};
};

type FeedResponse={
	items:FeedItem[];
	page:number;
	pageSize:number;
	total:number;
	hasMore:boolean;
	stale:boolean;
	lastSuccessAt:string|null;
	sources:Array<{key:string;displayName:string;category:string}>;
	error?:string;
};
type NewsAnalysis={
	overallSentiment:'positive'|'neutral'|'negative'|'mixed';
	summary:string;
	articles:Array<{id:string;sentiment:'positive'|'neutral'|'negative'|'mixed';observation:string}>;
	caveat:string;
};
type NewsArticleSource={id:string;title:string;canonicalUrl:string;publisher:string;publishedAt:string|null};

function formatWhen(value:string|null){
	if(!value)return '';
	try{
		return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
	}catch{return ''}
}

export default function NewsFeedPanel({compact=false}:{compact?:boolean}){
	const [data,setData]=useState<FeedResponse|null>(null);
	const [tvData,setTvData]=useState<FeedResponse|null>(null);
	const [loading,setLoading]=useState(true);
	const [tvLoading,setTvLoading]=useState(true);
	const [error,setError]=useState('');
	const [tvError,setTvError]=useState('');
	const [category,setCategory]=useState('');
	const [page,setPage]=useState(1);
	const [selectedMediaId,setSelectedMediaId]=useState<string|null>(null);
	const [analysis,setAnalysis]=useState<NewsAnalysis|null>(null);
	const [analysisSources,setAnalysisSources]=useState<NewsArticleSource[]>([]);
	const [analysisIsStale,setAnalysisIsStale]=useState(false);
	const [analysisError,setAnalysisError]=useState('');
	const [analysisBusy,setAnalysisBusy]=useState(false);
	const [tvRetry,setTvRetry]=useState(0);

	const load=useCallback(async(nextPage=1,append=false)=>{
		setLoading(true);
		if(!append)setError('');
		try{
			const params=new URLSearchParams({page:String(nextPage),pageSize:compact?'6':'12'});
			if(category)params.set('category',category);
			const response=await fetch(`/api/news-feed?${params}`,{cache:'no-store'});
			const result=await response.json() as FeedResponse;
			if(!response.ok)throw new Error(result.error||'Unable to load news feed.');
			setData(current=>{
				if(append&&current){
					return {...result,items:[...current.items,...result.items]};
				}
				return result;
			});
			setPage(nextPage);
		}catch(exception){
			setError(exception instanceof Error?exception.message:'Unable to load news feed.');
		}finally{
			setLoading(false);
		}
	},[category,compact]);

	async function analyzeNews(){
		setAnalysisBusy(true);setAnalysisError('');setAnalysis(null);setAnalysisSources([]);setAnalysisIsStale(false);
		try{
			const response=await fetch('/api/news-feed/analysis',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'News analysis is unavailable.');
			setAnalysis(result.analysis as NewsAnalysis);
			setAnalysisSources(Array.isArray(result.articleSources)?result.articleSources as NewsArticleSource[]:[]);
			setAnalysisIsStale(result.sourceDataStale===true);
		}catch(exception){
			setAnalysisError(exception instanceof Error?exception.message:'News analysis is unavailable.');
		}finally{setAnalysisBusy(false)}
	}

	useEffect(()=>{void load(1,false)},[load]);

	useEffect(()=>{
		let active=true;
		const controller=new AbortController();
		setTvLoading(true);
		setTvError('');
		void (async()=>{
			const mediaItems:FeedItem[]=[];
			let page=1;
			let hasMore=true;
			while(hasMore){
				const response=await fetch(`/api/news-feed?page=${page}&pageSize=30&mediaOnly=true`,{cache:'no-store',signal:controller.signal});
				const result=await response.json() as FeedResponse;
				if(!response.ok)throw new Error(result.error||'Unable to load TV programmes.');
				mediaItems.push(...result.items.filter(item=>item.mediaSource));
				if(active)setTvData({...result,items:[...mediaItems],total:mediaItems.length,hasMore:false});
				hasMore=result.hasMore;
				page++;
			}
		})().catch(exception=>{
			if(active&&!controller.signal.aborted)setTvError(exception instanceof Error?exception.message:'Unable to load TV programmes.');
		}).finally(()=>{if(active)setTvLoading(false)});
		return()=>{active=false;controller.abort()};
	},[tvRetry]);

	useEffect(()=>{
		const timer=window.setInterval(()=>void load(1,false),60_000);
		return ()=>window.clearInterval(timer);
	},[load]);

	const mediaItems=tvData?.items.filter((item):item is FeedItem&{mediaSource:{kind:'video'|'embed';url:string}}=>Boolean(item.mediaSource))||[];
	const featuredItem=mediaItems.find(item=>item.id===selectedMediaId)||mediaItems[0]||null;

	return (
		<section className={`news-feed-panel ${compact?'is-compact':''}`} aria-label="External news and updates">
			<header className="news-feed-header">
				<div>
					<p className="eyebrow">NEWS & UPDATES</p>
					<h2 className="news-feed-title"><Newspaper size={20} aria-hidden="true"/> News & updates</h2>
				</div>
				<div className="news-feed-tools">
					{!compact&&<button type="button" className="btn bg-white/5" onClick={()=>void analyzeNews()} disabled={analysisBusy}><Sparkles size={14}/>{analysisBusy?'Analyzing…':'Analyze sentiment'}</button>}
					<label className="sr-only" htmlFor="news-category">Category</label>
					<select id="news-category" className="input news-feed-select" value={category} onChange={event=>{setCategory(event.target.value);}}>
						<option value="">All categories</option>
						<option value="ECONOMIC_NEWS">Economic news</option>
						<option value="MARKET_NEWS">Market news</option>
						<option value="GENERAL">General</option>
						<option value="VIDEO">Video</option>
					</select>
					<button type="button" className="btn bg-white/5" onClick={()=>void load(1,false)} disabled={loading} aria-label="Refresh news">
						{loading?<LoaderCircle size={14} className="animate-spin"/>:<RefreshCw size={14}/>}
					</button>
				</div>
			</header>

			{analysisError&&<p className="news-feed-state is-error" role="alert">{analysisError}</p>}
			{analysis&&<section className="account-callout mb-4" aria-label="AI news sentiment analysis" aria-live="polite">
				<strong>Generated news sentiment · {analysis.overallSentiment}</strong>
				<p>{analysis.summary}</p>
				{analysis.articles.length>0&&<ul>{analysis.articles.map(article=>{
					const source=analysisSources.find(item=>item.id===article.id);
					return <li key={article.id}>{source?<a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer">{source.publisher}: {source.title}</a>:null} · {article.sentiment}: {article.observation}</li>;
				})}</ul>}
				<p>{analysis.caveat} Sentiment is article framing, not a market signal or recommendation.</p>
				{analysisIsStale&&<p role="status">One or more analyzed news sources may be stale; check the original publisher links.</p>}
			</section>}

			{data?.stale&&<p className="news-feed-banner" role="status">Source data may be outdated. Last successful sync: {formatWhen(data.lastSuccessAt)||'unknown'}.</p>}
			{loading&&!data&&<p className="news-feed-state" role="status">Loading external headlines…</p>}
			{error&&<p className="news-feed-state is-error" role="alert">{error} <button type="button" className="text-link" onClick={()=>void load(1,false)}>Retry</button></p>}
			{!loading&&!error&&data&&data.items.length===0&&(
				<p className="news-feed-state" role="status">No external articles are available yet. The news feed will retry automatically; refresh shortly.</p>
			)}

			<section className="news-tv" aria-label="Aurevia TV">
				<header className="news-tv-header">
					<div className="news-tv-brand">
						<span className="news-tv-icon"><MonitorPlay size={20} aria-hidden="true"/></span>
						<div><p>THE AUREVIA NETWORK</p><h2>Aurevia TV</h2></div>
					</div>
					<span className="news-tv-badge"><span aria-hidden="true"/> {featuredItem?'WATCH IN PLATFORM':'NETWORK STATUS'}</span>
				</header>
				{featuredItem?(
					<div className="news-tv-grid">
						<div className="news-tv-screen">
							<NewsMediaPlayer key={featuredItem.id} kind={featuredItem.mediaSource.kind} url={featuredItem.mediaSource.url} title={featuredItem.title}/>
						</div>
						<aside className="news-tv-details">
							<p className="news-tv-eyebrow">NOW SHOWING · EPISODE {String(mediaItems.findIndex(item=>item.id===featuredItem.id)+1).padStart(2,'0')}</p>
							<h3>{featuredItem.title}</h3>
							{featuredItem.summary&&<p className="news-tv-summary">{featuredItem.summary}</p>}
							<div className="news-tv-meta">
								<span>{featuredItem.source.displayName}</span>
								<span>{featuredItem.category.replaceAll('_',' ')}</span>
								{featuredItem.publishedAt&&<time dateTime={featuredItem.publishedAt}>{formatWhen(featuredItem.publishedAt)}</time>}
							</div>
							<a className="news-tv-source-link" href={featuredItem.canonicalUrl} target="_blank" rel="noopener noreferrer">
								View original story <ExternalLink size={13} aria-hidden="true"/>
							</a>
							<div className="news-tv-lineup">
								<div className="news-tv-lineup-heading"><span>ON DEMAND</span><span>{mediaItems.length} {mediaItems.length===1?'PROGRAM':'PROGRAMS'}</span></div>
								{mediaItems.map((item,index)=>(
									<button key={item.id} type="button" className={`news-tv-episode${item.id===featuredItem.id?' is-selected':''}`} aria-pressed={item.id===featuredItem.id} onClick={()=>setSelectedMediaId(item.id)}>
										<span className="news-tv-episode-number">{String(index+1).padStart(2,'0')}</span>
										<span className="news-tv-episode-copy"><strong>{item.title}</strong><small>{item.source.displayName}</small></span>
										<MonitorPlay size={16} aria-hidden="true"/>
									</button>
								))}
							</div>
						</aside>
					</div>
				):(
					<div className="news-tv-grid">
						<div className="news-tv-screen">
							{tvError?<div className="news-tv-empty" role="alert"><MonitorPlay size={24}/><strong>TV schedule is unavailable</strong><p>{tvError}</p><button type="button" className="btn bg-white/10" onClick={()=>setTvRetry(value=>value+1)}>Retry TV schedule</button></div>:tvLoading?<p className="news-feed-state" role="status">Loading TV programmes…</p>:<NewsTVTestimonials/>}
						</div>
						<aside className="news-tv-details"><p className="news-tv-eyebrow">AUREVIA NETWORK</p><h3>Client stories, market briefings and updates</h3><p className="news-tv-summary">Aurevia TV plays published news videos when available and rotates approved client testimonies when no video programme is on the schedule.</p><div className="news-tv-meta"><span>{tvLoading?'Loading programmes…':`${mediaItems.length} playable programmes`}</span><span>{data?.sources.length||0} configured sources</span></div><a className="news-tv-source-link" href="/client-stories">View all client testimonies <ExternalLink size={13} aria-hidden="true"/></a></aside>
					</div>
				)}
			</section>

			{data&&data.items.length>0&&(
				<ul className="news-feed-list">
					{data.items.filter(item=>!item.mediaSource).map(item=>(
						<li key={item.id} className="news-feed-item card">
							<div className="news-feed-item-body">
								<div className="news-feed-meta">
									<span className="news-feed-source">{item.source.displayName}</span>
									<span className="news-feed-category">{item.category.replaceAll('_',' ').toLowerCase()}</span>
									{item.publishedAt&&<time dateTime={item.publishedAt}>{formatWhen(item.publishedAt)}</time>}
								</div>
								<a className="news-feed-item-title" href={item.canonicalUrl} target="_blank" rel="noopener noreferrer">
									{item.title} <ExternalLink size={14} aria-hidden="true"/>
								</a>
								{item.summary&&<p className="news-feed-summary">{item.summary}</p>}
								<span className="news-feed-publisher muted text-xs">{item.publisher} · {item.category.replaceAll('_',' ').toLowerCase()}</span>
							</div>
						</li>
					))}
				</ul>
			)}

			{data?.hasMore&&(
				<div className="news-feed-more">
					<button type="button" className="btn bg-white/10" disabled={loading} onClick={()=>void load(page+1,true)}>
						{loading?'Loading…':'Load more'}
					</button>
				</div>
			)}
		</section>
	);
}
