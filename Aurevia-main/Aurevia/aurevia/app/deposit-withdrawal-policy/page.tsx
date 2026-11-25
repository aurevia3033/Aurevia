import InfoPage from '@/components/InfoPage';

export default function DepositWithdrawalPolicy(){
	return <InfoPage eyebrow="Account funding · Version 2026-11-15-v1" title="Deposits and withdrawals" lead="How funding requests and internal ledger records work in the current Aurevia application." updated="November 15, 2026" importantNote="A request in Aurevia is not proof of payment, custody, or external settlement. Do not send funds based only on a screen or message in this evaluation application." sections={[
		{title:'Funding requests',content:<p>REAL requests stay pending until administrator approval; approved credits post to Aurevia’s internal ledger. DEMO funds are simulated and have no cash value.</p>},
		{title:'Withdrawals',content:<p>Withdrawals depend on account restrictions, KYC, and administrator review; pending requests reserve ledger funds. Payout is manual, and an administrator records the reference and debit only after processing.</p>},
		{title:'Fees and records',content:<p>Applicable configured fees are shown in the request workflow before approval. The ledger records the requested amount, approved amount, fees, and resulting balance changes for authorized account and administrator review.</p>},
	]}/>;
}
