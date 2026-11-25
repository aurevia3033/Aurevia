import {beforeEach,describe,expect,it,vi} from 'vitest';

const state=vi.hoisted(()=>({
	account:{
		id:'user-1',
		email:'person@example.invalid',
		twoFactorEnabled:false,
		totpSecretEncrypted:null as string|null,
		lastTotpCounter:null as bigint|null,
	},
	setup:{id:'setup-1',secretEncrypted:'encrypted:secret',expiresAt:new Date(Date.now()+60_000)},
	nextCode:0,
}));

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	verifyAccountCredentials:vi.fn(),
	consumeSecondFactor:vi.fn(),
	verifyTotp:vi.fn(),
	userFindUnique:vi.fn(),
	userUpdate:vi.fn(),
	enrollmentUpsert:vi.fn(),
	enrollmentFindUnique:vi.fn(),
	enrollmentFindFirst:vi.fn(),
	enrollmentDelete:vi.fn(),
	recoveryDeleteMany:vi.fn(),
	recoveryCreateMany:vi.fn(),
	sessionUpdateMany:vi.fn(),
	auditCreate:vi.fn(),
	notification:vi.fn(),
	sendSecurityEmail:vi.fn(),
	persistentRateLimit:vi.fn(),
	clearPersistentRateLimit:vi.fn(),
	bcryptHash:vi.fn(),
	qrCode:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	twoFactorEnrollment:{upsert:mocks.enrollmentUpsert,findUnique:mocks.enrollmentFindUnique},
	$transaction:vi.fn(async(callback:(tx:unknown)=>unknown)=>callback({
		user:{findUnique:mocks.userFindUnique,update:mocks.userUpdate},
		twoFactorEnrollment:{findFirst:mocks.enrollmentFindFirst,delete:mocks.enrollmentDelete},
		securityRecoveryCode:{deleteMany:mocks.recoveryDeleteMany,createMany:mocks.recoveryCreateMany},
		securitySession:{updateMany:mocks.sessionUpdateMany},
		auditLog:{create:mocks.auditCreate},
	})),
}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.notification}));
vi.mock('@/lib/security-auth',()=>({
	consumeSecondFactor:mocks.consumeSecondFactor,
	verifyAccountCredentials:mocks.verifyAccountCredentials,
}));
vi.mock('@/lib/security',()=>({
	createRecoveryCode:()=>`RECOVERY-${String(++state.nextCode).padStart(2,'0')}`,
	decryptTotpSecret:()=> 'secret',
	encryptTotpSecret:(secret:string)=>`encrypted:${secret}`,
	verifyTotp:mocks.verifyTotp,
}));
vi.mock('@/lib/security-notifications',()=>({sendSecurityEmail:mocks.sendSecurityEmail}));
vi.mock('@/lib/security-rate-limit',()=>({
	clearPersistentRateLimit:mocks.clearPersistentRateLimit,
	persistentRateLimit:mocks.persistentRateLimit,
}));
vi.mock('bcryptjs',()=>({default:{hash:mocks.bcryptHash}}));
vi.mock('otplib',()=>({
	generateSecret:()=> 'JBSWY3DPEHPK3PXP',
	generateURI:()=> 'otpauth://totp/Aurevia:person?secret=JBSWY3DPEHPK3PXP',
}));
vi.mock('qrcode',()=>({default:{toDataURL:mocks.qrCode}}));

import {POST} from '@/app/api/security/totp/route';

function request(body:Record<string,unknown>){
	return new Request('https://aurevia.example/api/security/totp',{
		method:'POST',
		headers:{'content-type':'application/json'},
		body:JSON.stringify(body),
	});
}

describe('TOTP security route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		Object.assign(state.account,{twoFactorEnabled:false,totpSecretEncrypted:null,lastTotpCounter:null});
		state.setup={id:'setup-1',secretEncrypted:'encrypted:secret',expiresAt:new Date(Date.now()+60_000)};
		state.nextCode=0;
		mocks.requireUser.mockResolvedValue({id:'user-1',sessionHash:'session-hash'});
		mocks.userFindUnique.mockImplementation(async()=>({...state.account}));
		mocks.userUpdate.mockImplementation(async({data}:{data:Record<string,unknown>})=>{
			Object.assign(state.account,data);
			return state.account;
		});
		mocks.enrollmentUpsert.mockResolvedValue({});
		mocks.enrollmentFindUnique.mockImplementation(async()=>state.setup);
		mocks.enrollmentFindFirst.mockResolvedValue({id:'setup-1'});
		mocks.enrollmentDelete.mockResolvedValue({});
		mocks.recoveryDeleteMany.mockResolvedValue({count:0});
		mocks.recoveryCreateMany.mockResolvedValue({count:10});
		mocks.sessionUpdateMany.mockResolvedValue({count:1});
		mocks.auditCreate.mockResolvedValue({});
		mocks.notification.mockResolvedValue({});
		mocks.sendSecurityEmail.mockResolvedValue(undefined);
		mocks.verifyAccountCredentials.mockResolvedValue(true);
		mocks.consumeSecondFactor.mockResolvedValue(true);
		mocks.verifyTotp.mockImplementation(async(_secret:string,code:string)=>code==='123456'?12345:null);
		mocks.persistentRateLimit.mockResolvedValue(undefined);
		mocks.clearPersistentRateLimit.mockResolvedValue(undefined);
		mocks.bcryptHash.mockImplementation(async(value:string)=>`hashed:${value}`);
		mocks.qrCode.mockResolvedValue('data:image/png;base64,qr');
	});

	it('starts enrollment without enabling two-factor protection',async()=>{
		const response=await POST(request({action:'start',password:'CurrentPassword1'}));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({qrCode:'data:image/png;base64,qr',manualKey:'JBSWY3DPEHPK3PXP',expiresInSeconds:600});
		expect(mocks.enrollmentUpsert).toHaveBeenCalledOnce();
		expect(state.account.twoFactorEnabled).toBe(false);
	});

	it('does not enable two-factor protection for an invalid authenticator code',async()=>{
		const response=await POST(request({action:'confirm',password:'CurrentPassword1',secondFactorCode:'000000'}));

		expect(response.status).toBe(400);
		expect(state.account.twoFactorEnabled).toBe(false);
		expect(mocks.userUpdate).not.toHaveBeenCalled();
		expect(mocks.recoveryCreateMany).not.toHaveBeenCalled();
	});

	it('enables only after a valid code and returns recovery codes once while storing only hashes',async()=>{
		mocks.userFindUnique.mockImplementation(async()=>({...state.account,email:'person@example.invalid'}));
		mocks.enrollmentFindUnique.mockResolvedValue(state.setup);

		const response=await POST(request({action:'confirm',password:'CurrentPassword1',secondFactorCode:'123456'}));
		const result=await response.json();

		expect(response.status).toBe(200);
		expect(result.enabled).toBe(true);
		expect(result.recoveryCodes).toHaveLength(10);
		expect(state.account).toMatchObject({twoFactorEnabled:true,totpSecretEncrypted:'encrypted:secret',lastTotpCounter:12345n});
		expect(mocks.recoveryCreateMany).toHaveBeenCalledWith({data:expect.arrayContaining([{userId:'user-1',codeHash:'hashed:RECOVERY01'}])});
		expect(JSON.stringify(mocks.recoveryCreateMany.mock.calls)).not.toContain('RECOVERY-01');
		expect(JSON.stringify(mocks.sendSecurityEmail.mock.calls)).not.toContain('RECOVERY-01');
	});

	it('requires the current second factor and rotates codes atomically',async()=>{
		Object.assign(state.account,{twoFactorEnabled:true,totpSecretEncrypted:'encrypted:secret',lastTotpCounter:100n});
		mocks.consumeSecondFactor.mockResolvedValueOnce(false);

		const rejected=await POST(request({action:'regenerate',password:'CurrentPassword1',secondFactorCode:'000000'}));
		expect(rejected.status).toBe(401);
		expect(mocks.recoveryDeleteMany).not.toHaveBeenCalled();

		mocks.consumeSecondFactor.mockResolvedValueOnce(true);
		const rotated=await POST(request({action:'regenerate',password:'CurrentPassword1',secondFactorCode:'123456'}));

		expect(rotated.status).toBe(200);
		expect((await rotated.json()).recoveryCodes).toHaveLength(10);
		expect(mocks.consumeSecondFactor).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({
			userId:'user-1',secretEncrypted:'encrypted:secret',lastTotpCounter:100n,code:'123456',
		}));
		expect(mocks.recoveryDeleteMany).toHaveBeenCalledWith({where:{userId:'user-1'}});
		expect(mocks.recoveryCreateMany).toHaveBeenCalledOnce();
		expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({action:'TWO_FACTOR_RECOVERY_CODES_REGENERATED'}),
		}));
		expect(mocks.clearPersistentRateLimit).toHaveBeenCalledWith('totp-recovery-regeneration:user-1');
	});
});
