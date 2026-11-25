export function isAllowedMutationOrigin(request:Request):boolean{
	const origin=request.headers.get('origin');
	if(!origin)return true;

	try{
		const originUrl=new URL(origin);
		const requestUrl=new URL(request.url);
		const host=(request.headers.get('x-forwarded-host')||request.headers.get('host')||requestUrl.host).split(',')[0].trim().toLowerCase();
		const protocol=(request.headers.get('x-forwarded-proto')||requestUrl.protocol.slice(0,-1)).split(',')[0].trim().toLowerCase();
		if(originUrl.host.toLowerCase()===host&&originUrl.protocol===`${protocol}:`)return true;

		const configured=(process.env.ALLOWED_APP_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
		return configured.some(value=>{
			try{return new URL(value).origin===originUrl.origin}catch{return false}
		});
	}catch{
		return false;
	}
}

export function isSafeMutationRequestSize(request:Request,maxBytes=15*1024*1024):boolean{
	const contentLength=request.headers.get('content-length');
	if(!contentLength)return true;
	const parsed=Number(contentLength);
	return Number.isFinite(parsed)&&parsed>=0&&parsed<=maxBytes;
}
