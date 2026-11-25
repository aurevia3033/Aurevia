'use client';

import {motion,useReducedMotion} from 'motion/react';
import type {ReactNode} from 'react';
import {aureviaMotion} from '@/lib/motion';

export default function Template({children}:{children:ReactNode}){
	const reduceMotion=useReducedMotion();
	return <motion.div
		initial={reduceMotion?false:aureviaMotion.card.initial}
		animate={reduceMotion?undefined:aureviaMotion.card.animate}
		transition={{duration:aureviaMotion.duration.base,ease:aureviaMotion.ease}}
		className="aurevia-route-template"
	>
		{children}
	</motion.div>;
}
