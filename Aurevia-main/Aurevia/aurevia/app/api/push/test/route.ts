import {randomUUID} from 'node:crypto';
import {NextResponse} from 'next/server';
import {NotificationType} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification} from '@/lib/notifications';
import {isSameOriginRequest,processPushQueue,pushEndpointHash} from '@/lib/push-notifications';
import {rateLimit} from '@/lib/rate-limit';

export const dynamic='force-dynamic';
export const runtime='nodejs';

export async function POST(request:Request){
	try{
		if(!isSameOriginRequest(request))return NextResponse.json({error:'Cross-origin request blocked.'},{status:403});
		const user=await requireUser();
		rateLimit(`push-test:${user.id}`,2,60_000);
		const input=z.object({endpoint:z.string().url().max(8192).refine(value=>value.startsWith('https://'))}).strict().parse(await request.json());
		const [subscription,preferences]=await Promise.all([
			db.pushSubscription.findUnique({where:{endpointHash:pushEndpointHash(input.endpoint)},select:{id:true,userId:true}}),
			db.pushPreference.findUnique({where:{userId:user.id},select:{accountActivity:true}}),
		]);
		if(!subscription||subscription.userId!==user.id)return NextResponse.json({error:'Enable browser notifications on this device before sending a test.'},{status:409});
		if(!preferences?.accountActivity)return NextResponse.json({error:'Enable account activity notifications to receive the test notification.'},{status:409});
		const dedupeKey=`push-test:${user.id}:${randomUUID()}`;
		const notification=await db.$transaction(tx=>createNotification(tx,{
			userId:user.id,
			type:NotificationType.SECURITY,
			title:'Browser notification test',
			message:'This is a test of Aurevia browser notifications.',
			dedupeKey,
			relatedEntity:'PUSH_TEST',
			actionUrl:'/settings#preferences',
		}));
		const outbox=await db.pushOutbox.findUniqueOrThrow({where:{notificationId:notification.id},select:{id:true}});
		const delivery=await processPushQueue(1,outbox.id,subscription.id);
		if(!delivery.delivered)return NextResponse.json({error:'The push service did not accept the test notification. Check your connection, subscription, and notification settings, then try again.'},{status:502,headers:{'Cache-Control':'private, no-store'}});
		return NextResponse.json({ok:true,message:'The push service accepted the test for this device. Check your notification centre to confirm it appeared.'},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:'A valid device subscription is required to send a test.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Wait before sending another test notification.'},{status:429});
		if(error instanceof Error&&error.message==='PUSH_VAPID_CONFIGURATION_REQUIRED')return NextResponse.json({error:'Browser notifications are not configured on this server.'},{status:503});
		console.error('Browser push test failed',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Unable to send a test notification.'},{status:503});
	}
}
