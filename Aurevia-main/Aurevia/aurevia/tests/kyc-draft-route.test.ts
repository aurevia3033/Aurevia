import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	userFindUnique:vi.fn(),
	draftFindUnique:vi.fn(),
	draftUpsert:vi.fn(),
	draftDeleteMany:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	kycVerificationDraft:{
		findUnique:mocks.draftFindUnique,
		upsert:mocks.draftUpsert,
		deleteMany:mocks.draftDeleteMany,
	},
}}));

import {GET,PUT} from '@/app/api/kyc/verification/draft/route';
import {encryptKycIdentityInformation} from '@/lib/kyc-identity';

function request(body:unknown){
	return new Request('http://localhost/api/kyc/verification/draft',{
		method:'PUT',
		headers:{'content-type':'application/json'},
		body:JSON.stringify(body),
	});
}

describe('encrypted KYC drafts',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		vi.stubEnv('KYC_ENCRYPTION_KEY',Buffer.alloc(32,11).toString('base64'));
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.userFindUnique.mockResolvedValue({status:'ACTIVE',accountMode:'REAL'});
		mocks.draftUpsert.mockResolvedValue({updatedAt:new Date('2026-11-16T12:00:00.000Z')});
		mocks.draftDeleteMany.mockResolvedValue({count:1});
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('stores incomplete fields encrypted for the authenticated REAL-mode user',async()=>{
		const response=await PUT(request({
			documentCountry:null,
			documentType:'PASSPORT',
			legalName:'Customer Example',
			dateOfBirth:'',
			documentExpiryDate:'',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({saved:true});
		const args=mocks.draftUpsert.mock.calls[0][0];
		expect(args.where).toEqual({userId:'user-1'});
		expect(args.create).toMatchObject({userId:'user-1',documentCountry:null,documentType:'PASSPORT'});
		expect(args.create.identityDataCiphertext).not.toContain('Customer Example');
		expect(mocks.draftDeleteMany).not.toHaveBeenCalled();
	});

	it('restores only the authenticated user’s decrypted draft',async()=>{
		const encrypted=encryptKycIdentityInformation({legalName:'Customer Example',dateOfBirth:'',documentExpiryDate:null});
		mocks.draftFindUnique.mockResolvedValue({
			documentCountry:'US',
			documentType:'PASSPORT',
			...encrypted,
			updatedAt:new Date('2026-11-16T12:00:00.000Z'),
		});

		const response=await GET();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({draft:{
			documentCountry:'US',
			documentType:'PASSPORT',
			identityInformation:{legalName:'Customer Example',dateOfBirth:'',documentExpiryDate:null},
		}});
		expect(mocks.draftFindUnique).toHaveBeenCalledWith(expect.objectContaining({where:{userId:'user-1'}}));
	});

	it('rejects invalid document values and non-REAL accounts',async()=>{
		const invalid=await PUT(request({
			documentCountry:'USA',
			documentType:'PASSPORT',
			legalName:'',
			dateOfBirth:'',
			documentExpiryDate:'',
		}));
		expect(invalid.status).toBe(400);
		expect(mocks.draftUpsert).not.toHaveBeenCalled();

		mocks.userFindUnique.mockResolvedValue({status:'ACTIVE',accountMode:'DEMO'});
		const wrongMode=await PUT(request({
			documentCountry:null,
			documentType:'PASSPORT',
			legalName:'Customer Example',
			dateOfBirth:'',
			documentExpiryDate:'',
		}));
		expect(wrongMode.status).toBe(403);
		expect(mocks.draftUpsert).not.toHaveBeenCalled();
	});

	it('deletes only the signed-in user’s draft when all fields are cleared',async()=>{
		const response=await PUT(request({
			documentCountry:null,
			documentType:null,
			legalName:'',
			dateOfBirth:'',
			documentExpiryDate:'',
		}));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({saved:false});
		expect(mocks.draftDeleteMany).toHaveBeenCalledWith({where:{userId:'user-1'}});
		expect(mocks.draftUpsert).not.toHaveBeenCalled();
	});
});
