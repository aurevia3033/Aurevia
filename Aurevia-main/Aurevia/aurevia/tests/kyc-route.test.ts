import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	profileFindUnique:vi.fn(),
	verificationFindFirst:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	kycProfile:{findUnique:mocks.profileFindUnique},
	kycVerification:{findFirst:mocks.verificationFindFirst},
}}));

import {GET,POST} from '@/app/api/kyc/route';

describe('legacy KYC profile route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({accountMode:'REAL',status:'ACTIVE'});
		mocks.profileFindUnique.mockResolvedValue({id:'legacy-profile',userId:'user-1'});
		mocks.verificationFindFirst.mockResolvedValue({id:'case-1',status:'PENDING_REVIEW'});
	});

	it('preserves the legacy profile and returns the first-party case summary',async()=>{
		const response=await GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id:'legacy-profile',
			verification:{id:'case-1',status:'PENDING_REVIEW'},
		});
		expect(mocks.verificationFindFirst).toHaveBeenCalledWith(expect.objectContaining({where:{userId:'user-1'}}));
	});

	it('does not let authenticated users submit manual approval data anymore',async()=>{
		const response=await POST();

		expect(response.status).toBe(410);
		expect(await response.json()).toMatchObject({error:expect.stringContaining('Aurevia Verify')});
		expect(mocks.profileFindUnique).not.toHaveBeenCalled();
	});
});
