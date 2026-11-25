'use client';

import {motion,useReducedMotion} from 'motion/react';
import type {ReactNode} from 'react';
import {aureviaMotion} from '@/lib/motion';

export function MotionSurface({children,className='',role}:{children:ReactNode;className?:string;role?:string}){
	const reduceMotion=useReducedMotion();
	return (
		<motion.div
			className={className}
			role={role}
			initial={reduceMotion?false:aureviaMotion.card.initial}
			animate={reduceMotion?undefined:aureviaMotion.card.animate}
			transition={{duration:aureviaMotion.duration.base,ease:aureviaMotion.ease}}
		>
			{children}
		</motion.div>
	);
}
