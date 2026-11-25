import InfoPage from '@/components/InfoPage';

export default function AmlKycPolicy(){
	return <InfoPage eyebrow="Account verification · Version 2026-11-15-v1" title="Identity and account review" lead="How Aurevia currently handles identity-verification workflows." updated="November 15, 2026" importantNote="This is a product-process summary, not legal or compliance advice. It does not claim that Aurevia performs automated AML, sanctions, or regulatory screening." sections={[
		{title:'Identity verification',content:<p>REAL users may submit identity details and private documents; file checks do not prove identity, so an administrator must review and decide. Submission or REAL mode does not approve an account.</p>},
		{title:'Account review',content:<p>Identity and address documents stay in private storage; reviews and decisions appear in account history. Do not submit documents in evaluation.</p>},
		{title:'Service limitations',content:<p>OCR, authenticity, face, duplicate-identity, and liveness checks are unavailable. Manual review is not AML or sanctions screening and does not discharge local obligations.</p>},
	]}/>;
}
