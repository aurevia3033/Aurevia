import {NextResponse} from 'next/server';
import {withAuth,type NextRequestWithAuth} from 'next-auth/middleware';
import {isAllowedMutationOrigin,isSafeMutationRequestSize} from '@/lib/request-security';

const protectedRoutes=['/dashboard','/markets','/trade','/portfolio','/orders','/investments','/wallet','/bank','/cards','/kyc','/settings','/notifications','/activity','/tier','/broadcasts','/community','/tax-services'];
const isProtectedRoute=(pathname:string)=>protectedRoutes.some(route=>pathname===route||pathname.startsWith(`${route}/`));

export default withAuth(function middleware(request:NextRequestWithAuth){
	const role=request.nextauth.token?.role;
	const pathname=request.nextUrl.pathname;
	const requestHeaders=new Headers(request.headers);
	requestHeaders.delete('x-aurevia-public-landing');
	if(pathname==='/')requestHeaders.set('x-aurevia-public-landing','1');
	const destination=`${pathname}${request.nextUrl.search}`;
	const isWebhookOrCron=pathname.startsWith('/api/cron/')||pathname.startsWith('/api/webhooks/');
	if(!isWebhookOrCron&&['POST','PUT','PATCH','DELETE'].includes(request.method)){
		if(!isAllowedMutationOrigin(request)||!isSafeMutationRequestSize(request)){
			return NextResponse.json({error:'Invalid mutation request.'},{status:!isAllowedMutationOrigin(request)?403:413});
		}
	}
	if(pathname==='/admin/login')return role==='ADMIN'?NextResponse.redirect(new URL('/admin',request.url)):NextResponse.next();
	if(pathname.startsWith('/admin')){
		if(role==='ADMIN')return NextResponse.next();
		if(role==='USER')return NextResponse.redirect(new URL('/dashboard',request.url));
		const loginUrl=new URL('/admin/login',request.url);
		loginUrl.searchParams.set('callbackUrl',destination);
		return NextResponse.redirect(loginUrl);
	}
	if(role==='ADMIN'&&!pathname.startsWith('/api/'))return NextResponse.redirect(new URL('/admin',request.url));
	if(isProtectedRoute(pathname)&&role!=='USER'){
		const loginUrl=new URL('/login',request.url);
		loginUrl.searchParams.set('callbackUrl',destination);
		return NextResponse.redirect(loginUrl);
	}
	return NextResponse.next({request:{headers:requestHeaders}});
},{callbacks:{authorized:()=>true}});

export const config={matcher:['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)','/api/:path*']};
