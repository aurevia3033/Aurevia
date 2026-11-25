import InfoPage from '@/components/InfoPage';

export default function PlatformUsagePolicy(){
	return <InfoPage eyebrow="Platform guidance · Version 2026-11-15-v1" title="Platform usage" lead="Important operating distinctions for Aurevia Exchange accounts." updated="November 15, 2026" importantNote="This page summarizes current product behavior. Review the Terms & Conditions and Risk Disclosure for the corresponding platform terms and risks." sections={[
		{title:'Account modes',content:<p>DEMO activity uses simulated funds and does not have cash value. REAL mode begins with a zero wallet balance and does not grant eligibility, identity approval, funding approval, or live brokerage access.</p>},
		{title:'Trading and market data',content:<p>Orders use simulated or sandbox execution, never live-market fills. Provider data availability and freshness are labeled in the interface.</p>},
		{title:'Account security',content:<p>Keep passwords and authentication devices private. Contact support about suspected access; never send passwords, one-time codes, or provider credentials.</p>},
	]}/>;
}
