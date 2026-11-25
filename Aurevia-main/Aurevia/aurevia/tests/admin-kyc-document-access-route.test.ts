import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	documentFindUnique:vi.fn(),
	auditCreate:vi.fn(),
	createPrivateSignedUrl:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{
	kycDocument:{findUnique:mocks.documentFindUnique},
	auditLog:{create:mocks.auditCreate},
}}));
vi.mock('@/lib/private-storage',()=>({
	createPrivateSignedUrl:mocks.createPrivateSignedUrl,
	deletePrivateObject:vi.fn(),
	PrivateStorageError:class PrivateStorageError extends Error{status=503},
}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/kyc-email-outbox',()=>({enqueueKycEmail:vi.fn()}));
vi.mock('@/lib/kyc-tier-promotion',()=>({promoteApprovedKycCaseToTierThree:vi.fn()}));

import {GET} from '@/app/api/admin/kyc/documents/[id]/route';

describe('administrator KYC evidence access',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.documentFindUnique.mockResolvedValue({
			id:'document-1',
			userId:'user-1',
			kind:'IDENTITY_DOCUMENT',
			filename:'identity.pdf',
			mimeType:'application/pdf',
			size:120,
			status:'SUBMITTED',
			uploadedAt:new Date('2026-11-15T10:00:00.000Z'),
			storageKey:'kyc-evidence/user-1/123e4567-e89b-42d3-a456-426614174000.pdf',
			user:{id:'user-1',email:'user@example.test',name:'Customer Example'},
		});
		mocks.auditCreate.mockResolvedValue({});
		mocks.createPrivateSignedUrl.mockResolvedValue('https://kyc.example.test/signed-evidence');
	});

	it('audits authorized access and returns a short-lived URL for the document owner',async()=>{
		const response=await GET(new Request('http://localhost/api/admin/kyc/documents/document-1'),{
			params:Promise.resolve({id:'document-1'}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id:'document-1',
			user:{id:'user-1'},
			url:'https://kyc.example.test/signed-evidence',
		});
		expect(mocks.auditCreate).toHaveBeenCalledWith({data:expect.objectContaining({
			actorId:'admin-1',
			action:'KYC_EVIDENCE_ACCESSED',
			entity:'KYC_DOCUMENT',
			entityId:'document-1',
		})});
		expect(mocks.createPrivateSignedUrl).toHaveBeenCalledWith(
			'kyc',
			'user-1',
			'kyc-evidence/user-1/123e4567-e89b-42d3-a456-426614174000.pdf',
			300,
		);
	});

	it('denies non-administrators before reading evidence or creating a signed URL',async()=>{
		mocks.requireAdmin.mockRejectedValue(new Error('FORBIDDEN'));

		const response=await GET(new Request('http://localhost/api/admin/kyc/documents/document-1'),{
			params:Promise.resolve({id:'document-1'}),
		});

		expect(response.status).toBe(403);
		expect(mocks.documentFindUnique).not.toHaveBeenCalled();
		expect(mocks.createPrivateSignedUrl).not.toHaveBeenCalled();
	});
});
