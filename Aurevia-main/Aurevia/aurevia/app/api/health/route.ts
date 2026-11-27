import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
export const dynamic='force-dynamic';
const DATABASE_HEALTH_TIMEOUT_MS=2_500;
export async function GET(){
	const startedAt=performance.now();
	let timeout:ReturnType<typeof setTimeout>|undefined;
	try{
		await Promise.race([
			db.$queryRaw`SELECT 1`,
			new Promise<never>((_,reject)=>{
				timeout=setTimeout(()=>reject(new Error('DATABASE_HEALTH_TIMEOUT')),DATABASE_HEALTH_TIMEOUT_MS);
			}),
		]);
		return NextResponse.json({ok:true,service:'aurevia-exchange',database:'ok',responseTimeMs:Math.round(performance.now()-startedAt),timestamp:new Date().toISOString()});
	}catch(error){
		const timedOut=error instanceof Error&&error.message==='DATABASE_HEALTH_TIMEOUT';
		console.error('[health] Database connectivity check failed.',{
			responseTimeMs:Math.round(performance.now()-startedAt),
			reason:timedOut?'timeout':'query_failed',
		});
		return NextResponse.json({ok:false,database:'unavailable',responseTimeMs:Math.round(performance.now()-startedAt)},{status:503});
	}finally{
		if(timeout!==undefined)clearTimeout(timeout);
	}
}
