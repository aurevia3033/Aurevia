import {HTMLAttributes} from 'react';import {cn} from '@/lib/utils';
export function Card({className,...p}:HTMLAttributes<HTMLDivElement>){return <div className={cn('emerald-card rounded-2xl border border-white/10',className)} {...p}/>}
export function CardContent({className,...p}:HTMLAttributes<HTMLDivElement>){return <div className={cn('p-5',className)} {...p}/>}
