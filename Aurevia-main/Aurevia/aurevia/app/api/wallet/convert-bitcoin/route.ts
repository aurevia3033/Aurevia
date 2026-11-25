import {AccountMode,Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {assertFreshQuote} from '@/lib/trading-policy';
import {calculateSimulatedBitcoinConversion} from '@/lib/simulated-bitcoin';
import {placeRealOrder,resolveTwelveDataExecutionQuote} from '@/lib/orders';
import {rateLimit} from '@/lib/rate-limit';
import {jsonSafe} from '@/lib/serializers';
import {roundWalletAmount} from '@/lib/real-wallet-reservations';

const amountSchema=z.string().trim().min(1).max(32).regex(/^\d+(?:\.\d{1,10})?$/);
const postSchema=z.object({
	direction:z.enum(['BUY','SELL']),
	amount:amountSchema,
	confirmed:z.literal(true),
	referencePrice:z.string().trim().min(1).max(32).regex(/^\d+(?:\.\d{1,10})?$/),
	observedAt:z.string().datetime(),
});
const quoteFreshnessMs=30_000;

async function getRealBitcoinInstrument(){
	const instrument=await db.instrument.findUnique({where:{symbol:'BTC/USD'}});
	if(!instrument?.enabled)throw new Error('BITCOIN_INSTRUMENT_UNAVAILABLE');
	return instrument;
}

function preview(direction:'BUY'|'SELL',amount:Prisma.Decimal,price:Prisma.Decimal,feeRate:Prisma.Decimal){
	const conversion=calculateSimulatedBitcoinConversion(direction,amount,price,feeRate);
	const quantity=direction==='BUY'?conversion.bitcoinAmount:amount;
	const notional=roundWalletAmount('USD',price.mul(quantity));
	const fee=roundWalletAmount('USD',notional.mul(feeRate));
	if(quantity.lte(0)||notional.lte(0)||fee.gte(notional))throw new Error('INVALID_CONVERSION');
	return {
		direction,
		sourceAsset:direction==='BUY'?'USD':'BTC',
		destinationAsset:direction==='BUY'?'BTC':'USD',
		rate:price,
		rateCurrency:'USD/BTC',
		sourceAmount:direction==='BUY'?notional.plus(fee):amount,
		fee,
		feeCurrency:'USD',
		finalAmount:direction==='BUY'?quantity:notional.minus(fee),
		finalCurrency:direction==='BUY'?'BTC':'USD',
		observedAt:null as string|null,
		priceSource:'Twelve Data',
		simulated:true,
	};
}

export async function GET(request:Request){
	try{
		const user=await requireUser();
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.role!=='USER')return NextResponse.json({error:'This account cannot preview conversions.'},{status:403});
		if(currentUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Bitcoin conversion is available only in REAL mode.'},{status:403});
		rateLimit(`bitcoin-conversion-preview:${user.id}`,20,60_000);
		const parameters=new URL(request.url).searchParams;
		const parsed=z.object({direction:z.enum(['BUY','SELL']),amount:amountSchema}).parse({
			direction:parameters.get('direction'),amount:parameters.get('amount'),
		});
		const amount=new Prisma.Decimal(parsed.amount);
		if(!amount.isFinite()||amount.lte(0)||amount.gt(1_000_000_000))return NextResponse.json({error:'Enter a valid conversion amount.'},{status:400});
		if(parsed.direction==='BUY'&&amount.decimalPlaces()>2)return NextResponse.json({error:'USD buy amounts must be entered to the nearest cent.'},{status:400});
		const instrument=await getRealBitcoinInstrument();
		const quote=await resolveTwelveDataExecutionQuote(instrument.symbol);
		try{assertFreshQuote(quote.updatedAt)}catch{throw new Error('STALE_MARKET_QUOTE')}
		const result=preview(parsed.direction,amount,new Prisma.Decimal(quote.price),instrument.takerFee);
		return NextResponse.json({...jsonSafe(result),observedAt:quote.updatedAt},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid conversion direction and amount.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Conversion previews are temporarily limited.'},{status:429});
		if(error instanceof Error&&error.message==='STALE_MARKET_QUOTE')return NextResponse.json({error:'The Bitcoin simulated quote is stale. Refresh and preview again.'},{status:503});
		if(error instanceof Error&&error.message==='BITCOIN_INSTRUMENT_UNAVAILABLE')return NextResponse.json({error:'Bitcoin is not currently available for trading.'},{status:409});
		return NextResponse.json({error:'Unable to create a conversion preview.'},{status:503});
	}
}

export async function POST(request:Request){
	try{
		const user=await requireUser();
		const input=postSchema.parse(await request.json());
		const idempotencyKey=request.headers.get('Idempotency-Key')||'';
		if(!/^[a-zA-Z0-9_-]{12,48}$/.test(idempotencyKey))return NextResponse.json({error:'A valid idempotency key is required.'},{status:400});
		const currentUser=await db.user.findUnique({where:{id:user.id},select:{accountMode:true,status:true,role:true}});
		if(!currentUser||currentUser.status!=='ACTIVE'||currentUser.role!=='USER')return NextResponse.json({error:'This account cannot submit conversion orders.'},{status:403});
		if(currentUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Bitcoin conversion is available only in REAL mode.'},{status:403});
		rateLimit(`bitcoin-conversion:${user.id}`,5,60_000);

		const amount=new Prisma.Decimal(input.amount);
		const previewPrice=new Prisma.Decimal(input.referencePrice);
		if(!amount.isFinite()||amount.lte(0)||amount.gt(1_000_000_000)||!previewPrice.isFinite()||previewPrice.lte(0))return NextResponse.json({error:'Enter a valid conversion amount and quote.'},{status:400});
		if(input.direction==='BUY'&&amount.decimalPlaces()>2)return NextResponse.json({error:'USD buy amounts must be entered to the nearest cent.'},{status:400});
		try{assertFreshQuote(input.observedAt)}catch{throw new Error('STALE_MARKET_QUOTE')}

		const instrument=await getRealBitcoinInstrument();
		const quote=await resolveTwelveDataExecutionQuote(instrument.symbol);
		try{assertFreshQuote(quote.updatedAt)}catch{throw new Error('STALE_MARKET_QUOTE')}
		const quoteAge=Math.abs(Date.parse(quote.updatedAt)-Date.parse(input.observedAt));
		if(!Number.isFinite(quoteAge)||quoteAge>quoteFreshnessMs||!new Prisma.Decimal(quote.price).equals(previewPrice))throw new Error('CONVERSION_QUOTE_CHANGED');
		const conversion=calculateSimulatedBitcoinConversion(input.direction,amount,new Prisma.Decimal(quote.price),instrument.takerFee);
		const quantity=input.direction==='BUY'?conversion.bitcoinAmount:amount;
		const order=await placeRealOrder(user.id,{
			instrumentId:instrument.id,side:input.direction,type:'MARKET',quantity:quantity.toNumber(),
			expectedPrice:quote.price,observedAt:quote.updatedAt,
		},idempotencyKey,{requireExpectedPriceMatch:true,validatedQuote:quote});
		if(!order)throw new Error('ORDER_SUBMISSION_RETURNED_NO_ORDER');
		return NextResponse.json(jsonSafe({
			order:{id:order.id,status:order.status,side:order.side,type:order.type,quantity:order.quantity,filledQuantity:order.filledQuantity,averageFillPrice:order.averageFillPrice,fee:order.fee,settlementCurrency:order.settlementCurrency},
			...preview(input.direction,amount,new Prisma.Decimal(quote.price),instrument.takerFee),
			observedAt:quote.updatedAt,
			executionProvider:'AUREVIA_INTERNAL_SIMULATION',
			simulated:true,
		}),{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'Enter a valid conversion direction, amount, and explicit confirmation.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Conversion requests are temporarily limited. Try again shortly.'},{status:429});
		if(error instanceof Error&&error.message==='MARKET_QUOTE_UNAVAILABLE')return NextResponse.json({error:'Twelve Data market quote is unavailable. No conversion was executed.'},{status:503});
		if(error instanceof Error&&error.message==='STALE_MARKET_QUOTE')return NextResponse.json({error:'The Bitcoin simulated quote is stale. Refresh and confirm again.'},{status:503});
		if(error instanceof Error&&error.message==='CONVERSION_QUOTE_CHANGED')return NextResponse.json({error:'The Bitcoin price changed after your preview. Review a new quote and confirm again.'},{status:409});
		if(error instanceof Error&&error.message==='BITCOIN_INSTRUMENT_UNAVAILABLE')return NextResponse.json({error:'Bitcoin is not currently available for trading.'},{status:409});
		if(error instanceof Error&&error.message==='INSUFFICIENT_REAL_WALLET_COLLATERAL')return NextResponse.json({error:'Your REAL Aurevia Wallet does not have enough available USD after fees and reservations.'},{status:409});
		if(error instanceof Error&&error.message==='INSUFFICIENT_POSITION')return NextResponse.json({error:'Your REAL Aurevia Wallet does not have enough available BTC to sell.'},{status:409});
		console.error('REAL simulated Bitcoin conversion failed.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to submit the internal simulated Bitcoin order. Please try again later.'},{status:503});
	}
}
