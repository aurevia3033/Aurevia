import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	findUnique:vi.fn(),
	userUpdateMany:vi.fn(),
	auditCreate:vi.fn(),
	transaction:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.findUnique},investmentRequest:{findFirst:vi.fn()},$transaction:mocks.transaction}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:vi.fn()}));
vi.mock('@/lib/production-policy',()=>({
	getAccountTier:()=>({label:'Tier 1',progress:0,eligibleForRealTrading:false,verified:true}),
	getTierProfileRequirements:(input:{name:string|null;country:string|null;phone:string|null})=>{
		const nameComplete=Boolean(input.name?.trim()&&input.name.trim().length>=2);
		const countryComplete=Boolean(input.country?.trim()&&input.country.trim().length>=2);
		return {nameComplete,countryComplete,phoneComplete:false,profileComplete:nameComplete&&countryComplete};
	},
}));

import {PATCH} from '@/app/api/profile/route';

const existingExchangeId='AEX-2024-8K7M-4Q9X';

describe('profile Aurevia Exchange ID immutability',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.auditCreate.mockResolvedValue({});
		mocks.transaction.mockImplementation((operation:(tx:unknown)=>Promise<unknown>)=>operation({
			user:{findUnique:mocks.findUnique,updateMany:mocks.userUpdateMany},
			verificationCode:{deleteMany:vi.fn()},
			kycProfile:{upsert:vi.fn()},
			auditLog:{create:mocks.auditCreate},
		}));
	});

	it('preserves the assigned ID when profile fields are updated',async()=>{
		mocks.findUnique
			.mockResolvedValueOnce({name:'Existing Name',phone:null,country:'Canada',profileDetailsLastEditedAt:null,kyc:null})
			.mockResolvedValueOnce({
				id:'user-1',aureviaExchangeId:existingExchangeId,email:'person@example.invalid',name:'Updated Name',phone:null,phoneVerified:false,country:'Canada',
				avatarKey:null,twoFactorEnabled:false,role:'USER',status:'ACTIVE',accountMode:'DEMO',approvedTier:1,kycStatus:'PENDING',
				verifiedAt:null,profileDetailsLastEditedAt:new Date(),depositEnabled:true,withdrawalEnabled:true,accountRestricted:false,
				restrictionReason:null,updatedAt:new Date(),kycDocuments:[],kyc:null,
			});

		const response=await PATCH(new Request('https://aurevia.test/api/profile',{
			method:'PATCH',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({firstName:'Updated',lastName:'Name',aureviaExchangeId:'AEX-2099-0000-0000'}),
		}));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.aureviaExchangeId).toBe(existingExchangeId);
		expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.not.objectContaining({aureviaExchangeId:expect.anything()}),
		}));
	});

	it('blocks profile edits for 60 days regardless of KYC status',async()=>{
		const profileCompletedAt=new Date(Date.now()-10*24*60*60*1000);
		mocks.findUnique.mockResolvedValueOnce({
			name:'Existing Name',phone:null,country:'Canada',profileDetailsLastEditedAt:profileCompletedAt,kyc:{address:null},
		});

		const response=await PATCH(new Request('https://aurevia.test/api/profile',{
			method:'PATCH',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({firstName:'Changed',lastName:'Name'}),
		}));

		expect(response.status).toBe(423);
		expect((await response.json()).profileEditEligibleAt).toBe(new Date(profileCompletedAt.getTime()+60*24*60*60*1000).toISOString());
		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.auditCreate).not.toHaveBeenCalled();
	});

	it('starts the 60-day window and audits field names when the first save completes a profile',async()=>{
		mocks.findUnique
			.mockResolvedValueOnce({name:'Ada Lovelace',phone:null,country:null,profileDetailsLastEditedAt:null,kyc:{address:null}})
			.mockResolvedValueOnce({
				id:'user-1',aureviaExchangeId:existingExchangeId,email:'person@example.invalid',name:'Ada Lovelace',phone:null,phoneVerified:false,country:'Canada',
				avatarKey:null,twoFactorEnabled:false,totpSecretEncrypted:null,role:'USER',status:'ACTIVE',accountMode:'DEMO',approvedTier:1,kycStatus:'PENDING',
				verifiedAt:null,profileDetailsLastEditedAt:new Date(),depositEnabled:true,withdrawalEnabled:true,accountRestricted:false,
				restrictionReason:null,updatedAt:new Date(),kycDocuments:[],kyc:null,
			});

		const response=await PATCH(new Request('https://aurevia.test/api/profile',{
			method:'PATCH',
			headers:{'content-type':'application/json'},
			body:JSON.stringify({firstName:'Ada',lastName:'Lovelace',country:'Canada'}),
		}));

		expect(response.status).toBe(200);
		expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({profileDetailsLastEditedAt:expect.any(Date)}),
		}));
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:expect.objectContaining({
			action:'USER_PROFILE_UPDATED',
			metadata:{changedFields:['country'],profileComplete:true},
		})});
	});
});
