import {randomUUID} from 'node:crypto';
import {db} from './db';
import {balance,ensureSystemAccount,ensureUserLedger,postDoubleEntry,roundUsdAmount} from './ledger';
import {getTreasuryAvailable} from '@/lib/platform-bank';
import {AccountMode,EntryType,NotificationType,OrderSide,OrderStatus,OrderType,Prisma} from '@prisma/client';
import {createNotification} from '@/lib/notifications';
import {assertFreshQuote,assertMinimumUsdNotional,assertSellableQuantity,averageEntryPrice,realizedSpotPnl} from '@/lib/trading-policy';
import {getDemoAiConfig} from '@/lib/demo-ai-config';
import {availableWalletAmount,getRealWalletReservations,lockRealWalletCurrencies,roundWalletAmount} from '@/lib/real-wallet-reservations';
import {LEGACY_EXTERNAL_PROVIDER} from '@/lib/bitcoin-funding';
import {getServerConfiguration} from '@/lib/config/env';
import {getAdditionalMarketProviderKeys,getMarketQuoteWithFallback} from '@/lib/market-data-service';
import {getMarketAssetForTradingSymbol,isExternalMarketDataSource} from '@/lib/live-market';

export type PlaceOrderInput={instrumentId:string;side:OrderSide;type:OrderType;quantity:number;price?:number;stopPrice?:number;expectedPrice:number;observedAt:string};

export type ValidatedTwelveDataQuote={price:number;updatedAt:string};

const FREE_EXECUTION_SOURCES=new Set(['Binance','CoinGecko','Frankfurter','Yahoo Finance','Stooq']);

/** Resolve an executable mark: Twelve Data (preferred) or free built-in providers so REAL/DEMO trades work 24/7. */
export async function resolveTwelveDataExecutionQuote(symbol:string):Promise<ValidatedTwelveDataQuote>{
 const asset=getMarketAssetForTradingSymbol(symbol);
 if(!asset)throw new Error('MARKET_QUOTE_UNAVAILABLE');
 const configuration=getServerConfiguration();
 let quote;
 try{
  quote=await getMarketQuoteWithFallback(asset,getAdditionalMarketProviderKeys(configuration.marketData));
 }catch{
  throw new Error('MARKET_QUOTE_UNAVAILABLE');
 }
 const fromTwelve=quote.source==='Twelve Data'&&isExternalMarketDataSource(quote.source);
 const fromFree=FREE_EXECUTION_SOURCES.has(quote.source);
 if(!fromTwelve&&!fromFree)throw new Error('MARKET_QUOTE_UNAVAILABLE');
 if(fromTwelve&&quote.isStale)throw new Error('MARKET_QUOTE_UNAVAILABLE');
 if(fromTwelve)assertFreshQuote(quote.updatedAt);
 else{
  // Free providers: allow marks up to 15 minutes so simulated REAL trading stays available
  const age=Date.now()-Date.parse(quote.updatedAt);
  if(!Number.isFinite(age)||age<-5_000||age>15*60_000)throw new Error('STALE_MARKET_QUOTE');
 }
 if(!Number.isFinite(quote.price)||quote.price<=0)throw new Error('MARKET_QUOTE_UNAVAILABLE');
 return {price:quote.price,updatedAt:quote.updatedAt};
}

function executable(type:OrderType,side:OrderSide,market:number,price?:number,stopPrice?:number){
 if(type===OrderType.MARKET)return true;
 if(type===OrderType.LIMIT)return price!==undefined&&(side===OrderSide.BUY?market<=price:market>=price);
 return stopPrice!==undefined&&(side===OrderSide.BUY?market>=stopPrice:market<=stopPrice);
}

export function matchesOrder(order:Awaited<ReturnType<typeof db.order.findUnique>>|null,userId:string,accountMode:AccountMode,input:PlaceOrderInput){
 return !!order&&order.userId===userId&&order.accountMode===accountMode&&order.instrumentId===input.instrumentId&&order.side===input.side&&order.type===input.type&&order.quantity.equals(input.quantity)&&((order.price===null&&input.price===undefined)||(!!order.price&&order.price.equals(input.price||0)))&&((order.stopPrice===null&&input.stopPrice===undefined)||(!!order.stopPrice&&order.stopPrice.equals(input.stopPrice||0)));
}

export async function executeOrderTx(tx:Prisma.TransactionClient,orderId:string,fill:number){
 const order=await tx.order.findUnique({where:{id:orderId},include:{instrument:true}});
 if(!order||order.status!==OrderStatus.OPEN)throw new Error('ORDER_NOT_OPEN');
 if(order.providerName===LEGACY_EXTERNAL_PROVIDER)throw new Error('EXTERNAL_PROVIDER_ORDER');
 const quantity=order.quantity.minus(order.filledQuantity); if(quantity.lte(0))throw new Error('ORDER_FILLED');
 let fillPrice=new Prisma.Decimal(fill);
 if(fillPrice.lte(0))throw new Error('INVALID_PRICE');
 if(order.accountMode===AccountMode.DEMO){
  const config=getDemoAiConfig();
  const marketCostBps=config.slippageBps+config.spreadBps/2;
  const factor=new Prisma.Decimal(marketCostBps).div(10_000);
  fillPrice=fillPrice.mul(order.side===OrderSide.BUY?new Prisma.Decimal(1).plus(factor):new Prisma.Decimal(1).minus(factor)).toDecimalPlaces(10,Prisma.Decimal.ROUND_HALF_UP);
  if(fillPrice.lte(0))throw new Error('INVALID_PRICE');
 }
 const notional=roundUsdAmount(fillPrice.mul(quantity));
 const configuredDemoFee=order.accountMode===AccountMode.DEMO?new Prisma.Decimal(getDemoAiConfig().feeRate):new Prisma.Decimal(0);
 const feeRate=Prisma.Decimal.max(order.instrument.takerFee,configuredDemoFee);
 const fee=roundUsdAmount(notional.mul(feeRate));
 const userAcct=await ensureUserLedger(tx,order.userId,order.accountMode);
 const fees=await ensureSystemAccount(tx,`SYSTEM:${order.accountMode}:FEES`,'DEMO trading fees','USD',order.accountMode);
 const clearing=await ensureSystemAccount(tx,`SYSTEM:${order.accountMode}:CLEARING`,'DEMO spot clearing','USD',order.accountMode);
 const existing=await tx.position.findFirst({where:{userId:order.userId,instrumentId:order.instrumentId,accountMode:order.accountMode,status:'OPEN',side:OrderSide.BUY}});
 if(order.side===OrderSide.BUY){
  const [ledgerBalance,pendingWithdrawals]=await Promise.all([
   balance(tx,userAcct.id),
   tx.fundingRequest.aggregate({where:{userId:order.userId,accountMode:order.accountMode,currency:userAcct.currency,type:'WITHDRAWAL',status:{in:['PENDING','PENDING_REVIEW','APPROVED','PROCESSING']}},_sum:{amount:true}}),
  ]);
  const available=ledgerBalance.minus(pendingWithdrawals._sum.amount??new Prisma.Decimal(0));
  if(available.lt(notional.plus(fee)))throw new Error('INSUFFICIENT_SIMULATED_BALANCE');
  await postDoubleEntry(tx,{reference:`TRADE:BUY:${order.id}`,description:`DEMO purchase of ${order.instrument.symbol}`,debitAccountId:userAcct.id,creditAccountId:clearing.id,amount:notional});
  if(fee.gt(0))await postDoubleEntry(tx,{reference:`TRADE:FEE:${order.id}`,description:`DEMO ${order.instrument.symbol} trading fee`,debitAccountId:userAcct.id,creditAccountId:fees.id,amount:fee});
  if(existing){
   const average=averageEntryPrice(existing.quantity,existing.entryPrice,quantity,fillPrice,fee);
   await tx.position.update({where:{id:existing.id},data:{quantity:{increment:quantity},entryPrice:average,margin:{increment:notional.plus(fee)},leverage:1}});
  }else{
   const entry=averageEntryPrice(new Prisma.Decimal(0),new Prisma.Decimal(0),quantity,fillPrice,fee);
   await tx.position.create({data:{userId:order.userId,instrumentId:order.instrumentId,accountMode:order.accountMode,side:OrderSide.BUY,quantity,entryPrice:entry,leverage:1,margin:notional.plus(fee)}});
  }
 }else{
  if(!existing)throw new Error('INSUFFICIENT_POSITION');
  const reserved=await tx.order.aggregate({where:{userId:order.userId,instrumentId:order.instrumentId,accountMode:order.accountMode,side:OrderSide.SELL,status:OrderStatus.OPEN,id:{not:order.id}},_sum:{quantity:true}});
  assertSellableQuantity(existing.quantity,reserved._sum.quantity??new Prisma.Decimal(0),quantity);
  const pnl=realizedSpotPnl(existing.entryPrice,fillPrice,quantity,fee);
  await postDoubleEntry(tx,{reference:`TRADE:SELL:${order.id}`,description:`DEMO sale of ${order.instrument.symbol}`,debitAccountId:clearing.id,creditAccountId:userAcct.id,amount:notional});
  if(fee.gt(0))await postDoubleEntry(tx,{reference:`TRADE:FEE:${order.id}`,description:`DEMO ${order.instrument.symbol} trading fee`,debitAccountId:userAcct.id,creditAccountId:fees.id,amount:fee});
  const remaining=existing.quantity.minus(quantity);
  const basisReduction=existing.margin.mul(quantity).div(existing.quantity);
  await tx.position.update({where:{id:existing.id},data:remaining.isZero()?{status:'CLOSED',closedAt:new Date(),margin:0,realizedPnl:{increment:pnl}}:{quantity:remaining,margin:existing.margin.minus(basisReduction),realizedPnl:{increment:pnl}}});
 }
 await tx.execution.create({data:{orderId:order.id,accountMode:order.accountMode,quantity,price:fillPrice,fee}});
 await tx.order.update({where:{id:order.id},data:{filledQuantity:{increment:quantity},averageFillPrice:fillPrice,fee:{increment:fee},status:OrderStatus.FILLED}});
 await tx.auditLog.create({data:{actorId:order.userId,action:`${order.accountMode==='DEMO'?'DEMO':'REAL_SIMULATED'}_ORDER_${order.side}_FILLED`,entity:'ORDER',entityId:order.id,metadata:{oldState:OrderStatus.OPEN,newState:OrderStatus.FILLED,accountMode:order.accountMode,simulated:true,instrument:order.instrument.symbol,quantity:quantity.toString(),fillPrice:fillPrice.toString(),fee:fee.toString()}}});
 await createNotification(tx,{userId:order.userId,type:NotificationType.TRADE,title:`${order.accountMode} order filled`,message:`Your ${order.side.toLowerCase()} order for ${order.instrument.symbol} filled ${quantity.toString()} at ${fillPrice.toString()} in the internal paper-trading environment.`,dedupeKey:`order:${order.id}:filled`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/trade'});
 return tx.order.findUnique({where:{id:order.id},include:{executions:true,instrument:true}});
}

export async function executeRealOrderTx(tx:Prisma.TransactionClient,orderId:string,fill:number,fillQuantity?:Prisma.Decimal,specificPositionId?:string,quoteObservedAt?:string){
 const order=await tx.order.findUnique({where:{id:orderId},include:{instrument:true}});
 if(!order||order.accountMode!==AccountMode.REAL||(order.status!==OrderStatus.OPEN&&order.status!==OrderStatus.PARTIALLY_FILLED))throw new Error('ORDER_NOT_OPEN');
 if(order.providerName)throw new Error('EXTERNAL_PROVIDER_ORDER');
 const instrument=order.instrument;
 const settlementCurrency=(order.settlementCurrency||instrument.quoteAsset).trim().toUpperCase();
 const baseAsset=instrument.baseAsset.trim().toUpperCase();
 if(!settlementCurrency||!baseAsset||settlementCurrency===baseAsset||settlementCurrency!==instrument.quoteAsset.toUpperCase())throw new Error('ORDER_CURRENCY_MISMATCH');
 if(!instrument.takerFee.isFinite()||instrument.takerFee.lt(0)||instrument.takerFee.gte(1))throw new Error('INSTRUMENT_FEE_INVALID');
 const remaining=order.quantity.minus(order.filledQuantity);
 const quantity=fillQuantity??remaining;
 if(!quantity.isFinite()||quantity.lte(0)||quantity.gt(remaining))throw new Error('INVALID_FILL_QUANTITY');
 const fillPrice=new Prisma.Decimal(fill);
 if(!fillPrice.isFinite()||fillPrice.lte(0))throw new Error('INVALID_PRICE');
 if(quoteObservedAt){
  assertFreshQuote(quoteObservedAt);
 }else{
  const age=Date.now()-instrument.updatedAt.getTime();
  if(!Number.isFinite(age)||age < -5_000||age > 30_000)throw new Error('STALE_MARKET_QUOTE');
 }
 await lockRealWalletCurrencies(tx,order.userId,[settlementCurrency,baseAsset]);
 const quoteAccount=await tx.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${order.userId}:${AccountMode.REAL}:${settlementCurrency}`}});
 const baseAccount=await tx.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${order.userId}:${AccountMode.REAL}:${baseAsset}`}});
 const reservations=await getRealWalletReservations(tx,order.userId,order.side===OrderSide.BUY?settlementCurrency:baseAsset,order.id);
 const walletBalance=await balance(tx,order.side===OrderSide.BUY?quoteAccount.id:baseAccount.id);
 const available=availableWalletAmount(walletBalance,reservations);
 const notional=roundWalletAmount(settlementCurrency,fillPrice.mul(quantity));
 const fee=roundWalletAmount(settlementCurrency,notional.mul(instrument.takerFee));
 const required=order.side===OrderSide.BUY?notional.plus(fee):quantity;
 if(notional.lte(0)||fee.lt(0)||available.lt(required))throw new Error(order.side===OrderSide.BUY?'INSUFFICIENT_REAL_WALLET_COLLATERAL':'INSUFFICIENT_POSITION');

 const executionId=randomUUID();
 const quoteClearing=await ensureSystemAccount(tx,`SYSTEM:REAL:TRADING_CLEARING:${settlementCurrency}`,`REAL simulated trading clearing ${settlementCurrency}`,settlementCurrency,AccountMode.REAL);
 const baseClearing=await ensureSystemAccount(tx,`SYSTEM:REAL:TRADING_CLEARING:${baseAsset}`,`REAL simulated trading clearing ${baseAsset}`,baseAsset,AccountMode.REAL);
 const feeAccount=fee.gt(0)?await ensureSystemAccount(tx,`SYSTEM:REAL:TRADING_FEES:${settlementCurrency}`,`REAL simulated trading fees ${settlementCurrency}`,settlementCurrency,AccountMode.REAL):null;
 let sellPositions:Awaited<ReturnType<typeof tx.position.findMany>>=[];
 let treasuryProfit=new Prisma.Decimal(0);
 let treasuryAccount:Awaited<ReturnType<typeof ensureSystemAccount>>|null=null;
 if(order.side===OrderSide.SELL){
  sellPositions=await tx.position.findMany({where:{userId:order.userId,instrumentId:order.instrumentId,accountMode:AccountMode.REAL,providerName:null,status:'OPEN',side:OrderSide.BUY,OR:[{settlementCurrency},{settlementCurrency:null}],...(specificPositionId?{id:specificPositionId}:{})},orderBy:{openedAt:'asc'}});
  let leftToMatch=quantity;
  for(const position of sellPositions){
   if(leftToMatch.isZero())break;
   const matched=Prisma.Decimal.min(leftToMatch,position.quantity);
   if(matched.lte(0))continue;
   const allocatedFee=fee.mul(matched).div(quantity);
   treasuryProfit=treasuryProfit.plus(realizedSpotPnl(position.entryPrice,fillPrice,matched,allocatedFee));
   leftToMatch=leftToMatch.minus(matched);
  }
  if(!leftToMatch.isZero())throw new Error('INSUFFICIENT_POSITION');
  treasuryProfit=Prisma.Decimal.max(treasuryProfit,new Prisma.Decimal(0));
  if(treasuryProfit.gt(0)){
   treasuryAccount=await ensureSystemAccount(tx,`SYSTEM:REAL:TREASURY:${settlementCurrency}`,`REAL internal treasury ${settlementCurrency}`,settlementCurrency,AccountMode.REAL);
   await tx.$queryRaw`SELECT "id" FROM "LedgerAccount" WHERE "id" = ${treasuryAccount.id} FOR UPDATE`;
   if((await getTreasuryAvailable(tx,settlementCurrency)).lt(treasuryProfit))throw new Error('INSUFFICIENT_TREASURY_BALANCE');
  }
 }
 const entries:Prisma.LedgerEntryCreateWithoutTransactionInput[]=[];
 if(order.side===OrderSide.BUY){
  entries.push(
   {account:{connect:{id:quoteAccount.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:notional},
   {account:{connect:{id:quoteClearing.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:notional},
   {account:{connect:{id:baseClearing.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:quantity},
   {account:{connect:{id:baseAccount.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:quantity},
  );
  if(fee.gt(0)&&feeAccount)entries.push(
   {account:{connect:{id:quoteAccount.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:fee},
   {account:{connect:{id:feeAccount.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:fee},
  );
 }else{
  const netProceeds=notional.minus(fee);
  if(netProceeds.lte(0))throw new Error('INVALID_NET_PROCEEDS');
  entries.push(
   {account:{connect:{id:baseAccount.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:quantity},
   {account:{connect:{id:baseClearing.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:quantity},
   {account:{connect:{id:quoteClearing.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:notional.minus(treasuryProfit)},
   {account:{connect:{id:quoteAccount.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:netProceeds},
  );
  if(treasuryProfit.gt(0)&&treasuryAccount)entries.push(
   {account:{connect:{id:treasuryAccount.id}},accountMode:AccountMode.REAL,type:EntryType.DEBIT,amount:treasuryProfit},
  );
  if(fee.gt(0)&&feeAccount)entries.push(
   {account:{connect:{id:feeAccount.id}},accountMode:AccountMode.REAL,type:EntryType.CREDIT,amount:fee},
  );
 }
 await tx.ledgerTransaction.create({data:{
  reference:`REAL:SIMULATED_TRADE:${order.side}:${order.id}:${executionId}`,
  description:`REAL internal simulated ${order.side.toLowerCase()} ${instrument.symbol} · ${settlementCurrency}`,
  accountMode:AccountMode.REAL,entries:{create:entries},
 }});

 if(order.side===OrderSide.BUY){
  const position=await tx.position.findFirst({where:{userId:order.userId,instrumentId:order.instrumentId,accountMode:AccountMode.REAL,providerName:null,status:'OPEN',side:OrderSide.BUY},orderBy:{openedAt:'asc'}});
  const basis=notional.plus(fee);
  if(position){
   const entryPrice=averageEntryPrice(position.quantity,position.entryPrice,quantity,fillPrice,fee);
   await tx.position.update({where:{id:position.id},data:{quantity:{increment:quantity},entryPrice,margin:{increment:basis},settlementCurrency}});
  }else{
   const entryPrice=averageEntryPrice(new Prisma.Decimal(0),new Prisma.Decimal(0),quantity,fillPrice,fee);
   await tx.position.create({data:{userId:order.userId,instrumentId:order.instrumentId,accountMode:AccountMode.REAL,side:OrderSide.BUY,quantity,entryPrice,leverage:1,margin:basis,status:'OPEN',settlementCurrency}});
  }
 }else{
  let leftToMatch=quantity;
  for(const position of sellPositions){
   if(leftToMatch.isZero())break;
   const matched=Prisma.Decimal.min(leftToMatch,position.quantity);
   if(matched.lte(0))continue;
   const allocatedFee=fee.mul(matched).div(quantity);
   const realized=realizedSpotPnl(position.entryPrice,fillPrice,matched,allocatedFee);
   const left=position.quantity.minus(matched);
   const basisReduction=position.margin.mul(matched).div(position.quantity);
   await tx.position.update({where:{id:position.id},data:left.isZero()
    ?{quantity:0,status:'CLOSED',closedAt:new Date(),margin:0,realizedPnl:{increment:realized},settlementCurrency}
    :{quantity:left,margin:position.margin.minus(basisReduction),realizedPnl:{increment:realized},settlementCurrency}});
   leftToMatch=leftToMatch.minus(matched);
  }
  if(specificPositionId&&!leftToMatch.isZero())throw new Error('POSITION_NOT_FOUND');
 }

 await tx.execution.create({data:{id:executionId,orderId:order.id,accountMode:AccountMode.REAL,quantity,price:fillPrice,fee,settlementCurrency}});
 const filledQuantity=order.filledQuantity.plus(quantity);
 const averageFillPrice=order.filledQuantity.isZero()?fillPrice:
  order.averageFillPrice!.mul(order.filledQuantity).plus(fillPrice.mul(quantity)).div(filledQuantity);
 const status=filledQuantity.eq(order.quantity)?OrderStatus.FILLED:OrderStatus.PARTIALLY_FILLED;
 const updated=await tx.order.update({where:{id:order.id},data:{
  filledQuantity,averageFillPrice,fee:{increment:fee},status,settlementCurrency,
 },include:{executions:true,instrument:true}});
 await tx.auditLog.create({data:{actorId:order.userId,action:`REAL_SIMULATED_ORDER_${order.side}_FILLED`,entity:'ORDER',entityId:order.id,metadata:{
  oldState:order.status,newState:status,accountMode:AccountMode.REAL,simulated:true,executionProvider:'AUREVIA_INTERNAL',
  instrument:instrument.symbol,baseAsset,settlementCurrency,quantity:quantity.toString(),fillPrice:fillPrice.toString(),fee:fee.toString(),
 } }});
 await createNotification(tx,{userId:order.userId,type:NotificationType.TRADE,title:`REAL simulated order ${status.toLowerCase().replaceAll('_',' ')}`,message:`Your ${order.side.toLowerCase()} order for ${instrument.symbol} was filled ${quantity.toString()} at ${fillPrice.toString()} ${settlementCurrency} in Aurevia's internal simulated trading engine. No external exchange order was placed.`,dedupeKey:`real-order:${order.id}:${filledQuantity.toString()}`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/orders'});
 return updated;
}

export async function placeRealOrder(userId:string,input:PlaceOrderInput,idempotencyKey:string,options:{requireExpectedPriceMatch?:boolean;validatedQuote?:ValidatedTwelveDataQuote}={}){
 if(!Number.isFinite(input.quantity)||input.quantity<=0||input.quantity>1_000_000_000||new Prisma.Decimal(input.quantity).decimalPlaces()>10)throw new Error('INVALID_QUANTITY');
 if(!Number.isFinite(input.expectedPrice)||input.expectedPrice<=0)throw new Error('INVALID_PRICE');
 assertFreshQuote(input.observedAt);
 if(input.type===OrderType.LIMIT&&(!Number.isFinite(input.price)||Number(input.price)<=0))throw new Error('LIMIT_PRICE_REQUIRED');
 if(input.type===OrderType.STOP&&(!Number.isFinite(input.stopPrice)||Number(input.stopPrice)<=0))throw new Error('STOP_PRICE_REQUIRED');
 const priorOrder=await db.order.findUnique({where:{idempotencyKey},include:{executions:true,instrument:true}});
 if(priorOrder){
  if(priorOrder.providerName||!matchesOrder(priorOrder,userId,AccountMode.REAL,input))throw new Error('IDEMPOTENCY_KEY_REUSED');
  return priorOrder;
 }
 const instrumentForQuote=await db.instrument.findUnique({where:{id:input.instrumentId},select:{symbol:true}});
 if(!instrumentForQuote)throw new Error('INSTRUMENT_UNAVAILABLE');
 const quote=options.validatedQuote??await resolveTwelveDataExecutionQuote(instrumentForQuote.symbol);
 assertFreshQuote(quote.updatedAt);
 if(options.requireExpectedPriceMatch){
  if(!new Prisma.Decimal(input.expectedPrice).equals(new Prisma.Decimal(quote.price)))throw new Error('STALE_MARKET_QUOTE');
  if(Math.abs(Date.parse(input.observedAt)-Date.parse(quote.updatedAt))>5_000)throw new Error('STALE_MARKET_QUOTE');
 }
 const create=()=>db.$transaction(async tx=>{
  const prior=await tx.order.findUnique({where:{idempotencyKey},include:{executions:true,instrument:true}});
  if(prior){
   if(prior.providerName||!matchesOrder(prior,userId,AccountMode.REAL,input))throw new Error('IDEMPOTENCY_KEY_REUSED');
   return prior;
  }
  const user=await tx.user.findUnique({where:{id:userId},select:{id:true,accountMode:true,status:true,accountRestricted:true,role:true,bankAccount:{select:{status:true}}}});
  if(!user||user.role!=='USER'||user.status!=='ACTIVE'||user.accountMode!==AccountMode.REAL||user.accountRestricted)throw new Error('ORDER_ACCOUNT_UNAVAILABLE');
  if(user.bankAccount&&(user.bankAccount.status==='FROZEN'||user.bankAccount.status==='CLOSED'))throw new Error('REAL_BANK_ACCOUNT_UNAVAILABLE');
  const instrument=await tx.instrument.findUnique({where:{id:input.instrumentId}});
  if(!instrument||!instrument.enabled)throw new Error('INSTRUMENT_UNAVAILABLE');
  if(!instrument.takerFee.isFinite()||instrument.takerFee.lt(0)||instrument.takerFee.gte(1))throw new Error('INSTRUMENT_FEE_INVALID');
  const settlementCurrency=instrument.quoteAsset.trim().toUpperCase();
  const baseAsset=instrument.baseAsset.trim().toUpperCase();
  if(!/^[A-Z0-9]{2,8}$/.test(settlementCurrency)||!/^[A-Z0-9]{2,8}$/.test(baseAsset)||settlementCurrency===baseAsset)throw new Error('INSTRUMENT_CURRENCY_UNAVAILABLE');
  const market=quote.price;
  if(options.requireExpectedPriceMatch&&!new Prisma.Decimal(input.expectedPrice).equals(new Prisma.Decimal(market)))throw new Error('STALE_MARKET_QUOTE');
  const reservePrice=input.type===OrderType.LIMIT?new Prisma.Decimal(input.price!):
   input.type===OrderType.STOP?new Prisma.Decimal(input.stopPrice!):new Prisma.Decimal(market);
  const quantity=new Prisma.Decimal(input.quantity);
  await lockRealWalletCurrencies(tx,userId,[settlementCurrency,baseAsset]);
  const quoteAccount=await tx.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${userId}:${AccountMode.REAL}:${settlementCurrency}`}});
  const baseAccount=await tx.ledgerAccount.findUniqueOrThrow({where:{code:`USER:${userId}:${AccountMode.REAL}:${baseAsset}`}});
  if(input.side===OrderSide.BUY){
   const reservations=await getRealWalletReservations(tx,userId,settlementCurrency);
   const walletBalance=await balance(tx,quoteAccount.id);
   const available=availableWalletAmount(walletBalance,reservations);
   const reserveNotional=roundWalletAmount(settlementCurrency,quantity.mul(reservePrice));
   const reserveFee=roundWalletAmount(settlementCurrency,reserveNotional.mul(instrument.takerFee));
   assertMinimumUsdNotional(quantity,new Prisma.Decimal(market));
   if(available.lt(reserveNotional.plus(reserveFee)))throw new Error('INSUFFICIENT_REAL_WALLET_COLLATERAL');
  }else{
   const reservations=await getRealWalletReservations(tx,userId,baseAsset);
   const assetBalance=await balance(tx,baseAccount.id);
   const available=availableWalletAmount(assetBalance,reservations);
   if(available.lt(quantity))throw new Error('INSUFFICIENT_POSITION');
   if(!available.eq(quantity))assertMinimumUsdNotional(quantity,new Prisma.Decimal(market));
  }
  const reservedAmount=input.side===OrderSide.BUY
   ?roundWalletAmount(settlementCurrency,quantity.mul(reservePrice).plus(roundWalletAmount(settlementCurrency,quantity.mul(reservePrice).mul(instrument.takerFee))))
   :null;
  const order=await tx.order.create({data:{
   userId,instrumentId:instrument.id,accountMode:AccountMode.REAL,side:input.side,type:input.type,
   quantity,price:input.price,stopPrice:input.stopPrice,idempotencyKey,status:OrderStatus.OPEN,
   providerReservedAmount:reservedAmount,settlementCurrency,
  },include:{executions:true,instrument:true}});
  await tx.auditLog.create({data:{actorId:userId,action:'REAL_SIMULATED_ORDER_SUBMITTED',entity:'ORDER',entityId:order.id,metadata:{
   newState:OrderStatus.OPEN,accountMode:AccountMode.REAL,simulated:true,executionProvider:'AUREVIA_INTERNAL',
   instrument:instrument.symbol,baseAsset,settlementCurrency,side:input.side,type:input.type,
   quantity:order.quantity.toString(),expectedPrice:input.expectedPrice,observedAt:input.observedAt,
   providerQuote:quote.price,providerTimestamp:quote.updatedAt,
   reservedAmount:reservedAmount?.toString()??null,reservationCurrency:input.side===OrderSide.BUY?settlementCurrency:baseAsset,
  }}});
  await createNotification(tx,{userId,type:NotificationType.TRADE,title:'REAL simulated order submitted',message:`Your ${input.side.toLowerCase()} ${input.type.toLowerCase()} order for ${instrument.symbol} was submitted to Aurevia's internal simulated trading engine. No external exchange order will be placed.`,dedupeKey:`real-order:${order.id}:submitted`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/orders'});
  if(!executable(input.type,input.side,market,input.price,input.stopPrice))return order;
  return executeRealOrderTx(tx,order.id,market,quantity,undefined,quote.updatedAt);
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
 try{return await create();}
 catch(error){
  if(error&&typeof error==='object'&&'code'in error&&['P2002','P2034'].includes(String(error.code))){
   const prior=await db.order.findUnique({where:{idempotencyKey},include:{executions:true,instrument:true}});
   if(prior&&!prior.providerName&&matchesOrder(prior,userId,AccountMode.REAL,input))return prior;
   if(prior)throw new Error('IDEMPOTENCY_KEY_REUSED');
  }
  throw error;
 }
}

export async function closeSimulatedPositionTx(tx:Prisma.TransactionClient,userId:string,positionId:string,actorId=userId,accountMode?:AccountMode,validatedQuote?:ValidatedTwelveDataQuote){
 const realCloseKey=`REAL:POSITION_CLOSE:${positionId}`;
 const position=await tx.position.findFirst({where:{id:positionId,userId,status:'OPEN',...(accountMode?{accountMode}:{})},include:{instrument:true}});
 if(!position){
  if(accountMode!==AccountMode.DEMO){
   const previousRealClose=await tx.order.findUnique({where:{idempotencyKey:realCloseKey}});
   if(previousRealClose){
    if(previousRealClose.userId!==userId||previousRealClose.accountMode!==AccountMode.REAL||previousRealClose.providerName)throw new Error('IDEMPOTENCY_KEY_REUSED');
    return tx.position.findUniqueOrThrow({where:{id:positionId}});
   }
  }
  throw new Error('POSITION_NOT_FOUND');
 }
 if(position.providerName===LEGACY_EXTERNAL_PROVIDER)throw new Error('PROVIDER_POSITION_REQUIRES_PROVIDER_ORDER');
 if(position.accountMode===AccountMode.REAL){
  if(position.side!==OrderSide.BUY)throw new Error('UNSUPPORTED_REAL_POSITION_SIDE');
  const previousRealClose=await tx.order.findUnique({where:{idempotencyKey:realCloseKey}});
  if(previousRealClose){
   if(previousRealClose.userId!==userId||previousRealClose.accountMode!==AccountMode.REAL||previousRealClose.providerName)throw new Error('IDEMPOTENCY_KEY_REUSED');
   return tx.position.findUniqueOrThrow({where:{id:positionId}});
  }
  const quote=validatedQuote??await resolveTwelveDataExecutionQuote(position.instrument.symbol);
  const settlementCurrency=(position.settlementCurrency||position.instrument.quoteAsset).trim().toUpperCase();
  const closingOrder=await tx.order.create({data:{
   userId,instrumentId:position.instrumentId,accountMode:AccountMode.REAL,side:OrderSide.SELL,type:OrderType.MARKET,
   status:OrderStatus.OPEN,quantity:position.quantity,filledQuantity:0,idempotencyKey:realCloseKey,settlementCurrency,
  }});
  await executeRealOrderTx(tx,closingOrder.id,quote.price,position.quantity,position.id,quote.updatedAt);
  const closed=await tx.position.findUniqueOrThrow({where:{id:position.id}});
  await tx.auditLog.create({data:{actorId,action:`REAL_SIMULATED_POSITION_${actorId===userId?'CLOSED':'ADMIN_CLOSED'}`,entity:'POSITION',entityId:position.id,metadata:{
   accountMode:AccountMode.REAL,simulated:true,symbol:position.instrument.symbol,quantity:position.quantity.toString(),
   exitPrice:quote.price.toString(),providerTimestamp:quote.updatedAt,settlementCurrency,closingOrderId:closingOrder.id,
  }}});
  return closed;
 }
 const price=position.instrument.price;
 if(price.lte(0))throw new Error('INVALID_PRICE');
 const userAccount=await ensureUserLedger(tx,userId,position.accountMode);
 let pnl:Prisma.Decimal;
 let fee=new Prisma.Decimal(0);
 if(position.side===OrderSide.BUY){
  const quantity=position.quantity;
  const proceeds=roundUsdAmount(price.mul(quantity));
  fee=roundUsdAmount(proceeds.mul(position.instrument.takerFee));
  const clearing=await ensureSystemAccount(tx,`SYSTEM:${position.accountMode}:CLEARING`,'DEMO spot clearing','USD',position.accountMode);
  const fees=await ensureSystemAccount(tx,`SYSTEM:${position.accountMode}:FEES`,'DEMO trading fees','USD',position.accountMode);
  await postDoubleEntry(tx,{reference:`${position.accountMode}:POSITION_CLOSE:${position.id}`,description:`DEMO sale of ${position.instrument.symbol}`,debitAccountId:clearing.id,creditAccountId:userAccount.id,amount:proceeds});
  if(fee.gt(0))await postDoubleEntry(tx,{reference:`${position.accountMode}:POSITION_CLOSE_FEE:${position.id}`,description:`DEMO ${position.instrument.symbol} closing fee`,debitAccountId:userAccount.id,creditAccountId:fees.id,amount:fee});
  pnl=realizedSpotPnl(position.entryPrice,price,quantity,fee);
 }else{
  const clearing=await ensureSystemAccount(tx,`SYSTEM:${position.accountMode}:CLEARING`,'DEMO clearing','USD',position.accountMode);
  pnl=position.entryPrice.minus(price).mul(position.quantity);
  const settlement=position.margin.plus(pnl);
  if(settlement.lte(0))throw new Error('POSITION_LIQUIDATED');
  await postDoubleEntry(tx,{reference:`${position.accountMode}:LEGACY_POSITION_CLOSE:${position.id}`,description:'DEMO legacy position close',debitAccountId:clearing.id,creditAccountId:userAccount.id,amount:settlement});
 }
 const closingOrder=await tx.order.create({data:{
  userId,
  instrumentId:position.instrumentId,
  accountMode:position.accountMode,
  side:position.side===OrderSide.BUY?OrderSide.SELL:OrderSide.BUY,
  type:OrderType.MARKET,
  status:OrderStatus.FILLED,
  quantity:position.quantity,
  filledQuantity:position.quantity,
  averageFillPrice:price,
  fee,
  idempotencyKey:`POSITION_CLOSE:${position.id}:${randomUUID()}`,
 }});
 await tx.execution.create({data:{orderId:closingOrder.id,accountMode:position.accountMode,quantity:position.quantity,price,fee}});
 const closed=await tx.position.update({where:{id:position.id},data:{status:'CLOSED',closedAt:new Date(),margin:0,realizedPnl:{increment:pnl}}});
 await tx.auditLog.create({data:{actorId,action:`${position.accountMode}_SIMULATED_POSITION_${actorId===userId?'CLOSED':'ADMIN_CLOSED'}`,entity:'POSITION',entityId:position.id,metadata:{accountMode:position.accountMode,simulated:true,symbol:position.instrument.symbol,quantity:position.quantity.toString(),exitPrice:price.toString(),realizedPnl:pnl.toString(),closingOrderId:closingOrder.id}}});
 await tx.auditLog.create({data:{actorId,action:`${position.accountMode==='DEMO'?'DEMO':'REAL_SIMULATED'}_ORDER_${closingOrder.side}_FILLED`,entity:'ORDER',entityId:closingOrder.id,metadata:{oldState:OrderStatus.OPEN,newState:OrderStatus.FILLED,accountMode:position.accountMode,simulated:true,positionId:position.id,instrument:position.instrument.symbol,quantity:position.quantity.toString(),fillPrice:price.toString(),fee:fee.toString()}}});
 await createNotification(tx,{userId,type:NotificationType.TRADE,title:`${position.accountMode} position closed`,message:`Your ${position.instrument.symbol} position was closed by an internal ${position.accountMode==='DEMO'?'DEMO':'PAPER'} ${closingOrder.side.toLowerCase()} order. No external order was placed.`,dedupeKey:`order:${closingOrder.id}:filled`,relatedEntity:'ORDER',relatedId:closingOrder.id,actionUrl:'/trade'});
 return closed;
}

export async function placeOrder(userId:string,accountMode:AccountMode,input:PlaceOrderInput,idempotencyKey:string){
 if(accountMode===AccountMode.REAL)return placeRealOrder(userId,input,idempotencyKey,{requireExpectedPriceMatch:true});
 if(!Number.isFinite(input.quantity)||input.quantity<=0||input.quantity>1_000_000_000)throw new Error('INVALID_QUANTITY');
 if(!Number.isFinite(input.expectedPrice)||input.expectedPrice<=0)throw new Error('INVALID_PRICE');
 assertFreshQuote(input.observedAt);
 if(input.type===OrderType.LIMIT&&(!Number.isFinite(input.price)||Number(input.price)<=0))throw new Error('LIMIT_PRICE_REQUIRED');
 if(input.type===OrderType.STOP&&(!Number.isFinite(input.stopPrice)||Number(input.stopPrice)<=0))throw new Error('STOP_PRICE_REQUIRED');
 const create=()=>db.$transaction(async tx=>{
   const activeUser=await tx.user.findUnique({where:{id:userId},select:{accountMode:true,status:true,role:true}});
   if(!activeUser||activeUser.status!=='ACTIVE'||activeUser.role!=='USER')throw new Error('ORDER_ACCOUNT_UNAVAILABLE');
   if(activeUser.accountMode!==accountMode)throw new Error('ACCOUNT_MODE_CHANGED');
   const prior=await tx.order.findUnique({where:{idempotencyKey},include:{executions:true,instrument:true}});
   if(prior){if(!matchesOrder(prior,userId,accountMode,input))throw new Error('IDEMPOTENCY_KEY_REUSED');return prior;}
   const inst=await tx.instrument.findUnique({where:{id:input.instrumentId}}); if(!inst||!inst.enabled)throw new Error('INSTRUMENT_UNAVAILABLE');
   if(inst.updatedAt.getTime()>Date.now()+5_000)throw new Error('STALE_MARKET_QUOTE');
   if(accountMode===AccountMode.DEMO&&Date.now()-inst.updatedAt.getTime()>getDemoAiConfig().maxQuoteAgeMs)throw new Error('STALE_MARKET_QUOTE');
   const market=Number(inst.price); const price=input.price===undefined?undefined:Number(input.price); const stop=input.stopPrice===undefined?undefined:Number(input.stopPrice);
   const quantity=new Prisma.Decimal(input.quantity);
   if(accountMode===AccountMode.DEMO&&input.side===OrderSide.BUY){
    const config=getDemoAiConfig();
    const existingPosition=await tx.position.findFirst({where:{userId,instrumentId:inst.id,accountMode,status:'OPEN',side:OrderSide.BUY},select:{quantity:true}});
    const currentExposure=(existingPosition?.quantity??new Prisma.Decimal(0)).mul(inst.price);
    const executionCostBps=config.slippageBps+config.spreadBps/2;
    const proposedExecutionPrice=inst.price.mul(new Prisma.Decimal(1).plus(new Prisma.Decimal(executionCostBps).div(10_000)));
    const proposedExposure=new Prisma.Decimal(input.quantity).mul(proposedExecutionPrice);
    if(currentExposure.plus(proposedExposure).gt(config.maxPositionUsd))throw new Error('DEMO_POSITION_LIMIT');
   }
   if(input.side===OrderSide.BUY){
    assertMinimumUsdNotional(quantity,inst.price);
   }else{
    const position=await tx.position.findFirst({where:{userId,instrumentId:inst.id,accountMode,status:'OPEN',side:OrderSide.BUY}});
    const reservations=await tx.order.aggregate({where:{userId,instrumentId:inst.id,accountMode,side:OrderSide.SELL,status:OrderStatus.OPEN},_sum:{quantity:true}});
    const owned=position?.quantity??new Prisma.Decimal(0);
    const reserved=reservations._sum.quantity??new Prisma.Decimal(0);
    assertSellableQuantity(owned,reserved,quantity);
    if(!owned.minus(reserved).eq(quantity))assertMinimumUsdNotional(quantity,inst.price);
   }
  const order=await tx.order.create({data:{userId,instrumentId:inst.id,accountMode,side:input.side,type:input.type,quantity:input.quantity,price,stopPrice:stop,idempotencyKey,status:OrderStatus.OPEN}});
  await tx.auditLog.create({data:{actorId:userId,action:`${accountMode}_SIMULATED_ORDER_SUBMITTED`,entity:'ORDER',entityId:order.id,metadata:{newState:OrderStatus.OPEN,accountMode,simulated:true,instrumentId:inst.id,side:input.side,type:input.type,quantity:order.quantity.toString(),expectedPrice:input.expectedPrice,observedAt:input.observedAt}}});
  await createNotification(tx,{userId,type:NotificationType.TRADE,title:`${accountMode} order submitted`,message:`Your ${input.side.toLowerCase()} ${input.type.toLowerCase()} order for ${inst.symbol} was submitted to the internal paper-trading engine.`,dedupeKey:`order:${order.id}:submitted`,relatedEntity:'ORDER',relatedId:order.id,actionUrl:'/trade'});
   if(!executable(input.type,input.side,market,price,stop))return order;
   return executeOrderTx(tx,order.id,market);
 },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
 try{return await create();}
 catch(error){
  if(error&&typeof error==='object'&&'code'in error&&['P2002','P2034'].includes(String(error.code))){
   const existing=await db.order.findUnique({where:{idempotencyKey},include:{executions:true,instrument:true}});
   if(existing&&matchesOrder(existing,userId,accountMode,input))return existing;
   if(existing)throw new Error('IDEMPOTENCY_KEY_REUSED');
  }
  throw error;
 }
}

export async function processOpenOrders(){
 const orders=await db.order.findMany({where:{status:{in:[OrderStatus.OPEN,OrderStatus.PARTIALLY_FILLED]},providerName:null,accountMode:{in:[AccountMode.DEMO,AccountMode.REAL]}},include:{instrument:true},take:500,orderBy:{createdAt:'asc'}});
 for(const o of orders){
   let p=Number(o.instrument.price);
   let quoteTimestamp:string|undefined;
   if(o.accountMode===AccountMode.REAL){
    try{
     const quote=await resolveTwelveDataExecutionQuote(o.instrument.symbol);
     p=quote.price;
     quoteTimestamp=quote.updatedAt;
    }catch{
     continue;
    }
   }
   const hit=executable(o.type,o.side,p,o.price===null?undefined:Number(o.price),o.stopPrice===null?undefined:Number(o.stopPrice));
   if(!hit)continue;
  try{await db.$transaction(tx=>o.accountMode===AccountMode.REAL?executeRealOrderTx(tx,o.id,p,undefined,undefined,quoteTimestamp):executeOrderTx(tx,o.id,p),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});}
  catch(e){if(e instanceof Error&&['INSUFFICIENT_SIMULATED_BALANCE','INSUFFICIENT_REAL_WALLET_COLLATERAL','INSUFFICIENT_POSITION','ORDER_NOT_OPEN','ORDER_FILLED'].includes(e.message))await db.$transaction(async tx=>{const rejected=await tx.order.updateMany({where:{id:o.id,status:{in:[OrderStatus.OPEN,OrderStatus.PARTIALLY_FILLED]}},data:{status:OrderStatus.REJECTED}});if(rejected.count){await tx.auditLog.create({data:{actorId:o.userId,action:`${o.accountMode}_SIMULATED_ORDER_REJECTED`,entity:'ORDER',entityId:o.id,metadata:{oldState:o.status,newState:OrderStatus.REJECTED,accountMode:o.accountMode,simulated:true,reason:e.message}}});await createNotification(tx,{userId:o.userId,type:NotificationType.TRADE,title:`${o.accountMode} order rejected`,message:`Your ${o.side.toLowerCase()} order for ${o.instrument.symbol} was rejected in the ${o.accountMode===AccountMode.DEMO?'DEMO':'REAL'} account. Any completed partial fills remain recorded in your Aurevia wallet.`,dedupeKey:`order:${o.id}:rejected`,relatedEntity:'ORDER',relatedId:o.id,actionUrl:'/trade'});}});}
 }
}
