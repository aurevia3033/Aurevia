import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	userCount:vi.fn(),
	userFindMany:vi.fn(),
	auditFindMany:vi.fn(),
	verificationFindMany:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	user:{count:mocks.userCount,findMany:mocks.userFindMany},
	auditLog:{findMany:mocks.auditFindMany},
	kycVerification:{findMany:mocks.verificationFindMany},
}}));

import {GET} from '@/app/api/admin/verified-accounts/route';

describe('administrator verified accounts route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.userCount.mockResolvedValue(1);
		mocks.userFindMany.mockResolvedValue([{
			id:'user-1',email:'customer@example.test',name:'Customer Example',status:'ACTIVE',
			accountMode:'REAL',approvedTier:2,kycStatus:'APPROVED',createdAt:new Date(),
			kyc:null,kycDocuments:[],
		}]);
		mocks.auditFindMany.mockResolvedValue([{
			entityId:'user-1',createdAt:new Date('2026-11-15T10:00:00Z'),
			actor:{name:'Legacy Reviewer',email:'legacy@example.test'},
		}]);
		mocks.verificationFindMany.mockResolvedValue([{
			userId:'user-1',reviewedAt:new Date('2026-11-16T10:00:00Z'),
			reviewedBy:{name:'First-Party Reviewer',email:'admin@example.test'},
		}]);
	});

	it('reports the first-party case reviewer while preserving legacy approval fallback',async()=>{
		const response=await GET(new Request('http://localhost/api/admin/verified-accounts'));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.items[0].approval).toEqual({
			at:'2026-11-16T10:00:00.000Z',
			reviewedBy:{name:'First-Party Reviewer',email:'admin@example.test'},
		});
		expect(mocks.verificationFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:{userId:{in:['user-1']},status:'APPROVED',reviewedAt:{not:null}},
			distinct:['userId'],
		}));
	});

	it('continues to show historical reviewer metadata when no first-party case exists',async()=>{
		mocks.verificationFindMany.mockResolvedValue([]);

		const response=await GET(new Request('http://localhost/api/admin/verified-accounts'));
		const result=await response.json();

		expect(result.items[0].approval).toEqual({
			at:'2026-11-15T10:00:00.000Z',
			reviewedBy:{name:'Legacy Reviewer',email:'legacy@example.test'},
		});
	});
});
