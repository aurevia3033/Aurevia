import {NextResponse} from 'next/server';
import {getFreeMarketQuote,getFreeMarketQuotes} from '@/lib/free-market-quotes';
import {requireUser} from '@/lib/auth';

export const dynamic='force-dynamic';

/** Authenticated free-quote lookup — no paid API keys required. */
export async function GET(request:Request){
	try{
		await requireUser();
		const {searchParams}=new URL(request.url);
		const symbol=searchParams.get('symbol')?.trim();
		const symbols=searchParams.get('symbols')?.split(',').map(s=>s.trim()).filter(Boolean)??[];
		if(symbols.length){
			const map=await getFreeMarketQuotes(symbols.slice(0,20));
			return NextResponse.json({
				quotes:Object.fromEntries([...map.entries()]),
			},{headers:{'Cache-Control':'private, max-age=30'}});
		}
		if(!symbol)return NextResponse.json({error:'Provide symbol or symbols.'},{status:400});
		const quote=await getFreeMarketQuote(symbol);
		if(!quote)return NextResponse.json({error:'No free quote available for this symbol.'},{status:404});
		return NextResponse.json(quote,{headers:{'Cache-Control':'private, max-age=30'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		return NextResponse.json({error:'Free market quote is temporarily unavailable.'},{status:503});
	}
}
