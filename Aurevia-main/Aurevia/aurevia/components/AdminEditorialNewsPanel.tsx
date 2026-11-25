'use client';

import {type FormEvent,useCallback,useEffect,useState} from 'react';
import {Eye,EyeOff,Newspaper,Plus,RefreshCw} from 'lucide-react';
import NewsMediaPlayer from '@/components/NewsMediaPlayer';
import {broadcastMediaSource} from '@/lib/broadcast-policy';

type Category='ECONOMIC_NEWS'|'MARKET_NEWS'|'GENERAL'|'VIDEO';
type Post={id:string;title:string;summary:string|null;canonicalUrl:string;category:Category;publishedAt:string|null;status:'ACTIVE'|'HIDDEN';contentType:string};
type Draft={title:string;summary:string;url:string;category:Category};
const emptyDraft:Draft={title:'',summary:'',url:'',category:'GENERAL'};
const categoryLabels:Record<Category,string>={ECONOMIC_NEWS:'Economic news',MARKET_NEWS:'Market news',GENERAL:'General',VIDEO:'Video'};

export default function AdminEditorialNewsPanel(){
	const [posts,setPosts]=useState<Post[]>([]);
	const [draft,setDraft]=useState<Draft>(emptyDraft);
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [previewPostId,setPreviewPostId]=useState('');
	const draftMedia=broadcastMediaSource(draft.url.trim());

	const load=useCallback(async(showLoading=false)=>{
		if(showLoading)setLoading(true);
		try{
			const response=await fetch('/api/admin/news-feed/posts',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load editorial posts.');
			setPosts(result.posts as Post[]);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load editorial posts.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{void load(true)},[load]);

	async function createPost(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(busy)return;
		setBusy('create');setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/news-feed/posts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...draft,summary:draft.summary.trim()||null})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to publish this link.');
			setDraft(emptyDraft);setNotice('Link published to the selected news feed.');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to publish this link.')}
		finally{setBusy('')}
	}

	async function setStatus(post:Post,status:'ACTIVE'|'HIDDEN'){
		if(busy)return;
		setBusy(post.id);setError('');setNotice('');
		try{
			const response=await fetch('/api/admin/news-feed/posts',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({id:post.id,status})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update this post.');
			setNotice(status==='ACTIVE'?'Post is visible in the selected news feed.':'Post hidden from public feeds.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update this post.')}
		finally{setBusy('')}
	}

	return <div className="account-page">
		<header className="account-heading"><div><span className="account-kicker">WORKSPACE · NEWS & UPDATES</span><h1>Editorial links</h1><p>Publish external video, article, or other HTTPS links to the news feed shown on the News page and dashboard.</p></div><button type="button" className="icon-action" aria-label="Refresh posts" onClick={()=>void load(true)}><RefreshCw size={15}/></button></header>
		{error&&<div className="account-callout mb-3" role="alert">{error}</div>}{notice&&<p className="mb-3 text-sm text-profit" role="status">{notice}</p>}
		<section className="account-panel p-5"><div className="account-panel-title"><div><h2>Publish a link</h2><p className="account-panel-subtitle">YouTube, Vimeo, and direct MP4, WebM, OGG, or HLS links can play inline. Preview videos here before publishing; other HTTPS links appear as outbound cards.</p></div><Newspaper size={18} className="gold"/></div>
			<form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={event=>void createPost(event)}>
				<label className="account-label">Headline<input className="input" required minLength={3} maxLength={180} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
				<label className="account-label">Feed<select className="input" value={draft.category} onChange={event=>setDraft({...draft,category:event.target.value as Category})}>{Object.entries(categoryLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
				<label className="account-label sm:col-span-2">HTTPS link<input className="input" type="url" inputMode="url" required maxLength={2048} placeholder="https://…" value={draft.url} onChange={event=>setDraft({...draft,url:event.target.value})}/></label>
				{draft.url.trim()&&<div className="admin-news-media-preview sm:col-span-2">
					<strong>Playback check</strong>
					{draftMedia
						?<NewsMediaPlayer key={draft.url} kind={draftMedia.kind} url={draftMedia.url} title={draft.title||'News video preview'}/>
						:<p role="status">This HTTPS link will be published as an outbound link; it is not a supported inline video URL.</p>}
				</div>}
				<label className="account-label sm:col-span-2">Description (optional)<textarea className="input min-h-20" maxLength={2000} value={draft.summary} onChange={event=>setDraft({...draft,summary:event.target.value})}/></label>
				<div className="sm:col-span-2"><button className="btn bg-gold text-black" disabled={busy==='create'}>{busy==='create'?'Publishing…':<><Plus size={15}/> Publish link</>}</button></div>
			</form>
		</section>
		<section className="mt-5"><div className="account-panel-title mb-3"><div><h2>Published links</h2><p className="account-panel-subtitle">Hidden posts are removed from every public news-feed placement.</p></div></div>
			{loading&&!posts.length?<p className="account-empty" role="status">Loading posts…</p>:posts.length?<div className="divide-y divide-white/10 rounded-md border border-white/10">{posts.map(post=>{
				const media=broadcastMediaSource(post.canonicalUrl);
				return <article className="admin-news-post flex flex-wrap items-start justify-between gap-4 p-4" key={post.id}>
					<div className="min-w-0"><span className="account-kicker">{post.status} · {categoryLabels[post.category]}</span><h3 className="mt-1 text-lg font-semibold">{post.title}</h3>{post.summary&&<p className="mt-1 text-sm muted">{post.summary}</p>}<a className="mt-2 block break-all text-sm text-gold" href={post.canonicalUrl} target="_blank" rel="noopener noreferrer">{post.canonicalUrl}</a>
						{media&&<><button type="button" className="btn mt-3 min-h-10 bg-white/5" onClick={()=>setPreviewPostId(current=>current===post.id?'':post.id)}>{previewPostId===post.id?'Hide playback preview':'Test playback'}</button>{previewPostId===post.id&&<div className="admin-news-media-preview mt-3"><NewsMediaPlayer key={post.id} kind={media.kind} url={media.url} title={post.title}/></div>}</>}
					</div>
					<button type="button" className="btn min-h-11 bg-white/5" disabled={Boolean(busy)} onClick={()=>void setStatus(post,post.status==='ACTIVE'?'HIDDEN':'ACTIVE')}>{post.status==='ACTIVE'?<><EyeOff size={15}/> Hide</>:<><Eye size={15}/> Publish</>}</button>
				</article>;
			})}</div>:<p className="account-empty">No editorial links have been published.</p>}
		</section>
	</div>;
}
