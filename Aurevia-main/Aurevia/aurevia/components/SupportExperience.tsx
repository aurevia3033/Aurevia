'use client';

import {FormEvent,useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {Activity,Bot,ChevronDown,Clock3,LoaderCircle,Send,ShieldAlert,TicketCheck} from 'lucide-react';
import Nav from '@/components/Nav';

type NovaMarketData={symbol:string;provider:string|null;status:string;asOf:string|null;timeframe:string|null};
type ChatMessage={speaker:'user'|'nova';text:string;contextSafe?:boolean;marketData?:NovaMarketData};
type Conversation={id:string;subject:string;status:string;category:string;isComplaint:boolean;hasAttachment:boolean;createdAt:string;lastMessageAt:string;transaction?:{id:string;type:string;status:string;amount:string;currency:string}|null;messages:Array<{id:string;authorType:string;body:string;createdAt:string}>};
type Transaction={id:string;type:string;status:string;amount:string;currency:string};
type SupportContact={email:string;complaintsEmail:string;phone:string};
type DemoOrderDraft={instrumentId:string;symbol:string;side:'BUY'|'SELL';type:'MARKET';quantity:number;expectedPrice:number;observedAt:string;estimatedValue:number;accountMode:'DEMO';idempotencyKey:string};

function MessageBody({text}:{text:string}){
	const headings=new Set(['Market overview','Current verified conditions','Technical observations','Bullish scenario','Bearish scenario','Support and resistance','Risk considerations','Overall assessment']);
	return <div className="nova-message-body">{text.split('\n').map((line,index)=>{
		const trimmed=line.trim();
		if(!trimmed)return <span className="nova-line-break" key={index} aria-hidden="true"/>;
		if(headings.has(trimmed))return <h3 key={index}>{trimmed}</h3>;
		if(trimmed.startsWith('- '))return <p className="nova-bullet" key={index}>{trimmed.slice(2)}</p>;
		return <p key={index}>{line}</p>;
	})}</div>;
}

export default function SupportExperience(){
	const {data,status}=useSession();
	const mode=data?.user?.accountMode??null;
	const [messages,setMessages]=useState<ChatMessage[]>([{speaker:'nova',text:'Welcome to Aurevia AI — your intelligent companion for smarter financial decisions.\n\nExplore global markets, discover trading opportunities, understand market trends, and get expert guidance to navigate your financial journey with confidence.\n\nYour financial journey starts here. Let’s make every decision count.',contextSafe:true}]);
	const conversationId=useRef<string|undefined>(undefined);
	const [question,setQuestion]=useState('');
	const [conversations,setConversations]=useState<Conversation[]>([]);
	const [transactions,setTransactions]=useState<Transaction[]>([]);
	const [selectedConversation,setSelectedConversation]=useState('');
	const [showEscalation,setShowEscalation]=useState(false);
	const [isComplaint,setIsComplaint]=useState(false);
	const [complaintCategory,setComplaintCategory]=useState<'GENERAL'|'FUNDING'|'WITHDRAWAL'|'ACCOUNT'|'SECURITY'>('GENERAL');
	const [ticketAttachment,setTicketAttachment]=useState<File|null>(null);
	const [subject,setSubject]=useState('');
	const [ticketMessage,setTicketMessage]=useState('');
	const [transactionId,setTransactionId]=useState('');
	const [reply,setReply]=useState('');
	const [notice,setNotice]=useState('');
	const [error,setError]=useState('');
	const [historyError,setHistoryError]=useState('');
	const [historyLoading,setHistoryLoading]=useState(false);
	const [busy,setBusy]=useState(false);
	const [aiAssisted,setAiAssisted]=useState<boolean|null>(null);
	const [contact,setContact]=useState<SupportContact>({email:'',complaintsEmail:'',phone:''});
	const [orderDraft,setOrderDraft]=useState<DemoOrderDraft|null>(null);

	useEffect(()=>{let active=true;fetch('/api/support/contact').then(response=>response.ok?response.json():null).then(result=>{if(active&&result)setContact(result)}).catch(()=>{});return()=>{active=false}},[]);

	const load=useCallback(async(showLoading=false)=>{
		if(status!=='authenticated')return;
		if(showLoading){setHistoryLoading(true);setConversations([]);setTransactions([]);setSelectedConversation('');setReply('')}
		try{
			const [supportResponse,walletResponse]=await Promise.all([fetch('/api/support'),fetch('/api/wallet')]);
			const [supportData,walletData]=await Promise.all([supportResponse.json(),walletResponse.json()]);
			if(!supportResponse.ok||!walletResponse.ok)throw new Error('Unable to load account support history.');
			setConversations(supportData);setTransactions(walletData.transactions);setHistoryError('');
		}catch(exception){setHistoryError(exception instanceof Error?exception.message:'Unable to load account support history.')}
		finally{if(showLoading)setHistoryLoading(false)}
	},[status]);
	useEffect(()=>{void load(true)},[load,mode]);

	const selected=conversations.find(item=>item.id===selectedConversation);
	async function ask(event:FormEvent<HTMLFormElement>){event.preventDefault();const text=question.trim();if(!text||busy)return;conversationId.current??=crypto.randomUUID();setBusy(true);setError('');setAiAssisted(false);setOrderDraft(null);setQuestion('');const history=messages.filter(message=>message.speaker==='user'||message.contextSafe).slice(-10).map(message=>({role:message.speaker==='user'?'user' as const:'assistant' as const,content:message.text}));setMessages(current=>[...current,{speaker:'user',text}]);try{const response=await fetch('/api/support/nova',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:text,conversationId:conversationId.current,history})});const result=await response.json() as {answer:string;error?:string;aiAssisted?:boolean;contextSafe?:boolean;marketData?:NovaMarketData;orderDraft?:Omit<DemoOrderDraft,'idempotencyKey'>};if(!response.ok)throw new Error(result.error||'Nova is temporarily unavailable.');setAiAssisted(result.aiAssisted===true);setMessages(current=>[...current,{speaker:'nova',text:result.answer,contextSafe:result.contextSafe===true,marketData:result.marketData}]);setOrderDraft(result.orderDraft?{...result.orderDraft,idempotencyKey:crypto.randomUUID()}:null);}catch(exception){
		if(exception instanceof Error&&exception.message==='Support assistant unavailable.'){
			setMessages(current=>[...current,{speaker:'nova',text:'DEMO trades are practice activity; new REAL account orders use Aurevia Wallet funds and internal simulated execution, not external exchange routing. Wallet funding and withdrawal actions maintain Aurevia ledger records. This fallback does not send an external payment or payout.',contextSafe:true}]);
			setError('');
		}else{
			setError(exception instanceof Error?exception.message:'Nova is temporarily unavailable.');
		}
	}finally{setBusy(false)}}

	async function confirmDemoOrder(){
		if(!orderDraft||busy||mode!=='DEMO')return;
		setBusy(true);setError('');setNotice('');
		try{
			const response=await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':orderDraft.idempotencyKey},body:JSON.stringify({
				instrumentId:orderDraft.instrumentId,
				side:orderDraft.side,
				type:orderDraft.type,
				quantity:orderDraft.quantity,
				expectedPrice:orderDraft.expectedPrice,
				observedAt:orderDraft.observedAt,
			})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'The DEMO order could not be submitted.');
			setMessages(current=>[...current,{speaker:'nova',text:`Your explicitly confirmed DEMO order was accepted by the practice trading system. Recorded status: ${String(result.status||'unknown').replaceAll('_',' ').toLowerCase()}. Order reference: ${result.id}. This is not a REAL trade.`}]);
			setOrderDraft(null);
		}catch(exception){setError(exception instanceof Error?exception.message:'The DEMO order could not be submitted.');}
		finally{setBusy(false)}
	}

	async function escalate(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(status!=='authenticated'||busy)return;
		setBusy(true);setError('');setNotice('');
		try{
			const body=new FormData();body.append('action',isComplaint?'complaint':'ticket');body.append('category',complaintCategory);body.append('subject',subject);body.append('message',ticketMessage);if(transactionId)body.append('transactionId',transactionId);if(ticketAttachment)body.append('file',ticketAttachment);
			const response=await fetch('/api/support/ticket',{method:'POST',body});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to create support ticket.');
			const delivery=result.emailDelivery==='sent'?'Support email sent.':result.emailDelivery==='failed'?'Email delivery failed; the ticket is still available in the admin queue.':'Email is not configured; the ticket is still available in the admin queue.';
			setNotice(`${isComplaint?'Complaint':'Ticket'} ${result.id} created. ${delivery}`);setSubject('');setTicketMessage('');setTransactionId('');setTicketAttachment(null);setShowEscalation(false);setIsComplaint(false);await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to create support ticket.')}
		finally{setBusy(false)}
	}

	async function sendReply(event:FormEvent<HTMLFormElement>){
		event.preventDefault();if(!selected||!reply.trim()||busy)return;
		setBusy(true);setError('');
		try{
			const response=await fetch('/api/support',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reply',conversationId:selected.id,message:reply})});
			const result=await response.json();if(!response.ok)throw new Error(result.error||'Unable to send support message.');
			setReply('');await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to send support message.')}
		finally{setBusy(false)}
	}

	async function openAttachment(conversationId:string){
		try{const response=await fetch(`/api/support/${encodeURIComponent(conversationId)}/attachment`,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'Attachment unavailable.');window.open(result.url,'_blank','noopener,noreferrer')}
		catch(exception){setError(exception instanceof Error?exception.message:'Attachment unavailable.')}
	}

	return <><Nav/><main className="account-page support-page">
	<header className="account-heading"><div><span className="account-kicker">AUREVIA FINANCIAL INTELLIGENCE</span><h1>Nova AI</h1></div><span className={`status-pill ${mode==='DEMO'?'mode-demo':mode==='REAL'?'mode-real':''}`}>{status==='authenticated'?`${mode||'ACCOUNT'} ACCOUNT`:'PUBLIC MARKET HELP'}</span></header>
		<div className="account-content-grid support-layout">
		<section id="nova" className="account-panel card p-5"><div className="account-panel-title"><div><h2><Bot size={17} className="gold"/> Nova Financial Intelligence</h2><p className="account-panel-subtitle">{aiAssisted===null?'Specialist focus is selected automatically · account details remain session-scoped.':aiAssisted?'AI-generated explanation · verify facts against the cited provider or Aurevia records.':'Verified lookup or educational response · no AI-generated account action.'}</p></div><div className="flex flex-wrap gap-2"><button type="button" className="text-link" onClick={()=>{setIsComplaint(false);setShowEscalation(!showEscalation)}}><ShieldAlert size={15}/> Contact Admin</button><button type="button" className="text-link" onClick={()=>{setIsComplaint(true);setShowEscalation(true)}}>File complaint</button></div></div>
			<div className="nova-thread" aria-live="polite" aria-relevant="additions text">{messages.map((message,index)=><article className={`nova-message ${message.speaker==='user'?'is-user':''}`} key={`${message.speaker}-${index}`}><span>{message.speaker==='nova'?'NOVA':'YOU'}</span><MessageBody text={message.text}/>{message.marketData&&<small className={`nova-data-meta is-${message.marketData.status}`}><Activity size={12}/>{message.marketData.symbol} · {message.marketData.provider||'provider unavailable'} · {message.marketData.status.replaceAll('-',' ')}{message.marketData.timeframe?` · ${message.marketData.timeframe}`:''}{message.marketData.asOf&&<><Clock3 size={12}/> {new Date(message.marketData.asOf).toLocaleString()}</>}</small>}</article>)}{busy&&<div className="nova-message nova-loading" role="status"><span>NOVA</span><p><LoaderCircle size={14} className="nova-spinner"/> Checking context and verified sources…</p></div>}</div>
				{orderDraft&&<div className="account-callout mt-3" role="group" aria-label="DEMO order confirmation"><div><b>DEMO order preview</b><p className="mt-1 text-sm">{orderDraft.side} {orderDraft.quantity} {orderDraft.symbol} · MARKET · internal reference {orderDraft.expectedPrice} · estimated notional {orderDraft.estimatedValue}</p><p className="mt-1 text-xs muted">Sends only a DEMO order; the API rechecks the reference price. No REAL order is sent.</p></div><button className="btn bg-gold text-black" type="button" disabled={busy||mode!=='DEMO'} onClick={()=>void confirmDemoOrder()}>{busy?'Submitting…':'Confirm DEMO order'}</button><button className="btn bg-white/5" type="button" disabled={busy} onClick={()=>setOrderDraft(null)}>Cancel</button></div>}
			<div className="nova-suggestions" aria-label="Suggested questions">{['Analyze BTC on 1d','What does RSI mean?','How do I calculate trading risk?','Can DEMO profits be withdrawn?'].map(suggestion=><button type="button" key={suggestion} onClick={()=>setQuestion(suggestion)} disabled={busy}>{suggestion}</button>)}</div>
			<form onSubmit={ask} className="nova-input-row"><input className="input" value={question} maxLength={800} onChange={event=>setQuestion(event.target.value)} placeholder="Ask about markets, risk, or Aurevia" aria-label="Ask Nova AI"/><button className="btn bg-gold text-black" type="submit" aria-label="Send question" disabled={!question.trim()||busy}><Send size={15}/></button></form>
			<p className="mt-3 text-xs leading-5 muted">Market observations are time-stamped and sourced; live-versus-delayed status is stated only when a provider confirms it. Nova cannot approve payments, change balances, or submit REAL orders.</p>
				{showEscalation&&<form onSubmit={escalate} className="account-form-grid mt-5 border-t border-white/10 pt-5"><div className="md:col-span-2"><h3 className="text-sm font-semibold">{isComplaint?'File a complaint':'Escalate to Admin'}</h3><p className="mt-1 text-xs muted">Your authenticated user ID and active account mode are attached by the server.</p></div>{status==='authenticated'?<>
					<label className="account-label">Category<select className="input" value={complaintCategory} onChange={event=>setComplaintCategory(event.target.value as typeof complaintCategory)}><option value="GENERAL">General</option><option value="FUNDING">Funding</option><option value="WITHDRAWAL">Withdrawal</option><option value="ACCOUNT">Account</option><option value="SECURITY">Security</option></select></label>
					<label className="account-label">Subject<input className="input" required minLength={3} maxLength={120} value={subject} onChange={event=>setSubject(event.target.value)}/></label>
					<label className="account-label">Related transaction (optional)<select className="input" value={transactionId} onChange={event=>setTransactionId(event.target.value)}><option value="">No transaction selected</option>{transactions.map(transaction=><option key={transaction.id} value={transaction.id}>{transaction.type} · {transaction.id} · {transaction.status}</option>)}</select></label>
					<label className="account-label md:col-span-2">Message<textarea className="input min-h-24" required minLength={3} maxLength={4000} value={ticketMessage} onChange={event=>setTicketMessage(event.target.value)}/></label>
					<label className="account-label md:col-span-2">Attachment (optional)<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={event=>setTicketAttachment(event.target.files?.[0]||null)}/><small className="muted">Private PDF or image · maximum 5 MB</small></label>
					<div className="md:col-span-2"><button className="btn bg-gold text-black" disabled={busy}>{busy?'Sending…':'Create support ticket'}</button></div>
				</>:<p className="muted md:col-span-2">Sign in to create a ticket tied to your account. <Link className="gold" href="/login">Sign in</Link></p>}</form>}
				{notice&&<p className="mt-3 text-sm text-profit" role="status">{notice}</p>}{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
			</section>
			<aside className="account-panel card p-5"><div className="account-panel-title"><div><h2><TicketCheck size={17} className="gold"/> Your support tickets</h2><p className="account-panel-subtitle">Private to your account and selected mode</p></div></div>{status!=='authenticated'?<p className="account-empty">Sign in to view your support history.</p>:historyLoading?<p className="account-empty" role="status">Loading support tickets…</p>:historyError?<div className="account-empty transaction-history-error" role="alert"><span>{historyError}</span><button type="button" className="text-link" onClick={()=>void load(true)}>Retry</button></div>:conversations.length?<div className="support-ticket-list">{conversations.map(conversation=><article className="support-ticket" key={conversation.id}><button type="button" className="support-ticket-toggle" aria-expanded={selectedConversation===conversation.id} onClick={()=>setSelectedConversation(selectedConversation===conversation.id?'':conversation.id)}><span>{conversation.subject}</span><small>{conversation.isComplaint?'Complaint · ':''}{conversation.status.replaceAll('_',' ')} · {new Date(conversation.lastMessageAt||conversation.createdAt).toLocaleString()}</small>{conversation.transaction&&<small>Reference {conversation.transaction.id}</small>}<ChevronDown size={14}/></button>{selectedConversation===conversation.id&&<div className="support-message-list"><div className="support-message-history">{conversation.messages.map(item=><div key={item.id}><b>{item.authorType.replaceAll('_',' ')}</b><p>{item.body}</p></div>)}</div>{conversation.hasAttachment&&<button type="button" className="text-link" onClick={()=>void openAttachment(conversation.id)}>View private attachment</button>}{!['RESOLVED','CLOSED'].includes(conversation.status)&&<form onSubmit={sendReply} className="support-reply"><input className="input" value={reply} onChange={event=>setReply(event.target.value)} maxLength={4000} placeholder="Reply to support ticket" aria-label="Reply to support ticket"/><button className="btn bg-gold text-black" type="submit" disabled={busy||!reply.trim()} aria-label="Send reply"><Send size={14}/></button></form>}</div>}</article>)}</div>:<p className="account-empty">No support tickets yet.</p>}</aside>
			<section className="account-panel card p-5 support-contact-panel"><div className="account-panel-title"><div><h2>Contact support</h2></div><ShieldAlert size={18} className="gold"/></div>{contact.email?<a href={`mailto:${contact.email}`}>{contact.email}</a>:<p className="text-sm muted">Direct email is not configured. Authenticated support tickets remain available.</p>}{contact.complaintsEmail&&contact.complaintsEmail!==contact.email&&<a href={`mailto:${contact.complaintsEmail}`}>Complaints: {contact.complaintsEmail}</a>}{contact.phone&&<a href={`tel:${contact.phone.replaceAll(/[^+\d]/g,'')}`}>Call or text {contact.phone}</a>}<p className="text-xs muted">Nova cannot confirm or perform payments. Human review is available through support tickets.</p></section>
		</div>
	</main></>;
}