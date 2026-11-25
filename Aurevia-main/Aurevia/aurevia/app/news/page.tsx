'use client';

import Link from 'next/link';
import Nav from '@/components/Nav';
import NewsFeedPanel from '@/components/NewsFeedPanel';
import PublicResourceLinks from '@/components/PublicResourceLinks';
import {ArrowUpRight,MonitorPlay,ShieldCheck} from 'lucide-react';

export default function NewsPage(){
	return <>
		<Nav/>
		<main className="account-page news-editorial-page">
			<header className="news-editorial-heading">
				<div><span className="account-kicker">AUREVIA · MARKET BRIEFING</span><h1>Aurevia TV &amp; News</h1></div>
				<div className="news-editorial-mark" aria-hidden="true"><MonitorPlay size={26}/><span>AUREVIA<br/>TV</span></div>
			</header>
			<div className="news-editorial-note"><ShieldCheck size={16}/><p>Articles link to their original publishers. News, summaries, and sentiment analysis are informational only—not verified facts, market signals, or investment recommendations.</p><Link href="/risk-disclosure">Risk disclosure <ArrowUpRight size={13}/></Link></div>
			<NewsFeedPanel/>
			<PublicResourceLinks placement="NEWS_UPDATES"/>
		</main>
	</>;
}
