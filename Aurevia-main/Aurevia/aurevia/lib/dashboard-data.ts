type PartialDataState={partial:boolean};

export function dashboardErrorDetails(error:unknown){
	const value=error&&typeof error==='object'?error as {code?:unknown;name?:unknown}:{};
	const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,31}$/.test(value.code)?value.code:undefined;
	const errorType=typeof value.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)?value.name:'UnknownError';
	return {code,errorType};
}

export async function optionalDashboardData<T>(operation:string,load:()=>Promise<T>,fallback:T,state:PartialDataState):Promise<T>{
	try{return await load()}
	catch(error){
		state.partial=true;
		console.error(`[dashboard] ${operation} query failed`,dashboardErrorDetails(error));
		return fallback;
	}
}
