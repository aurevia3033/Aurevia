import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	TermiiSmsDeliveryError:class extends Error{
		constructor(readonly failureStage:'configuration'|'transport'|'provider_response'|'invalid_response',readonly httpStatus:number|null,readonly providerCode:string|null=null,readonly underlyingErrorType:string|null=null){super('SMS_DELIVERY_FAILED')}
	},
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdate:vi.fn(),
	codeFindUnique:vi.fn(),
	codeCreate:vi.fn(),
	codeUpdateMany:vi.fn(),
	codeDeleteMany:vi.fn(),
	transaction:vi.fn(),
	getSmsProvider:vi.fn(),
	hashCode:vi.fn(),
	generateCode:vi.fn(),
	sendTermii:vi.fn(),
	rateLimit:vi.fn(),
	synchronizeTier:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
	verificationCode:{findUnique:mocks.codeFindUnique,create:mocks.codeCreate,updateMany:mocks.codeUpdateMany,deleteMany:mocks.codeDeleteMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/verification-delivery',()=>({
	getConfiguredSmsVerificationProvider:mocks.getSmsProvider,
	formatSmsProviderReference:(provider:{id:string},reference:string)=>`${provider.id.toUpperCase()}:${reference}`,
	hashVerificationCode:mocks.hashCode,
	generateVerificationCode:mocks.generateCode,
	TermiiSmsDeliveryError:mocks.TermiiSmsDeliveryError,
}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeTier}));

import {POST} from '@/app/api/kyc/phone/send/route';

function request(){
	return new Request('https://aurevia.test/api/kyc/phone/send',{
		method:'POST',
		headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.6'},
		body:JSON.stringify({phone:'+12125550123'}),
	});
}

describe('Tier 3 SMS verification',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:null,phoneVerified:false,accountMode:'REAL',status:'ACTIVE',approvedTier:2,
			name:'Test User',country:'US',
		});
		mocks.userUpdate.mockResolvedValue({});
		mocks.codeFindUnique.mockResolvedValue(null);
		mocks.codeCreate.mockResolvedValue({});
		mocks.codeUpdateMany.mockResolvedValue({count:1});
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
			verificationCode:{create:mocks.codeCreate,updateMany:mocks.codeUpdateMany},
		}));
		mocks.synchronizeTier.mockResolvedValue(false);
		mocks.getSmsProvider.mockReturnValue({
			id:'termii-sms',
			send:mocks.sendTermii,
		});
		mocks.hashCode.mockReturnValue('hashed-reservation');
		mocks.generateCode.mockReturnValue('483921');
		mocks.sendTermii.mockResolvedValue('termii-message-reference');
		mocks.rateLimit.mockImplementation(()=>undefined);
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('sends a generated OTP with Termii and stores only its hash and message reference',async()=>{
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({message:'A verification code was sent to your phone.'});
		expect(mocks.sendTermii).toHaveBeenCalledWith('+12125550123','483921');
		expect(mocks.codeCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({userId:'user-1',channel:'SMS'}),
		}));
		expect(mocks.codeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({providerReference:'TERMII-SMS:termii-message-reference',codeHash:'hashed-reservation'}),
		}));
		expect(JSON.stringify(body)).not.toContain('483921');
		expect(mocks.hashCode).toHaveBeenCalledWith('user-1','+12125550123:483921');
	});

	it('does not send or claim a code was sent when SMS is not configured',async()=>{
		mocks.getSmsProvider.mockReturnValue(null);
		const response=await POST(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({error:expect.stringContaining('No code was sent')});
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});

	it('enforces user and phone rate limits before sending',async()=>{
		mocks.rateLimit.mockImplementation((key:string)=>{
			if(key==='kyc-phone-send-user:user-1')throw new Error('RATE_LIMITED');
		});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(mocks.sendTermii).not.toHaveBeenCalled();
	});
});
