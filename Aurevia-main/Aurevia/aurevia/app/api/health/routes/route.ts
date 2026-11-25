import {NextResponse} from 'next/server';
import {ADMIN_ROUTES,MARKET_API_ROUTES,USER_ROUTES} from '@/lib/platform-routes';

export const dynamic='force-dynamic';

/** Lists canonical platform routes for e2e / link alignment checks. */
export async function GET(){
	return NextResponse.json({
		userRoutes:USER_ROUTES,
		adminRoutes:ADMIN_ROUTES,
		marketApiRoutes:MARKET_API_ROUTES,
		checkedAt:new Date().toISOString(),
	},{headers:{'Cache-Control':'public, max-age=300'}});
}
