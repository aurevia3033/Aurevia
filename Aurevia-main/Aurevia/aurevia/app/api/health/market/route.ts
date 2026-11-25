import {NextResponse} from 'next/server';
import {probeFreeMarketProviders} from '@/lib/free-market-quotes';

export const dynamic='force-dynamic';

/**
 * Public market free-provider health — for ops and e2e smoke tests.
 * GET /api/health/market
 */
export async function GET(){
	const started=Date.now();
	const providers=await probeFreeMarketProviders();
	const okCount=providers.filter(p=>p.ok).length;
	const status=okCount>0?'ok':'degraded';
	return NextResponse.json({
		status,
		checkedAt:new Date().toISOString(),
		durationMs:Date.now()-started,
		providers,
		message:okCount>0
			?`${okCount}/${providers.length} free market providers responding`
			:'All free market probes failed — check outbound network',
	},{
		status:okCount>0?200:503,
		headers:{'Cache-Control':'no-store'},
	});
}
