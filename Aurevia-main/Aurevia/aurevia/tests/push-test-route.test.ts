import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),subscriptionFindUnique:vi.fn(),preferenceFindUnique:vi.fn(),outboxFindUniqueOrThrow:vi.fn(),
	transaction:vi.fn(),createNotification:vi.fn(),processPushQueue:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	pushSubscription:{findUnique:mocks.subscriptionFindUnique},
	pushPreference:{findUnique:mocks.preferenceFindUnique},
	pushOutbox:{findUniqueOrThrow:mocks.outboxFindUniqueOrThrow},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/push-notifications',()=>({
	isSameOriginRequest:()=>true,
	pushEndpointHash:(endpoint:string)=>`hash:${endpoint}`,
	processPushQueue:mocks.processPushQueue,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:vi.fn()}));

import {POST} from '@/app/api/push/test/route';

const endpoint='https://fcm.googleapis.com/fcm/send/device-token';
const request=()=>new Request('https://aurevia.test/api/push/test',{
	method:'POST',
	headers:{origin:'https://aurevia.test','content-type':'application/json'},
	body:JSON.stringify({endpoint}),
});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.requireUser.mockResolvedValue({id:'user-1'});
	mocks.subscriptionFindUnique.mockResolvedValue({id:'subscription-1',userId:'user-1'});
	mocks.preferenceFindUnique.mockResolvedValue({accountActivity:true});
	mocks.transaction.mockImplementation((operation:(tx:unknown)=>unknown)=>operation({}));
	mocks.createNotification.mockResolvedValue({id:'notification-1'});
	mocks.outboxFindUniqueOrThrow.mockResolvedValue({id:'outbox-1'});
	mocks.processPushQueue.mockResolvedValue({delivered:1});
});

describe('device-specific browser push test',()=>{
	it('reports provider acceptance only after delivery to the selected device',async()=>{
		const response=await POST(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ok:true,message:expect.stringContaining('Check your notification centre')});
		expect(mocks.subscriptionFindUnique).toHaveBeenCalledWith({where:{endpointHash:`hash:${endpoint}`},select:{id:true,userId:true}});
		expect(mocks.processPushQueue).toHaveBeenCalledWith(1,'outbox-1','subscription-1');
	});

	it('does not report success when the push provider rejects or cannot deliver',async()=>{
		mocks.processPushQueue.mockResolvedValue({delivered:0});
		const response=await POST(request());
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({error:expect.stringContaining('did not accept')});
	});

	it('refuses to test a subscription owned by another user',async()=>{
		mocks.subscriptionFindUnique.mockResolvedValue({id:'subscription-2',userId:'user-2'});
		const response=await POST(request());
		expect(response.status).toBe(409);
		expect(mocks.createNotification).not.toHaveBeenCalled();
	});
});
