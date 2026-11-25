'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowLeft,House} from 'lucide-react';

export default function NotFound(){
	const router=useRouter();
	return <main className="flex min-h-[70vh] items-center justify-center px-4 py-16">
		<section className="emerald-card w-full max-w-lg rounded-2xl border p-8 text-center" aria-labelledby="not-found-title">
			<div className="gold text-xs font-bold tracking-[.28em]">AUREVIA EXCHANGE</div>
			<h1 id="not-found-title" className="mt-3 text-5xl font-black">404</h1>
			<h2 className="mt-3 text-lg font-semibold">This destination is unavailable</h2>
			<p className="mx-auto mt-2 max-w-md text-sm muted">The page may have moved, or you may not have permission to view it.</p>
			<div className="mt-6 flex flex-wrap justify-center gap-2">
				<Link href="/" className="emerald-button btn inline-flex items-center gap-2 bg-gold text-black"><House size={16} aria-hidden="true"/>Return home</Link>
				<button type="button" className="emerald-button btn inline-flex items-center gap-2 bg-white/5" onClick={()=>router.back()}><ArrowLeft size={16} aria-hidden="true"/>Go back</button>
			</div>
		</section>
	</main>;
}
