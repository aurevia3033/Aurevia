import InfoPage from '@/components/InfoPage';

export default function About(){
  return <InfoPage eyebrow="About the platform" title="A considered space to explore markets" lead="Aurevia Exchange brings account, market, and trading workflows together, distinguishing internal records, DEMO practice, and sandbox order routing." updated="October 27, 2026" sections={[
    {title:'Platform overview',content:<p>Market, wallet, and account tools share one workspace. DEMO is practice; REAL orders use wallet funds with Aurevia’s internal simulator, not an external exchange.</p>},
    {title:'Designed for clarity',content:<p>Portfolio and activity reflect the selected account. Market sources are labeled; internal balances remain separate from provider-reported sandbox values.</p>},
    {title:'Execution environment',content:<p>Aurevia is not a bank, custodian, live exchange, or investment adviser and does not provide personalized advice. Sandbox activity is not a live investment or withdrawable cash.</p>},
  ]}/>;
}