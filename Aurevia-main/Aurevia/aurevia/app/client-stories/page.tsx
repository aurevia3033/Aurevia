import Link from 'next/link';
import ClientStoryPortrait from '@/components/ClientStoryPortrait';
import Nav from '@/components/Nav';
import {getPublishedClientStories} from '@/lib/client-stories';
import {resolveClientStoryImage} from '@/lib/client-story-media';

export const dynamic='force-dynamic';

export default async function ClientStoriesPage(){
	const stories=await getPublishedClientStories();
	return <><Nav/><main className="account-page client-stories-page mx-auto max-w-6xl">
		<header className="account-heading client-stories-page-heading"><div className="client-stories-page-heading-copy">
			<div className="client-stories-page-eyebrow"><span className="account-kicker">CLIENT STORIES</span><span className="client-stories-count">{stories.length} {stories.length===1?'STORY':'STORIES'}</span></div>
			<h1>Experiences, shared by our clients</h1><p>Published with permission. Verification labels reflect the checks completed for each story.</p>
		</div></header>
		{stories.length?<div className="client-testimonials-grid">{stories.map(story=>{
			const image=story.imageUrl||resolveClientStoryImage(story.imageReference);
			return <article key={story.id} className="client-testimonial-card">
				<ClientStoryPortrait image={image} name={story.displayName}/>
				<div className="client-testimonial-person">
					<div className="client-testimonial-person-copy">
						<h2>{story.displayName}</h2>
						{(story.cityOrRegion||story.country)&&<p>{[story.cityOrRegion,story.country].filter(Boolean).join(', ')}</p>}
					</div>
					<span className={`client-testimonial-badge ${story.verifiedClientStory?'is-verified':''}`}>{story.verifiedClientStory?'Verified story':'Published testimonial'}</span>
				</div>
				<div className="client-testimonial-copy">
					{story.title&&<h3>{story.title}</h3>}
					{story.rating&&<p className="client-story-rating" aria-label={`Rated ${story.rating} out of 5`}>{'★'.repeat(story.rating)}<span className="sr-only">Rated {story.rating} out of 5</span></p>}
					<blockquote>{story.quote}</blockquote>
				</div>
				{story.withdrawalAmount&&<p className="client-testimonial-detail">Verified withdrawal · {Number(story.withdrawalAmount).toLocaleString()} {story.currency}</p>}
			</article>;
		})}</div>:<section className="account-panel card p-6"><h2 className="font-semibold">No stories approved for publication</h2><p className="mt-2 muted">Client stories are shown only after the required verification and consent checks.</p><Link className="mt-4 inline-flex min-h-11 items-center text-sm gold" href="/">Return to Aurevia Exchange</Link></section>}
	</main></>;
}
