import InfoPage from '@/components/InfoPage';
import {getCurrentMandatoryTermsDocument} from '@/lib/managed-notice-policy';

export const dynamic='force-dynamic';

export default async function Terms(){
  const managedTerms=await getCurrentMandatoryTermsDocument();
  if(managedTerms?.version)return <InfoPage eyebrow={`Terms & Conditions · Version ${managedTerms.version}`} title={managedTerms.title} lead="Current published Terms & Conditions." updated={managedTerms.publishedAt?.toLocaleDateString()||managedTerms.updatedAt.toLocaleDateString()} importantNote="" sections={[
    {title:'Terms & Conditions',content:<p className="managed-policy-copy">{managedTerms.content}</p>},
  ]}/>;
  return <InfoPage eyebrow="Platform terms" title="Terms of use" lead="These product terms describe the current application and should be replaced with reviewed terms before a public production launch." updated="October 27, 2026" sections={[
    {title:'Platform modes',content:<p>Aurevia Exchange provides DEMO and REAL account interfaces. DEMO activity is for practice only. REAL-mode orders are funded from the Aurevia Wallet and simulated internally; they are not sent to an external exchange. Aurevia is not a live brokerage, exchange, bank, custodian, or payment service.</p>},
    {title:'Account access',content:<p>Users are responsible for protecting their login credentials and using the account features only for authorized purposes. Administrator-only functions are restricted to accounts assigned the administrator role.</p>},
    {title:'Market data, orders, and balances',content:<p>Market information and order-book views may use internal simulated prices or data from a provider as identified in the interface. DEMO orders use internal practice execution. REAL-mode orders use Aurevia's internal simulated execution and currency-specific wallet balances; no external exchange order is placed and wallet assets are not silently converted. Wallet balances and funding or withdrawal requests are maintained in Aurevia's internal ledger. A request is not confirmation of payment or settlement.</p>},
    {title:'Use and risk',content:<p>Do not use demo output as a live quote, investment recommendation, or representation of future performance. Investing and trading involve risk, including possible loss of capital. Platform content is not individualized advice.</p>},
    {title:'Production readiness',content:<p>Before accepting real customers or funds, the operator must obtain applicable legal and compliance review, configure actual support and privacy contacts, and connect approved providers and controls appropriate to its business and jurisdictions.</p>},
  ]} importantNote=""/>;
}