import {NextResponse} from 'next/server';
import {Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {closeSimulatedPositionTx,resolveTwelveDataExecutionQuote,type ValidatedTwelveDataQuote} from '@/lib/orders';
import {jsonSafe} from '@/lib/serializers';
import {LEGACY_EXTERNAL_PROVIDER} from '@/lib/bitcoin-funding';

const closeSchema=z.object({positionId:z.string().min(1),accountMode:z.enum(['DEMO','REAL']).optional()});

export async function GET(request:Request){
 try{
  const user=await requireUser();
  const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
  if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  const requestedMode=new URL(request.url).searchParams.get('accountMode');
  if(requestedMode&&requestedMode!==currentUser.accountMode)return NextResponse.json({error:'Position account mode does not match your active account.'},{status:409});
  const positions=await db.position.findMany({where:{userId:user.id,accountMode:currentUser.accountMode,status:'OPEN'},include:{instrument:true},orderBy:{openedAt:'desc'}});
  const realQuotes= currentUser.accountMode==='REAL'?await Promise.all(positions.map(async position=>{
   try{return {id:position.id,quote:await resolveTwelveDataExecutionQuote(position.instrument.symbol)}}catch{return {id:position.id,quote:null}}
  })):[];
  const quoteByPosition=new Map(realQuotes.map(item=>[item.id,item.quote]));
  return NextResponse.json(jsonSafe(positions.map(position=>{
   const requiresSellOrder=position.providerName===LEGACY_EXTERNAL_PROVIDER;
   if(requiresSellOrder)return {...position,providerName:undefined,requiresSellOrder,currentPrice:null,marketValue:null,unrealizedPnl:null};
   const realQuote=quoteByPosition.get(position.id);
   if(currentUser.accountMode==='REAL'&&!realQuote)return {...position,providerName:undefined,requiresSellOrder:false,currentPrice:null,marketValue:null,unrealizedPnl:null};
   const currentPrice=new Prisma.Decimal(realQuote?.price??(position.instrument.price instanceof Prisma.Decimal?position.instrument.price.toNumber():Number(position.instrument.price)));
   const marketValue=currentPrice.mul(position.quantity);
   const direction=position.side==='BUY'?1:-1;
   const unrealizedPnl=position.entryPrice.mul(-direction).plus(currentPrice.mul(direction)).mul(position.quantity);
   return {...position,providerName:undefined,requiresSellOrder,currentPrice,marketValue,unrealizedPnl};
  })),{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  return NextResponse.json({error:error instanceof Error&&error.message==='UNAUTHORIZED'?'Unauthorized':'Unable to load positions.'},{status:error instanceof Error&&error.message==='UNAUTHORIZED'?401:503});
 }
}

export async function POST(request:Request){
 try{
  const user=await requireUser();
  const {positionId,accountMode}=closeSchema.parse(await request.json());
  const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true}});
  if(!currentUser||currentUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
  if(accountMode&&accountMode!==currentUser.accountMode)return NextResponse.json({error:'Position account mode does not match your active account.'},{status:409});
  let validatedQuote:ValidatedTwelveDataQuote|undefined;
  if(currentUser.accountMode==='REAL'){
   const position=await db.position.findUnique({where:{id:positionId},include:{instrument:true}});
   if(!position||position.userId!==user.id||position.status!=='OPEN')throw new Error('POSITION_NOT_FOUND');
   if(position.providerName===LEGACY_EXTERNAL_PROVIDER)throw new Error('PROVIDER_POSITION_REQUIRES_PROVIDER_ORDER');
   validatedQuote=await resolveTwelveDataExecutionQuote(position.instrument.symbol);
  }
  const closed=await db.$transaction(tx=>closeSimulatedPositionTx(tx,user.id,positionId,user.id,currentUser.accountMode,validatedQuote),{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,maxWait:5_000,timeout:15_000});
  return NextResponse.json(jsonSafe(closed));
 }catch(error){
  if(error instanceof ZodError)return NextResponse.json({error:'Invalid position.'},{status:400});
  if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
  if(error instanceof Error&&error.message==='POSITION_NOT_FOUND')return NextResponse.json({error:'Open position not found.'},{status:404});
  if(error instanceof Error&&error.message==='MARKET_QUOTE_UNAVAILABLE')return NextResponse.json({error:'Twelve Data market quote is unavailable. No position was closed.'},{status:503});
  if(error instanceof Error&&error.message==='PROVIDER_POSITION_REQUIRES_PROVIDER_ORDER')return NextResponse.json({error:'This retained provider-linked position is not backed by a matching Aurevia Wallet asset. Contact support for reconciliation.'},{status:409});
  return NextResponse.json({error:error instanceof Error?error.message:'Close failed'},{status:400});
 }
}
