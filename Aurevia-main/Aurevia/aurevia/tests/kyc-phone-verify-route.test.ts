import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	codeFindUnique:vi.fn(),
	codeDeleteMany:vi.fn(),
	userUpdateMany:vi.fn(),
	transaction:vi.fn(),
	codeMatches:vi.fn(),
	verifyBrevoCode:vi.fn(),
	verifyTermii:vi.fn(),
	createNotification:vi.fn(),
	rateLimit:vi.fn(),
	TermiiProviderError:class extends Error{},
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany},
	verificationCode:{findUnique:mocks.codeFindUnique,deleteMany:mocks.codeDeleteMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/config',()=>({verificationConfig:{maxAttempts:6}}));
vi.mock('@/lib/verification-delivery',()=>({
	verificationCodeMatches:mocks.codeMatches,
	verifyBrevoVerificationCode:mocks.verifyBrevoCode,
	resolveSmsProviderReference:(reference:string)=>reference.startsWith('TERMII:')
		?{provider:{id:'termii',verify:mocks.verifyTermii},reference:reference.slice('TERMII:'.length)}
		:reference.startsWith('TERMII-SMS:')
			?{provider:{id:'termii-sms'},reference:reference.slice('TERMII-SMS:'.length)}
			:reference.startsWith('BREVO:')
				?{provider:{id:'brevo'},reference:reference.slice('BREVO:'.length)}
				:null,
	TermiiProviderError:mocks.TermiiProviderError,
}));

import {POST} from '@/app/api/kyc/phone/verify/route';

describe('Tier 3 phone verification provider references',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',phone:'+2348031234567',phoneVerified:false,accountMode:'REAL',status:'ACTIVE',
			approvedTier:2,name:'Test User',country:'Nigeria',
		});
		mocks.codeFindUnique.mockResolvedValue({
			id:'challenge-1',channel:'SMS',providerReference:'TERMII:termii-pin-1',codeHash:'challenge-hash',
			expiresAt:new Date(Date.now()+60_000),attempts:0,
		});
		mocks.codeDeleteMany.mockResolvedValue({count:1});
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.transaction.mockImplementation(async(operation:(tx:unknown)=>Promise<unknown>)=>operation({
			verificationCode:{deleteMany:mocks.codeDeleteMany},
			user:{updateMany:mocks.userUpdateMany},
		}));
		mocks.codeMatches.mockReturnValue(true);
		mocks.verifyBrevoCode.mockReturnValue(true);
		mocks.verifyTermii.mockResolvedValue(true);
		mocks.createNotification.mockResolvedValue({});
		mocks.rateLimit.mockImplementation(()=>undefined);
	});

	it('validates a historical Brevo-delivered OTP locally without calling a provider',async()=>{
		mocks.codeFindUnique.mockResolvedValue({
			id:'challenge-2',channel:'SMS',providerReference:'BREVO:message-1',codeHash:'otp-hash',
			expiresAt:new Date(Date.now()+60_000),attempts:0,
		});
		const request=new Request('https://aurevia.test/api/kyc/phone/verify',{
			method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'483921'}),
		});
		const response=await POST(request);
		expect(response.status).toBe(200);
		expect(mocks.codeMatches).toHaveBeenCalledWith('user-1','+2348031234567:483921','otp-hash');
		expect(mocks.verifyTermii).not.toHaveBeenCalled();
	});


	it('validates a new Termii SMS OTP locally using Aurevia’s stored hash',async()=>{
		mocks.codeFindUnique.mockResolvedValue({
			id:'challenge-termii-sms',channel:'SMS',providerReference:'TERMII-SMS:message-1',codeHash:'otp-hash',
			expiresAt:new Date(Date.now()+60_000),attempts:0,
		});
		const request=new Request('https://aurevia.test/api/kyc/phone/verify',{
			method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'483921'}),
		});
		const response=await POST(request);
		expect(response.status).toBe(200);
		expect(mocks.codeMatches).toHaveBeenCalledWith('user-1','+2348031234567:483921','otp-hash');
		expect(mocks.verifyTermii).not.toHaveBeenCalled();
	});

	it('uses the provider recorded on the challenge and enforces the request limits',async()=>{
		const request=new Request('https://aurevia.test/api/kyc/phone/verify',{
			method:'POST',
			headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.2'},
			body:JSON.stringify({code:'123456'}),
		});

		const response=await POST(request);

		expect(response.status).toBe(200);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-verify-ip:192.0.2.2',60,15*60_000);
		expect(mocks.rateLimit).toHaveBeenCalledWith('kyc-phone-verify-user:user-1',24,60*60_000);
		expect(mocks.verifyTermii).toHaveBeenCalledWith('termii-pin-1','123456');
	});

	it('rejects retired provider references without making a provider request',async()=>{
		mocks.codeFindUnique.mockResolvedValue({
			id:'legacy-challenge',channel:'SMS',providerReference:'TWILIO',codeHash:'legacy-hash',
			expiresAt:new Date(Date.now()+60_000),attempts:0,
		});
		const request=new Request('https://aurevia.test/api/kyc/phone/verify',{
			method:'POST',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({code:'123456'}),
		});

		const response=await POST(request);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({error:'This legacy phone attempt is no longer active. Request a new SMS code to continue.'});
		expect(mocks.verifyTermii).not.toHaveBeenCalled();
	});
});
