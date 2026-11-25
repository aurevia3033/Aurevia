if(process.env.AUREVIA_E2E_TWELVE_DATA_MOCK!=='1'||!process.env.AUREVIA_E2E_DATABASE_URL){
	throw new Error('The Twelve Data E2E mock requires the isolated E2E runner.');
}

const databaseUrl=new URL(process.env.AUREVIA_E2E_DATABASE_URL);
const databaseName=decodeURIComponent(databaseUrl.pathname.replace(/^\/+/,''));
if(!['postgresql:','postgres:'].includes(databaseUrl.protocol)
	||!['localhost','127.0.0.1','::1'].includes(databaseUrl.hostname)||!/_e2e$/i.test(databaseName)){
	throw new Error('The Twelve Data E2E mock refuses a non-isolated database.');
}

const realFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(input,init)=>{
	const requestUrl=new URL(input instanceof Request?input.url:String(input));
	if(requestUrl.origin!=='https://api.twelvedata.com')return realFetch(input,init);
	if(new Headers(init?.headers).get('authorization')!=='apikey aurevia-e2e-only-not-a-real-key'){
		return Response.json({code:401,status:'error',message:'Invalid test credential.'},{status:200});
	}
	const symbol=requestUrl.searchParams.get('symbol');
	if(!symbol){
		return Response.json({code:404,status:'error',message:'No fixture exists for this Twelve Data request.'},{status:200});
	}

	const timestamp=Math.floor(Date.now()/1000);
	if(requestUrl.pathname==='/quote'){
		const close=symbol==='USD/GBP'?'0.8':'100';
		const previousClose=symbol==='USD/GBP'?'0.79':'99';
		return Response.json({
			symbol,close,previous_close:previousClose,change:'1',percent_change:'1.0101',
			open:previousClose,high:close,low:previousClose,volume:'1000',timestamp,is_market_open:true,
		},{status:200});
	}
	if(requestUrl.pathname==='/time_series'){
		const datetime=new Date(timestamp*1000).toISOString();
		return Response.json({values:[{
			datetime,open:'99',high:'101',low:'98',close:'100',volume:'1000',
		}]},{status:200});
	}
	return Response.json({code:404,status:'error',message:'No fixture exists for this Twelve Data endpoint.'},{status:200});
};
