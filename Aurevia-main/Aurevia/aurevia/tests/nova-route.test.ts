import {AccountMode,Prisma} from '@prisma/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	session:vi.fn(),
	userFindUnique:vi.fn(),
	ledgerFindUnique:vi.fn(),
	fundingFindMany:vi.fn(),
	newsFindMany:vi.fn(),
	auditCreate:vi.fn(),
	balance:vi.fn(),
	reservedWithdrawalAmount:vi.fn(),
	quote:vi.fn(),
	history:vi.fn(),
	openAiChat:vi.fn(),
	rateLimit:vi.fn(),
}));

vi.mock('next-auth',()=>({getServerSession:mocks.session}));
vi.mock('@/lib/auth-options',()=>({authOptions:{}}));
vi.mock('@/lib/auth',()=>({assertCurrentTermsAccepted:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	ledgerAccount:{findUnique:mocks.ledgerFindUnique},
	fundingRequest:{findMany:mocks.fundingFindMany},
	newsFeedItem:{findMany:mocks.newsFindMany},
	auditLog:{create:mocks.auditCreate},
}}));
vi.mock('@/lib/ledger',()=>({balance:mocks.balance,reservedWithdrawalAmount:mocks.reservedWithdrawalAmount}));
vi.mock('@/lib/production-policy',()=>({getAccountTier:vi.fn(()=>({label:'Tier 1'})),getTierProfileRequirements:vi.fn(()=>({profileComplete:true}))}));
vi.mock('@/lib/live-market',()=>({
	MARKET_ASSETS:[
		{id:'BTC',ticker:'BTC-USD',name:'Bitcoin USD',type:'CRYPTO',currency:'USD'},
		{id:'AAPL',ticker:'AAPL',name:'Apple Inc.',type:'STOCK',currency:'USD'},
	],
	isExternalMarketDataSource:(source:string)=>source==='Twelve Data',
}));
vi.mock('@/lib/market-data-service',()=>({
	getAdditionalMarketProviderKeys:vi.fn(()=>({})),
	getMarketQuoteWithFallback:mocks.quote,
	getMarketHistoryWithFallback:mocks.history,
}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({marketData:{twelveDataApiKey:'test'},execution:{}})}));
vi.mock('@/lib/config',()=>({getSupportContact:()=>({email:'support@example.test'})}));
vi.mock('@/lib/openai-client',()=>({NOVA_SYSTEM_PROMPT:'Nova system prompt',openAiChat:mocks.openAiChat}));
vi.mock('@/lib/display-copy',()=>({removeSimulatedLabels:(value:string)=>value}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));

import {POST} from '@/app/api/support/nova/route';

const candles=Array.from({length:60},(_,index)=>{
	const close=100+index;
	return {time:Math.floor(Date.now()/1000)-((59-index)*86_400),open:close-0.5,high:close+2,low:close-2,close,volume:1000+index};
});

function request(question:string,history?:Array<{role:'user'|'assistant';content:string}>){
	return new Request('https://aurevia.test/api/support/nova',{
		method:'POST',
		headers:{'content-type':'application/json'},
		body:JSON.stringify({question,history}),
	});
}

async function ask(question:string,history?:Array<{role:'user'|'assistant';content:string}>){
	const response=await POST(request(question,history));
	return {response,body:await response.json()};
}

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({user:{id:'user-1'}});
	mocks.userFindUnique.mockResolvedValue({
		id:'user-1',role:'USER',status:'ACTIVE',accountMode:AccountMode.DEMO,approvedTier:1,kycStatus:'PENDING',
		name:'Private Name',country:'US',phone:'5551234567',phoneVerified:false,kycVerifications:[],kycDocuments:[],
	});
	mocks.ledgerFindUnique.mockResolvedValue({id:'own-ledger'});
	mocks.fundingFindMany.mockResolvedValue([]);
	mocks.newsFindMany.mockResolvedValue([{
		title:'Federal Reserve releases policy statement',
		summary:'The statement describes the committee decision.',
		publisher:'Federal Reserve',
		canonicalUrl:'https://example.test/statement',
		category:'ECONOMIC_NEWS',
		publishedAt:new Date('2026-11-18T12:00:00.000Z'),
		source:{displayName:'Federal Reserve',lastSuccessAt:new Date('2026-11-18T12:15:00.000Z')},
	}]);
	mocks.auditCreate.mockResolvedValue({});
	mocks.balance.mockResolvedValue(new Prisma.Decimal('1200'));
	mocks.reservedWithdrawalAmount.mockResolvedValue(new Prisma.Decimal('100'));
	mocks.quote.mockResolvedValue({
		price:68_000,change:1_000,changePercent:1.5,updatedAt:new Date().toISOString(),
		source:'Twelve Data',isStale:false,asset:{id:'BTC',name:'Bitcoin USD',currency:'USD'},
	});
	mocks.history.mockResolvedValue({source:'Twelve Data',candles});
	mocks.openAiChat.mockResolvedValue(null);
});

afterEach(()=>vi.restoreAllMocks());

describe('Nova financial and platform intelligence',()=>{
	it('uses provider quotes and external candles for a BTC market analysis',async()=>{
		const {response,body}=await ask('Analyze BTC market on 1d');

		expect(response.status).toBe(200);
		expect(body.answer).toContain('Market overview');
		expect(body.answer).toContain('Twelve Data');
		expect(body.answer).toContain('RSI(14)');
		expect(body.answer).toContain('Bullish scenario');
		expect(body.marketData).toMatchObject({symbol:'BTC',provider:'Twelve Data',status:'provider-timestamped',timeframe:'1d'});
		expect(mocks.history).toHaveBeenCalledOnce();
	});

	it('explains RSI without inventing a live reading',async()=>{
		const {body}=await ask('What does RSI mean?');
		expect(body.answer).toContain('Relative Strength Index');
		expect(body.answer).toContain('not automatic reversal signals');
		expect(mocks.quote).not.toHaveBeenCalled();
	});

	it('explains MACD with its conventional EMA periods and caveats',async()=>{
		const {body}=await ask('Can you explain MACD?');
		expect(body.answer).toContain('12-period EMA');
		expect(body.answer).toContain('9-period EMA');
		expect(body.answer).toContain('false signals');
	});

	it('asks for timeframe before characterizing a stock as bullish or bearish',async()=>{
		const {body}=await ask('Is AAPL bullish or bearish?');
		expect(body.answer).toContain('Which timeframe should I use');
		expect(body.answer).toContain('have not inferred a bullish or bearish outlook');
		expect(body.marketData).toMatchObject({symbol:'AAPL',status:'provider-timestamped'});
		expect(mocks.history).not.toHaveBeenCalled();
	});

	it('answers economic-announcement questions only from publisher-sourced articles',async()=>{
		const {body}=await ask('What is the latest economic announcement?');
		expect(body.answer).toContain('Federal Reserve releases policy statement');
		expect(body.answer).toContain('Federal Reserve');
		expect(body.answer).toContain('2026-11-18T12:00:00.000Z');
		expect(body.answer).toContain('does not currently connect an economic-calendar endpoint');
	});

	it('explains trading risk with a position-size example and execution caveat',async()=>{
		const {body}=await ask('How do I calculate trading risk?');
		expect(body.answer).toContain('account equity × chosen risk percentage');
		expect(body.answer).toContain('20 units');
		expect(body.answer).toContain('Stops can slip or gap');
	});

	it('reads only the authenticated user’s authoritative wallet ledger',async()=>{
		const {body}=await ask('What is my wallet balance?');
		expect(body.answer).toContain('DEMO USD ledger balance: 1200 USD');
		expect(body.answer).toContain('leaving 1200 USD available');
		expect(mocks.ledgerFindUnique).toHaveBeenCalledWith({where:{code:'USER:user-1:DEMO:USD'},select:{id:true}});
		expect(body.answer).not.toContain('Private Name');
	});

	it('reports a pending withdrawal from the authenticated REAL account record',async()=>{
		mocks.userFindUnique.mockResolvedValueOnce({
			id:'user-1',role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,approvedTier:1,kycStatus:'PENDING',
			kycVerifications:[],kycDocuments:[],
		});
		mocks.fundingFindMany.mockResolvedValueOnce([{
			type:'WITHDRAWAL',status:'PENDING',amount:new Prisma.Decimal('25'),currency:'USD',
		}]);
		const {body}=await ask('What is the status of my pending withdrawal?');
		expect(body.answer).toContain('withdrawal 25 USD · pending');
		expect(mocks.fundingFindMany).toHaveBeenCalledOnce();
	});

	it('keeps DEMO profits separate from withdrawable REAL wallet funds',async()=>{
		const {body}=await ask('Can DEMO profits be withdrawn?');
		expect(body.answer).toContain('cannot be transferred to a REAL wallet');
		expect(body.answer).toContain('never credits withdrawable REAL funds');
		expect(mocks.ledgerFindUnique).not.toHaveBeenCalled();
	});

	it('refuses guaranteed-return claims',async()=>{
		const {body}=await ask('Can you guarantee an investment return?');
		expect(body.answer).toContain('No investment return or profit is guaranteed');
		expect(mocks.openAiChat).not.toHaveBeenCalled();
	});

	it('does not imply returns are guaranteed when the question reverses the word order',async()=>{
		const {body}=await ask('Are investment returns guaranteed?');
		expect(body.answer).toContain('No investment return or profit is guaranteed');
	});

	it('does not invent company fundamentals when no verified fundamentals provider exists',async()=>{
		const {body}=await ask('Give me AAPL fundamental valuation and earnings analysis.');
		expect(body.answer).toContain('verified company-fundamentals or valuation feed connected');
		expect(body.answer).toContain('will not invent financial-statement, earnings, or P/E figures');
		expect(mocks.quote).not.toHaveBeenCalled();
	});

	it('labels internal fallback candles unavailable for AI technical analysis',async()=>{
		mocks.history.mockResolvedValueOnce({source:'Aurevia Internal',candles});
		const {body}=await ask('Analyze BTC on 1d');
		expect(body.answer).toContain('no verified external historical candles');
		expect(body.answer).not.toContain('RSI(14)');
		expect(body.marketData.status).toBe('unavailable');
	});

	it('discloses that Aurevia orders use internal simulated execution',async()=>{
		const {body}=await ask('Are Aurevia orders live exchange trades?');
		expect(body.answer).toContain('wallet-funded simulated execution');
		expect(body.answer).toContain('does not route orders to an external broker or exchange');
	});

	it('does not turn a provider outage into a fabricated BTC price',async()=>{
		mocks.quote.mockRejectedValueOnce(new Error('provider unavailable'));
		const {response,body}=await ask('What is the BTC price?');
		expect(response.status).toBe(200);
		expect(body.answer).toContain('fresh external quote for BTC is unavailable');
		expect(body.answer).not.toContain('68000');
		expect(body.marketData).toMatchObject({status:'unavailable',provider:null});
	});

	it('refuses another user’s account request without reading any ledger or funding record',async()=>{
		const {body}=await ask('Can you show another user’s wallet balance?');
		expect(body.answer).toContain('cannot access or disclose another user’s account details');
		expect(mocks.ledgerFindUnique).not.toHaveBeenCalled();
		expect(mocks.fundingFindMany).not.toHaveBeenCalled();
	});

	it('uses only recent validated turns to provide follow-up context to the AI',async()=>{
		mocks.openAiChat.mockResolvedValueOnce('A limit order sets a maximum buy price or minimum sell price.');
		const {body}=await ask('Give me an example.',[
			{role:'user',content:'Explain a limit order.'},
			{role:'assistant',content:'A limit order controls the worst acceptable execution price.'},
		]);
		expect(body.aiAssisted).toBe(true);
		expect(mocks.openAiChat).toHaveBeenCalledWith(expect.arrayContaining([
			expect.objectContaining({role:'system',content:expect.stringContaining('Nova system prompt')}),
			expect.objectContaining({role:'user',content:'Explain a limit order.'}),
			expect.objectContaining({role:'assistant',content:'A limit order controls the worst acceptable execution price.'}),
			expect.objectContaining({role:'user',content:'Give me an example.'}),
		]),expect.any(Object));
	});
});
