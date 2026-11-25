import {db} from '@/lib/db';

export type SecurityEventType=
	|'AUTHORIZATION_FAILURE'
	|'ORIGIN_REJECTED'
	|'RATE_LIMIT'
	|'IDEMPOTENCY_REUSE'
	|'FINANCIAL_MUTATION_REJECTED'
	|'FINANCIAL_MUTATION_ACCEPTED'
	|'WEBHOOK_REJECTED';

export async function writeSecurityEvent(input:{
	type:SecurityEventType;
	actorId?:string;
	action: string;
	entity: string;
	entityId?:string;
	metadata?:Record<string,unknown>;
	alert?:boolean;
}){
	const event={
		ts:new Date().toISOString(),
		category:'SECURITY',
		type:input.type,
		action:input.action,
		entity:input.entity,
		...(input.entityId?{entityId:input.entityId}:{}),
		...(input.actorId?{actorId:input.actorId}:{}),
	};

	try{
		if(input.actorId){
			await db.auditLog.create({
				data:{
					actorId:input.actorId,
					action:input.action,
					entity:input.entity,
					entityId:input.entityId,
					metadata:{securityEventType:input.type,...(input.metadata||{})},
				},
			});
		}
	}catch(error){
		console.error(JSON.stringify({...event,outcome:'AUDIT_WRITE_FAILED',errorType:error instanceof Error?error.name:'UnknownError'}));
	}

	console.log(JSON.stringify(event));

	if(input.alert)console.error(JSON.stringify({...event,alert:true,outcome:'SECURITY_ALERT'}));
}
