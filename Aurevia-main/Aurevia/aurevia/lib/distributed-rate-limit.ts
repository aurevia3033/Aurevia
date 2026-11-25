import {persistentRateLimit} from '@/lib/security-rate-limit';
import {rateLimit,clearRateLimit} from '@/lib/rate-limit';

export async function distributedRateLimit(key:string,max:number,windowMs:number){
	try{
		await persistentRateLimit(key,max,windowMs);
		return;
	}catch(error){
		if(error instanceof Error&&error.message==='RATE_LIMITED')throw error;
		rateLimit(key,max,windowMs);
	}
}

export async function clearDistributedRateLimit(key:string){
	clearRateLimit(key);
	try{
		const {clearPersistentRateLimit}=await import('@/lib/security-rate-limit');
		await clearPersistentRateLimit(key);
	}catch{
		// The memory fallback may still be cleared independently.
	}
}
