import {NextResponse} from 'next/server';
import {AccountMode,FundingType,Prisma,UserStatus} from '@prisma/client';
import {z,ZodError} from 'zod';
import {getServerSession} from 'next-auth';
import {authOptions} from '@/lib/auth-options';
import {assertCurrentTermsAccepted} from '@/lib/auth';
import {db} from '@/lib/db';
import {balance,reservedWithdrawalAmount} from '@/lib/ledger';
import {getAccountTier} from '@/lib/production-policy';
import {getTierProfileRequirements} from '@/lib/production-policy';
import {MARKET_ASSETS,isExternalMarketDataSource} from '@/lib/live-market';
import {getAdditionalMarketProviderKeys,getMarketHistoryWithFallback,getMarketQuoteWithFallback} from '@/lib/market-data-service';
import {getServerConfiguration} from '@/lib/config/env';
import {getSupportContact} from '@/lib/config';
import {calculateTradePlan,formatTradePlan,hasDemoOrderIntent,missingTradePlanInputs,parseDemoOrderIntent,parseTradePlan,requestsUnsupportedOrderType} from '@/lib/nova-assistant';
import {detectNovaSpecialist,detectNovaTimeframe,formatNovaMarketAnalysis} from '@/lib/nova-market-analysis';
import {rateLimit} from '@/lib/rate-limit';
import {isIP} from 'node:net';
import {openAiChat,NOVA_SYSTEM_PROMPT} from '@/lib/openai-client';
import {removeSimulatedLabels} from '@/lib/display-copy';

const schema=z.object({
	question:z.string().trim().min(1).max(800),
	conversationId:z.string().uuid().optional(),
	history:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().trim().min(1).max(800)})).max(12).optional(),
});

function clientIp(request:Request){
	const forwarded=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'';
	const real=request.headers.get('x-real-ip')?.trim()||'';
	return forwarded&&isIP(forwarded)?forwarded:real&&isIP(real)?real:'unknown';
}

function findMarketAsset(question:string){
	const normalized=question.toUpperCase();
	const aliases:Record<string,string>={BITCOIN:'BTC',ETHEREUM:'ETH',ETHER:'ETH',SOLANA:'SOL'};
	for(const asset of MARKET_ASSETS){
		const symbols=[asset.id,asset.ticker,...Object.entries(aliases).filter(([,id])=>id===asset.id).map(([name])=>name)];
		if(symbols.some(symbol=>new RegExp(`(^|[^A-Z0-9])${symbol.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}([^A-Z0-9]|$)`).test(normalized)))return asset;
	}
	return undefined;
}

function isOtherUserAccountRequest(question:string){
	const target=/\b(?:another user|other user|someone else|another person's|someone else's|their|his|her)\b/i;
	const accountData=/\b(?:account|wallet|balance|portfolio|positions?|holdings?|orders?|trades?|withdrawals?|deposits?|payments?|notifications?|verification|transaction)\b/i;
	return target.test(question)&&accountData.test(question);
}

function asksOwnAccountData(question:string){
	return /\b(?:my|mine|our|my own)\b/i.test(question)
		||/\b(?:do i have|have i|am i|did i)\b/i.test(question)
		||/\b(?:wallet balance|account balance|order history|pending withdrawal|withdrawal status|deposit status|account mode)\b/i.test(question);
}

const education:[RegExp,string][]=[
	[/\b(tax service|tax intake|tax return preparation)\b/i,'Tax preparation intake is available only when an authorized administrator enables the tax module and grants your account access. Open /tax-services if you have access. Submission is a request for review, not an IRS filing. Nova cannot grant tax access or file returns.'],
	[/\b(?:guaranteed|guarantee|risk.free|certain)\b.{0,50}\b(?:return|profit|investment|earnings)\b|\b(?:return|profit|investment|earnings)\b.{0,50}\b(?:guaranteed|guarantee|risk.free|certain)\b/i,'No investment return or profit is guaranteed. Markets can lose value, and projected or historical returns are not promises. I can explain a product’s disclosed risks and assumptions if you share its public details; this is not a personalized recommendation.'],
	[/\b(rsi|relative strength index)\b/i,'RSI (Relative Strength Index) is a momentum indicator, commonly calculated over 14 periods, that ranges from 0 to 100. Readings above 70 or below 30 are often called overbought or oversold, but these are context-dependent heuristics—not automatic reversal signals. RSI does not predict price direction.'],
	[/\b(macd|moving average convergence divergence)\b/i,'MACD (Moving Average Convergence Divergence) compares a 12-period EMA with a 26-period EMA; its signal line is commonly a 9-period EMA of MACD. Traders examine crossovers and the zero line for momentum context. It can lag price and produce false signals, especially in sideways markets.'],
	[/\b(etf|exchange.traded fund)\b/i,'An ETF is a fund that trades on an exchange and may hold a basket of assets. Its price can move during the trading day and it carries the risks of its underlying holdings.'],
	[/\b(bid.ask|spread)\b/i,'The bid is the highest displayed price a buyer is offering and the ask is the lowest displayed price a seller is offering. The spread is the difference; it may widen when liquidity is lower.'],
	[/\b(volume|liquidity)\b/i,'Volume is the amount traded over a stated period. Liquidity describes how readily an asset can be traded without materially affecting its price; volume alone does not guarantee liquidity.'],
	[/\b(volatility)\b/i,'Volatility describes how much an asset price varies over time. Higher volatility can increase both potential gains and losses; it does not predict the direction of the next move.'],
	[/\b(diversif|portfolio)\b/i,'Diversification spreads exposure across different holdings and risk sources. It can reduce concentration risk, but does not remove market risk or guarantee a return.'],
	[/\b(position size|sizing|risk.re.?ward|stop.loss|take.profit|trading risk)\b/i,'A basic risk estimate is account equity × chosen risk percentage. Position size can then be estimated as the risk budget ÷ the absolute entry-to-stop distance (adjust for contract multipliers, currency conversion, fees, and slippage). For example, risking $100 with a $5 entry-to-stop distance implies 20 units before those costs. Stops can slip or gap and do not guarantee the planned loss. This is educational, not a recommendation.'],
	[/\b(limit order|market order|order type)\b/i,'A market order seeks execution at the best available prices, which may differ from the last quote. A limit order specifies a maximum buy price or minimum sell price and may not execute. Review the order details in Trade before submitting.'],
	[/\b(order status|filled|execution)\b/i,'Order status comes from the order history and the execution provider. A submitted or open order is not a fill; check the order details for the recorded provider status. Nova does not claim execution independently.'],
	[/\b(stock|share|equity)\b/i,'A stock represents an ownership interest in a company. Its market price can change rapidly and there is no guaranteed return. For current instrument details, ask about a symbol and I will check available provider data.'],
	[/\b(risk management|risk)\b/i,'Risk management includes limiting concentration, choosing a position size consistent with a loss budget, and understanding that prices can gap or liquidity can change. No control guarantees against loss.'],
];

export async function POST(request:Request){
	try{
		const input=schema.parse(await request.json());
		const session=await getServerSession(authOptions);
		const userId=session?.user?.id;
		if(userId)await assertCurrentTermsAccepted(userId);
		rateLimit(userId?`nova-user:${userId}`:`nova-ip:${clientIp(request)}`,30,60_000);
		const user=userId?await db.user.findUnique({where:{id:userId},select:{id:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,phoneVerified:true,kycVerifications:{take:1,orderBy:{createdAt:'desc'},select:{status:true}},kycDocuments:{where:{kind:'PROOF_OF_ADDRESS'},select:{status:true}}}}):null;
		if(userId&&(!user||user.status!==UserStatus.ACTIVE||user.role!=='USER'))return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const contextualQuestion=[...(input.history||[]).map(message=>message.content),input.question].join('\n');
		if(isOtherUserAccountRequest(contextualQuestion)){
			return NextResponse.json({answer:'I can only help with information for your own authenticated Aurevia account. I cannot access or disclose another user’s account details.',aiAssisted:false,contextSafe:false},{headers:{'Cache-Control':'private, no-store'}});
		}
		const demoProfitWithdrawal=/\bdemo\b/i.test(input.question)
			&&/\b(profit|profits|gain|gains|earnings)\b/i.test(input.question)
			&&/\bwithdraw(?:n|al|als)?\b|\b(cash out|transfer|convert|real account)\b/i.test(input.question);
		const orderIntent=parseDemoOrderIntent(input.question);
		const orderIntentRequested=hasDemoOrderIntent(input.question);
		let orderDraft:{instrumentId:string;symbol:string;side:'BUY'|'SELL';type:'MARKET';quantity:number;expectedPrice:number;observedAt:string;estimatedValue:number;accountMode:'DEMO'}|undefined;
		let orderAnswer:string|undefined;
		if(demoProfitWithdrawal){
			orderAnswer='DEMO funds and profits are simulated practice values. They cannot be transferred to a REAL wallet or withdrawn as cash. DEMO activity never credits withdrawable REAL funds.';
		}else if(orderIntentRequested){
			if(requestsUnsupportedOrderType(input.question)){
				orderAnswer='Nova can currently prepare DEMO market-order previews only. Limit and stop orders are not prepared here; review their conditions in Trade. No order has been created.';
			}else if(!orderIntent){
				orderAnswer='To prepare a DEMO market-order preview, specify exactly a side, positive quantity, and listed symbol—for example, “prepare demo order: buy 2 AAPL”. No order has been created.';
			}else if(!userId){
				orderAnswer='Sign in to prepare an order preview. No order has been created.';
			}else if(user?.accountMode!==AccountMode.DEMO){
					orderAnswer='Nova order preparation is available only in DEMO mode. REAL trading is not available through Nova; use Trade only if the verified REAL execution workflow is enabled. No order has been created.';
			}else{
					const instrument=await db.instrument.findFirst({where:{symbol:orderIntent.symbol,enabled:true},select:{id:true,symbol:true,price:true}});
					if(!instrument){
						orderAnswer=`${orderIntent.symbol} is not an enabled instrument in the DEMO market. No order has been created. Open Markets to check the available symbols.`;
					}else if(orderIntent.side==='SELL'){
						const [position,reservations]=await Promise.all([
							db.position.aggregate({where:{userId,instrumentId:instrument.id,accountMode:'DEMO',status:'OPEN',side:'BUY'},_sum:{quantity:true}}),
							db.order.aggregate({where:{userId,instrumentId:instrument.id,accountMode:'DEMO',side:'SELL',status:'OPEN'},_sum:{quantity:true}}),
						]);
						const sellable=Number(position._sum.quantity||0)-Number(reservations._sum.quantity||0);
						if(sellable<orderIntent.quantity){
							orderAnswer=`The requested ${orderIntent.quantity} ${instrument.symbol} exceeds your available DEMO sell quantity${sellable>0?` of ${sellable}`:''}. No order has been created.`;
						}else{
							const expectedPrice=Number(instrument.price);
							if(!Number.isFinite(expectedPrice)||expectedPrice<=0){
								orderAnswer=`A valid DEMO reference price is unavailable for ${instrument.symbol}. No order has been created.`;
							}else{
								const observedAt=new Date().toISOString();
								orderDraft={instrumentId:instrument.id,symbol:instrument.symbol,side:orderIntent.side,type:'MARKET',quantity:orderIntent.quantity,expectedPrice,observedAt,estimatedValue:Number((expectedPrice*orderIntent.quantity).toFixed(6)),accountMode:'DEMO'};
								orderAnswer=`I prepared a DEMO-only market order preview for ${orderIntent.side} ${orderIntent.quantity} ${instrument.symbol} at the current internal reference price. Estimated notional: ${orderDraft.estimatedValue}. This is a DEMO order, the price can change before submission, and the order is not placed until you explicitly confirm below.`;
								await db.auditLog.create({data:{actorId:userId,action:'NOVA_DEMO_ORDER_PREPARED',entity:'NOVA_ACTIVITY',entityId:input.conversationId||null,metadata:{eventTypes:['DEMO_ORDER_PREPARED'],accountMode:'DEMO',symbol:instrument.symbol,externalAction:false,providerResult:'not-applicable'}}});
							}
						}
					}else{
						const expectedPrice=Number(instrument.price);
						if(!Number.isFinite(expectedPrice)||expectedPrice<=0){
							orderAnswer=`A valid DEMO reference price is unavailable for ${instrument.symbol}. No order has been created.`;
						}else{
							const observedAt=new Date().toISOString();
							orderDraft={instrumentId:instrument.id,symbol:instrument.symbol,side:orderIntent.side,type:'MARKET',quantity:orderIntent.quantity,expectedPrice,observedAt,estimatedValue:Number((expectedPrice*orderIntent.quantity).toFixed(6)),accountMode:'DEMO'};
							orderAnswer=`I prepared a DEMO-only market order preview for ${orderIntent.side} ${orderIntent.quantity} ${instrument.symbol} at the current internal reference price. Estimated notional: ${orderDraft.estimatedValue}. This is a DEMO order, the price can change before submission, and the order is not placed until you explicitly confirm below.`;
							await db.auditLog.create({data:{actorId:userId,action:'NOVA_DEMO_ORDER_PREPARED',entity:'NOVA_ACTIVITY',entityId:input.conversationId||null,metadata:{eventTypes:['DEMO_ORDER_PREPARED'],accountMode:'DEMO',symbol:instrument.symbol,externalAction:false,providerResult:'not-applicable'}}});
						}
					}
				}
			}
		const fixed=education.find(([pattern])=>pattern.test(input.question))?.[1];
		const asset=findMarketAsset(input.question)||findMarketAsset(contextualQuestion);
		let marketAnswer:string|undefined;
		let marketData:{symbol:string;provider:string|null;status:string;asOf:string|null;timeframe:string|null}|undefined;
		let quoteAudit:Record<string,string|number|boolean>|undefined;
		const fundamentalQuestion=Boolean(asset&&/\b(fundamental|valuation|earnings|revenue|profit margin|p\/e|pe ratio|balance sheet|cash flow|financial statements)\b/i.test(input.question));
		const marketQuestion=/\b(price|quote|market|movement|trading at|value|ticker|analysis|analy[sz]e|bullish|bearish|trend|outlook|technical|rsi|macd|ema|sma|atr|support|resistance|historical|candles?|volume)\b/i.test(input.question);
		const analysisQuestion=/\b(analysis|analy[sz]e|bullish|bearish|trend|outlook|technical|rsi|macd|ema|sma|atr|support|resistance|historical|candles?)\b/i.test(input.question);
		const contextualMarketQuestion=marketQuestion||Boolean(asset&&/\b(what about|how about|and|those levels|the trend|support|resistance|bullish|bearish)\b/i.test(input.question));
		const analysisRequested=analysisQuestion||Boolean(asset&&/\b(what about|how about|and|those levels|the trend|support|resistance|bullish|bearish)\b/i.test(input.question));
		const timeframe=detectNovaTimeframe(input.question)||detectNovaTimeframe(contextualQuestion);
		if(asset&&fundamentalQuestion&&!/\b(technical|price|quote|trend|bullish|bearish|support|resistance|rsi|macd|ema|sma|atr)\b/i.test(input.question)){
			marketAnswer=`I do not have a verified company-fundamentals or valuation feed connected for ${asset.id}. I will not invent financial-statement, earnings, or P/E figures. Share a public filing or verified figures if you would like help interpreting them; this is educational, not a recommendation.`;
			marketData={symbol:asset.id,provider:null,status:'unavailable',asOf:null,timeframe:null};
		}else if(asset&&(contextualMarketQuestion||fundamentalQuestion)){
			const config=getServerConfiguration();
			const additionalProviders=getAdditionalMarketProviderKeys(config.marketData);
			let quote:Awaited<ReturnType<typeof getMarketQuoteWithFallback>>|undefined;
			try{
				quote=await getMarketQuoteWithFallback(asset,additionalProviders);
			}catch(error){
				console.warn(`Nova market quote unavailable (${asset.id}, ${error instanceof Error?error.name:'UnknownError'}).`);
			}
			const quoteAge=quote?Date.now()-Date.parse(quote.updatedAt):Number.POSITIVE_INFINITY;
			const freshQuote=quote&&isExternalMarketDataSource(quote.source)&&!quote.isStale&&Number.isFinite(quoteAge)&&quoteAge>=0&&quoteAge<=5*60_000?quote:null;
			if(quote){
				quoteAudit={symbol:asset.id,source:quote.source,freshness:freshQuote?'FRESH_PROVIDER_TIMESTAMP':quote.isStale?'STALE':'UNAVAILABLE',updatedAt:quote.updatedAt,externalAction:false,providerResult:freshQuote?'quote-returned':'not-verified-current'};
			}else{
				quoteAudit={symbol:asset.id,freshness:'UNAVAILABLE',externalAction:false,providerResult:'unavailable'};
			}
			if(analysisRequested&&!timeframe){
				marketAnswer=freshQuote
					?`Market overview\n${asset.name} (${asset.id}): ${freshQuote.price} ${asset.currency}; daily change ${freshQuote.change} (${freshQuote.changePercent}%).\n\nCurrent verified conditions\nProvider: ${freshQuote.source}; timestamp: ${freshQuote.updatedAt}. This integration does not declare whether the quote is live or delayed.\n\nA trend and indicator reading depends on timeframe. Which timeframe should I use (for example 1h, 4h, 1d, or 1w)? I have not inferred a bullish or bearish outlook without that context.`
					:`I could not retrieve a fresh external quote for ${asset.id}. Internal reference prices are not presented as verified market data. Which timeframe would you like analyzed (for example 1h, 4h, 1d, or 1w)? Historical data will be used only if an external provider returns it.`;
				marketData={symbol:asset.id,provider:freshQuote?.source||null,status:freshQuote?'provider-timestamped':'unavailable',asOf:freshQuote?.updatedAt||null,timeframe:null};
			}else if(analysisRequested&&timeframe){
				let history:Awaited<ReturnType<typeof getMarketHistoryWithFallback>>|undefined;
				try{
					history=await getMarketHistoryWithFallback(asset,timeframe,additionalProviders);
				}catch(error){
					console.warn(`Nova market history unavailable (${asset.id}, ${error instanceof Error?error.name:'UnknownError'}).`);
				}
				if(history&&isExternalMarketDataSource(history.source)&&history.candles.length){
					marketAnswer=formatNovaMarketAnalysis({
						symbol:asset.id,name:asset.name,timeframe,provider:history.source,candles:history.candles,
						quote:freshQuote?{price:freshQuote.price,updatedAt:freshQuote.updatedAt,source:freshQuote.source,change:freshQuote.change,changePercent:freshQuote.changePercent}:null,
					});
					const asOf=freshQuote?.updatedAt||new Date(history.candles.at(-1)!.time*1000).toISOString();
					marketData={symbol:asset.id,provider:history.source,status:freshQuote?'provider-timestamped':'historical',asOf,timeframe};
					quoteAudit={...quoteAudit,symbol:asset.id,historySource:history.source,historyTimeframe:timeframe,historyCandles:history.candles.length,historyAsOf:asOf};
				}else{
					marketAnswer=`Market analysis for ${asset.id} on ${timeframe} is unavailable: no verified external historical candles were returned. Internal reference values are excluded from technical analysis.${freshQuote?` A fresh ${freshQuote.source} quote is available at ${freshQuote.updatedAt}, but it is insufficient to calculate the requested timeframe indicators.`:''}`;
					marketData={symbol:asset.id,provider:freshQuote?.source||null,status:'unavailable',asOf:freshQuote?.updatedAt||null,timeframe};
				}
			}else if(marketQuestion){
				marketAnswer=freshQuote
					?`${asset.name} (${asset.id}): ${freshQuote.price} ${asset.currency}; daily change ${freshQuote.change} (${freshQuote.changePercent}%). Provider: ${freshQuote.source}. Timestamp: ${freshQuote.updatedAt}. Live-versus-delayed status is not declared by this integration. Informational market data only.`
					:`A fresh external quote for ${asset.id} is unavailable. I will not substitute an internal reference price for current market data.`;
				marketData={symbol:asset.id,provider:freshQuote?.source||null,status:freshQuote?'provider-timestamped':'unavailable',asOf:freshQuote?.updatedAt||null,timeframe:null};
			}
		}
		let accountAnswer:string|undefined;
		let auditAction:string|undefined;
		let tradePlanAnswer:string|undefined;
		if(/\b(position size|position sizing|calculate (?:my )?(?:position )?size|risk.reward|risk to reward)\b/i.test(input.question)){
			const parsed=parseTradePlan(input.question);
			const plan=parsed?calculateTradePlan(parsed):null;
			tradePlanAnswer=plan?formatTradePlan(plan):missingTradePlanInputs(input.question);
			if(userId&&plan){
				await db.auditLog.create({data:{actorId:userId,action:'NOVA_TRADE_PLAN_CALCULATED',entity:'NOVA_ACTIVITY',entityId:input.conversationId||null,metadata:{eventTypes:['TRADE_PLAN_CALCULATED'],accountMode:user?.accountMode||AccountMode.DEMO,externalAction:false,providerResult:'not-applicable'}}});
				auditAction='trade-plan-calculation';
			}
		}
		let newsAnswer:string|undefined;
		const economicTopic=/\b(economic|fed|federal reserve|fomc|inflation|cpi|payroll|employment|interest rate)\b/i.test(input.question);
		const newsQuestion=/\b(news|headlines?|current|latest|recent|today|upcoming|next|announcement|release|decision)\b/i.test(input.question)
			&&(/\b(news|headlines?|announcement|release|decision)\b/i.test(input.question)||economicTopic);
		if(newsQuestion){
			try{
				const articles=await db.newsFeedItem.findMany({
					where:{status:'ACTIVE',source:{enabled:true}},
					select:{title:true,summary:true,publisher:true,canonicalUrl:true,category:true,publishedAt:true,source:{select:{displayName:true,lastSuccessAt:true}}},
					orderBy:[{publishedAt:'desc'},{importedAt:'desc'}],
					take:16,
				});
				const economicPattern=/\b(fed|federal reserve|fomc|inflation|cpi|payroll|employment|interest rate|central bank|economic)\b/i;
				const relevant=economicTopic?articles.filter(article=>economicPattern.test(`${article.title} ${article.summary||''} ${article.category}`)):articles;
				if(relevant.length){
					newsAnswer=`Publisher-sourced items in Aurevia’s stored news feed${economicTopic?' relevant to the economic topic':''}:\n${relevant.slice(0,4).map(article=>{
						const published=article.publishedAt?.toISOString()||'publication timestamp unavailable';
						const refreshed=article.source.lastSuccessAt?.toISOString();
						return `- ${article.title} — ${article.publisher||article.source.displayName}; published ${published}; feed provider ${article.source.displayName}${refreshed?`, last refreshed ${refreshed}`:''}. ${article.canonicalUrl}`;
					}).join('\n')}\n\nThese are publisher headlines, not independently verified market impacts or forecasts.${economicTopic?' Aurevia does not currently connect an economic-calendar endpoint, so I cannot verify the next scheduled release from this feed.':''}`;
				}else{
					newsAnswer=`No relevant publisher-sourced ${economicTopic?'economic-announcement':'news'} item is currently available in Aurevia’s stored feed.${economicTopic?' The platform does not currently connect an economic-calendar endpoint, so I cannot verify an upcoming release or its scheduled time.':''}`;
				}
			}catch(error){
				console.warn(`Nova news feed unavailable (${error instanceof Error?error.name:'UnknownError'}).`);
				newsAnswer='Aurevia’s publisher-sourced news feed is temporarily unavailable. I cannot verify the requested headline or economic announcement right now.';
			}
		}
		if(user&&asksOwnAccountData(input.question)){
				const requested=input.question.toLowerCase();
				const answers:string[]=[];
				const eventTypes:string[]=[];
				if(/\b(balance|wallet)\b/.test(requested)){
					const ledger=await db.ledgerAccount.findUnique({where:{code:`USER:${user.id}:${user.accountMode}:USD`},select:{id:true}});
					if(ledger){
						const [current,reserved]=await Promise.all([balance(db,ledger.id),user.accountMode===AccountMode.REAL?reservedWithdrawalAmount(db,user.id,user.accountMode,'USD'):Promise.resolve(new Prisma.Decimal(0))]);
						const available=Prisma.Decimal.max(new Prisma.Decimal(0),current.minus(reserved));
						answers.push(`${user.accountMode} USD ledger balance: ${current.toString()} USD. Pending withdrawals reserve ${reserved.toString()} USD, leaving ${available.toString()} USD available before other account restrictions. Pending deposits are not included until approved. This is internal account ledger data.`);
					}
					else answers.push(`No ${user.accountMode} USD ledger account is available to report.`);
					eventTypes.push('WALLET_BALANCE_LOOKUP');
				}
				if(/\bportfolio|positions?|holdings?\b/.test(requested)){
					const [openPositionCount,positions]=await Promise.all([
						db.position.count({where:{userId:user.id,accountMode:user.accountMode,status:'OPEN'}}),
						db.position.findMany({where:{userId:user.id,accountMode:user.accountMode,status:'OPEN'},include:{instrument:{select:{symbol:true,price:true,updatedAt:true}}},orderBy:{openedAt:'desc'},take:5}),
					]);
					const holdings=positions.map(position=>{
						const mark=new Prisma.Decimal(position.instrument.price);
						const difference=position.side==='BUY'?mark.minus(position.entryPrice):position.entryPrice.minus(mark);
						const unrealized=difference.mul(position.quantity);
						return `${position.side} ${position.quantity.toString()} ${position.instrument.symbol} at entry ${position.entryPrice.toString()}, latest stored DEMO mark ${mark.toString()}, unrealized mark-to-market ${unrealized.toString()} USD (price updated ${position.instrument.updatedAt.toISOString()})`;
					}).join('; ');
					answers.push(`${user.accountMode} account has ${openPositionCount} open position${openPositionCount===1?'':'s'}${holdings?`. Latest records: ${holdings}`:'. No open positions are recorded.'} Mark-to-market figures are estimates from stored DEMO prices, not realized profit or external valuations.`);
					eventTypes.push('PORTFOLIO_SUMMARY_LOOKUP');
				}
				if(/\b(orders?|trades?|execution|fill)\b/.test(requested)){
					const [orderCount,orders]=await Promise.all([
						db.order.count({where:{userId:user.id,accountMode:user.accountMode}}),
						db.order.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{createdAt:'desc'},take:5,select:{id:true,side:true,type:true,status:true,quantity:true,filledQuantity:true,providerStatus:true,updatedAt:true,instrument:{select:{symbol:true}}}}),
					]);
					const recent=orders.map(order=>`${order.side} ${order.quantity.toString()} ${order.instrument.symbol} ${order.type} · ${order.status}${order.providerStatus?` (provider: ${order.providerStatus})`:''}${order.filledQuantity.gt(0)?` · recorded filled quantity ${order.filledQuantity.toString()}`:''}`).join('; ');
					answers.push(`${user.accountMode} order history contains ${orderCount} record${orderCount===1?'':'s'}${recent?`. Latest orders: ${recent}`:''}. A request is not a fill; only the stored execution/provider status is reported.`);
					eventTypes.push('ORDER_HISTORY_LOOKUP');
				}
				if(/\binvestments?\b/.test(requested)){
					if(user.accountMode===AccountMode.DEMO){
						answers.push('Investment allocations are not available in DEMO mode. The DEMO workspace is limited to virtual cash, practice orders, positions, trading history, and profit/loss.');
					}else{
						const [count,investments,opportunities]=await Promise.all([
							db.investmentRequest.count({where:{userId:user.id,accountMode:user.accountMode}}),
							db.investmentRequest.findMany({where:{userId:user.id,accountMode:user.accountMode},orderBy:{requestedAt:'desc'},take:5,select:{amount:true,status:true,requestedAt:true,activatedAt:true,maturesAt:true,simulatedPayout:true,opportunity:{select:{title:true}}}}),
							db.investmentOpportunity.findMany({where:{status:'AVAILABLE',realEligible:true},orderBy:{createdAt:'desc'},take:5,select:{title:true,minimumAmount:true,durationDays:true,targetReturnPercent:true}}),
						]);
						const recent=investments.map(item=>`${item.opportunity.title}: ${item.amount.toString()} USD · ${item.status.replaceAll('_',' ')}${item.maturesAt?` · matures ${item.maturesAt.toISOString()}`:''}${item.status==='SETTLED'&&item.simulatedPayout?` · virtual payout ${item.simulatedPayout.toString()} USD`:''}`).join('; ');
						const plans=opportunities.map(item=>`${item.title} · minimum ${item.minimumAmount.toString()} USD · ${item.durationDays} days${item.targetReturnPercent===null?'':` · configured target ${item.targetReturnPercent.toString()}%`}`).join('; ');
						answers.push(`Your REAL account has ${count} investment request${count===1?'':'s'}${recent?`. Recent activity: ${recent}`:'. No investment requests are recorded.'}${plans?` Available plans: ${plans}.`:''} Any configured target and payout are virtual practice results, not guaranteed or external investment returns.`);
					}
					eventTypes.push('INVESTMENT_CONTEXT_LOOKUP');
				}
				if(/\bwatchlist\b/.test(requested)){
					answers.push('I cannot read a saved watchlist from the server in this session. Open Markets to review the watchlist saved for this device and account.');
					eventTypes.push('WATCHLIST_SOURCE_UNAVAILABLE');
				}
				if(/\btiers?\b/.test(requested)){
					const requirements=getTierProfileRequirements(user);
					const tier=getAccountTier({accountMode:user.accountMode,kycStatus:user.accountMode===AccountMode.REAL?user.kycStatus:'PENDING',verificationDocuments:0,verificationSubmitted:false,phoneVerified:user.accountMode===AccountMode.REAL&&user.phoneVerified,profileComplete:requirements.profileComplete,approvedTier:user.approvedTier});
					answers.push(`Current account tier: ${tier.label}. Tier approval does not enable REAL trading.`);
					eventTypes.push('TIER_STATUS_LOOKUP');
				}
				if(/\bkyc|verification\b/.test(requested)){
					const verificationStatus=user.kycVerifications[0]?.status||'no first-party case submitted';
					const proofStatuses=user.kycDocuments.map(document=>document.status).join(', ')||'none submitted';
					answers.push(user.accountMode===AccountMode.DEMO?'Identity verification is a REAL account workflow and is unavailable in DEMO mode.':`Recorded identity review status: ${user.kycStatus}; latest Aurevia Verify case: ${verificationStatus}; proof of address: ${proofStatuses}. Tier 3 also requires administrator review. Nova cannot approve identity checks.`);
					eventTypes.push('KYC_STATUS_LOOKUP');
				}
				if(/\btickets?\b/.test(requested)){
					const tickets=await db.supportConversation.count({where:{userId:user.id,accountMode:user.accountMode,status:{notIn:['RESOLVED','CLOSED']}}});
					answers.push(`You have ${tickets} support ticket${tickets===1?'':'s'} currently open in this account mode. Your full ticket history is available in Support.`);
					eventTypes.push('SUPPORT_STATUS_LOOKUP');
				}
				if(/\bnotifications?\b/.test(requested)){
					const unread=await db.notification.count({where:{userId:user.id,isRead:false,OR:[{accountMode:user.accountMode},{accountMode:null}] }});
					answers.push(`You have ${unread} unread notification${unread===1?'':'s'}. Open Notifications to review them.`);
					eventTypes.push('NOTIFICATION_SUMMARY_LOOKUP');
				}
				if(/\b(deposits?|withdrawals?|payments?|payouts?)\b/.test(requested)){
					if(user.accountMode===AccountMode.DEMO){
						answers.push('Deposits, withdrawals, and payment requests are unavailable in DEMO mode. DEMO funds are virtual and remain separate from REAL account balances.');
					}else{
						const requests=await db.fundingRequest.findMany({where:{userId:user.id,accountMode:AccountMode.REAL,type:{in:[FundingType.DEPOSIT,FundingType.WITHDRAWAL]}},orderBy:{createdAt:'desc'},take:5,select:{type:true,status:true,amount:true,currency:true}});
						const recent=requests.map(item=>`${item.type.toLowerCase()} ${item.amount.toString()} ${item.currency} · ${item.status.toLowerCase().replaceAll('_',' ')}`).join('; ');
						answers.push(`Your REAL account supports internal deposit and withdrawal requests in Wallet. ${recent?`Recent requests: ${recent}.`:'No funding requests are recorded.'} An authorized Aurevia administrator reviews requests and any ledger changes; no payment provider, bank, broker, or crypto network is contacted. A request or evidence attachment is not proof of a real payment.`);
					}
					eventTypes.push('PAYMENT_INSTRUCTIONS_LOOKUP');
				}
				accountAnswer=answers.join(' ');
				if(eventTypes.length)await db.auditLog.create({data:{actorId:user.id,action:'NOVA_USER_CONTEXT_LOOKUP',entity:'NOVA_ACTIVITY',entityId:input.conversationId||null,metadata:{eventTypes,accountMode:user.accountMode,externalAction:false}}});
				auditAction=eventTypes.length?'account-context':undefined;
		}
		if(userId&&quoteAudit)await db.auditLog.create({data:{actorId:userId,action:'NOVA_MARKET_DATA_LOOKUP',entity:'NOVA_ACTIVITY',entityId:input.conversationId||null,metadata:quoteAudit}});
		const contact=getSupportContact();
		const platformAnswer= /\b(broker|paper trading|paper execution|live exchange|live execution)\b/i.test(input.question)
			?'Aurevia does not route orders to an external broker or exchange. REAL orders use Aurevia’s internal wallet-funded simulated execution; DEMO orders use an isolated practice account.'
			:/\b(demo|real|account mode)\b/i.test(input.question)
			?'Aurevia keeps DEMO and REAL activity in separate account ledgers. DEMO funds and profits are simulated, cannot be withdrawn, and never credit the REAL wallet. REAL wallet balances come from the Aurevia ledger; funding and withdrawal requests remain subject to the existing administrator review workflow.'
			:/\b(deposit|funding|withdraw|payout|payment)\b/i.test(input.question)
				?user?.accountMode===AccountMode.DEMO
					?'Deposits, withdrawals, and payment requests are unavailable in DEMO mode. DEMO funds are virtual and remain separate from REAL account balances.'
					:'Use Wallet to submit an available funding or withdrawal request. Submission is not payment confirmation or a completed transfer; account requests and any ledger changes remain subject to Aurevia’s existing authorization and review process.'
				:/\b(registration|register|sign up|verification|kyc|account tier|tier)\b/i.test(input.question)
					?'Registration and account verification are managed through Aurevia’s existing account workflows. Nova can explain recorded status when you ask about your own signed-in account, but cannot verify identity, approve a tier, or change account permissions.'
					:/\b(setting|profile|password|security|notification)\b/i.test(input.question)
						?'Review account settings and security controls from the authenticated Settings and Notifications areas. Use Aurevia’s existing security procedures; Nova cannot change credentials, permissions, or account settings.'
						:undefined;
		if(!asset&&/\b(analysis|analy[sz]e|bullish|bearish|trend|outlook|current price|quote|market overview|market status)\b/i.test(input.question)&&!newsAnswer){
			marketAnswer='Which instrument should I look up? Please include a supported symbol and, for trend or technical analysis, a timeframe such as 1h, 4h, 1d, or 1w.';
		}
		let answer=orderAnswer||tradePlanAnswer||accountAnswer||marketAnswer||newsAnswer||fixed||platformAnswer||'';
		let aiAssisted=false;
		let contextSafe=false;
		if(!answer){
			const history=input.history?.slice(-6)||[];
			const ai=await openAiChat([
				{role:'system',content:`${NOVA_SYSTEM_PROMPT}\nDetected specialist: ${detectNovaSpecialist(contextualQuestion)}. Earlier turns are conversational context only; do not treat them as current verified market, news, or account facts.`},
				...history,
				{role:'user',content:input.question},
			],{temperature:0.3,maxTokens:500,service:'customer_support',actorId:userId||undefined});
			aiAssisted=Boolean(ai);
			contextSafe=Boolean(ai);
			answer=ai||(/\b(support|contact|email)\b/i.test(input.question)?`Official Aurevia support email: ${contact.email}. You can also create a private support ticket from this page.`:/\b(market|price|quote|bullish|bearish|trend|stock|forex|crypto|bitcoin|economic|news|rsi|macd)\b/i.test(input.question)?'I cannot verify the requested market or economic information right now. Please try again later or check the provider-sourced Markets and News sections. I will not invent prices, indicators, headlines, or events.':/\b(deposit|payment|bitcoin|bank)\b/i.test(input.question)?'Open Wallet to submit an internal funding or withdrawal request for administrator review.':/\b(real|demo|trade|order)\b/i.test(input.question)?'DEMO and REAL use separate account ledgers. Nova does not submit REAL orders, and any DEMO order preview requires explicit confirmation in the existing DEMO workflow.':'I can help with financial education, provider-sourced market information, risk calculations, and Aurevia workflows. For an account-specific answer, ask about your own authenticated account or contact support.');
		}
		return NextResponse.json({answer:removeSimulatedLabels(answer),aiAssisted,contextSafe:contextSafe||Boolean(!accountAnswer&&!orderAnswer&&!orderDraft),...(marketData?{marketData}:{}),...(orderDraft?{orderDraft}:{}),activity:auditAction||quoteAudit||orderDraft?'recorded-without-conversation-content':'none'},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Ask a question of at most 800 characters.'},{status:400});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Nova requests are temporarily rate limited. Try again shortly.'},{status:429});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Sign in to ask account-specific questions.'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Accept the current Terms & Conditions before continuing.'},{status:403});
		console.error('Nova request failed.');
		return NextResponse.json({error:'Nova is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
