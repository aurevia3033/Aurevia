'use client';

import Image from 'next/image';
import {useState} from 'react';

export default function ClientStoryPortrait({image,name}:{image:string|null;name:string}){
	const [unavailable,setUnavailable]=useState(false);
	return <div className={`client-testimonial-photo${image&&!unavailable?' has-image':''}`}>
		{image&&!unavailable
			?<Image src={image} alt={`Portrait for ${name}`} fill sizes="(max-width: 600px) 96px, (max-width: 900px) 140px, 180px" unoptimized className="client-testimonial-portrait" onError={()=>setUnavailable(true)}/>
			:<span className="client-story-monogram" aria-label={`Initial for ${name}`}>{name.trim().charAt(0).toUpperCase()||'?'}</span>}
	</div>;
}
