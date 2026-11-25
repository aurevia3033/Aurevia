'use client';

import {Check,Moon,Sun} from 'lucide-react';
import {useTheme} from '@/lib/theme-context';

export default function ThemeToggle(){
	const {theme,selectTheme,error}=useTheme();
	return <div className="theme-toggle" role="group" aria-label="Color theme">
		<button type="button" className="theme-toggle-option" aria-pressed={theme==='forest-green'} onClick={()=>void selectTheme('forest-green')}>
			<Moon size={14} aria-hidden="true"/><span>Forest Green</span>{theme==='forest-green'&&<Check size={14} aria-hidden="true"/>}
		</button>
		<button type="button" className="theme-toggle-option" aria-pressed={theme==='premium-dashboard'} onClick={()=>void selectTheme('premium-dashboard')}>
			<Sun size={14} aria-hidden="true"/><span>Premium Dashboard</span>{theme==='premium-dashboard'&&<Check size={14} aria-hidden="true"/>}
		</button>
		{error&&<span className="theme-toggle-error" role="alert">{error}</span>}
	</div>;
}
