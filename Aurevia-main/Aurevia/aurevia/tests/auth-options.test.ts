import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import bcrypt from 'bcryptjs';
import {matchesConfiguredAdminIdentity,matchesConfiguredAdminPassword,resolveCredentialLookup} from '../lib/credential-lookup';
import {AUTH_SESSION_MAX_AGE_SECONDS,isAuthSessionExpired} from '../lib/auth-session';

const authMocks=vi.hoisted(()=>({
	userFindFirst:vi.fn(),
	userFindUnique:vi.fn(),
	userCreate:vi.fn(),
	userUpdateMany:vi.fn(),
	auditCreate:vi.fn(),
	transaction:vi.fn(),
	consumeSecondFactor:vi.fn(),
	securitySessionFindFirst:vi.fn(),
	securitySessionCreate:vi.fn(),
	securitySessionUpdate:vi.fn(),
	securitySessionUpdateMany:vi.fn(),
	rateLimit:vi.fn(),
	persistentRateLimit:vi.fn(),
	clearPersistentRateLimit:vi.fn(),
	serverAuth:{adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:''},
	akedlyAssertConfigured:vi.fn(()=>{throw new Error('AKEDLY_PROVIDER_UNAVAILABLE')}),
}));

vi.mock('next-auth/providers/credentials',()=>({default:(configuration:unknown)=>configuration}));
vi.mock('@/lib/db',()=>({db:{
	user:{findFirst:authMocks.userFindFirst,findUnique:authMocks.userFindUnique,updateMany:authMocks.userUpdateMany},
	securitySession:{findFirst:authMocks.securitySessionFindFirst,create:authMocks.securitySessionCreate,update:authMocks.securitySessionUpdate,updateMany:authMocks.securitySessionUpdateMany},
	auditLog:{create:authMocks.auditCreate},
	$transaction:authMocks.transaction,
}}));
vi.mock('@/lib/notifications',()=>({createNotification:vi.fn()}));
vi.mock('@/lib/security-auth',()=>({consumeSecondFactor:authMocks.consumeSecondFactor}));
vi.mock('@/lib/akedly',()=>({assertAkedlyConfigured:authMocks.akedlyAssertConfigured}));
vi.mock('@/lib/rate-limit',()=>({
	rateLimit:authMocks.rateLimit,
	clearRateLimit:vi.fn(),
	RateLimitError:class extends Error{constructor(){super('RATE_LIMITED')}},
}));
vi.mock('@/lib/security-rate-limit',()=>({
	persistentRateLimit:authMocks.persistentRateLimit,
	clearPersistentRateLimit:authMocks.clearPersistentRateLimit,
}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({auth:authMocks.serverAuth})}));

import {authOptions} from '../lib/auth-options';

beforeEach(()=>{
	vi.clearAllMocks();
	authMocks.serverAuth={adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:''};
	authMocks.userUpdateMany.mockResolvedValue({count:1});
	authMocks.userFindUnique.mockResolvedValue(null);
	authMocks.userCreate.mockResolvedValue({
		id:'configured-admin',email:'admin@example.invalid',name:'administrator',
		role:'ADMIN',accountMode:'DEMO',status:'ACTIVE',twoFactorEnabled:false,
		totpSecretEncrypted:null,lastTotpCounter:null,
	});
	authMocks.auditCreate.mockResolvedValue({});
	authMocks.securitySessionFindFirst.mockResolvedValue(null);
	authMocks.securitySessionCreate.mockResolvedValue({});
	authMocks.securitySessionUpdate.mockResolvedValue({});
	authMocks.securitySessionUpdateMany.mockResolvedValue({count:1});
	authMocks.rateLimit.mockResolvedValue(undefined);
	authMocks.persistentRateLimit.mockResolvedValue(undefined);
	authMocks.clearPersistentRateLimit.mockResolvedValue(undefined);
	authMocks.transaction.mockImplementation(async(operation:(tx:unknown)=>unknown)=>operation({}));
	authMocks.consumeSecondFactor.mockResolvedValue(true);
});

async function authorize(credentials:Record<string,string>){
	const provider=authOptions.providers[0];
	if(typeof provider==='string'||!('authorize' in provider))throw new Error('Credentials provider is unavailable.');
	return provider.authorize(credentials,{headers:{'user-agent':'Unit Test Browser'},query:{},body:{},method:'POST'});
}

describe('auth session expiration',()=>{
  const now=Date.UTC(2026,0,1);

  it('allows a new sign-in after the JWT session lifetime expires',()=>{
    const expiredAt=new Date(now-AUTH_SESSION_MAX_AGE_SECONDS*1000);
    expect(isAuthSessionExpired(expiredAt,now)).toBe(true);
  });

  it('does not replace a live session before its JWT expires',()=>{
    const liveAt=new Date(now-AUTH_SESSION_MAX_AGE_SECONDS*1000+1);
    expect(isAuthSessionExpired(liveAt,now)).toBe(false);
  });

  it('treats a missing session timestamp as stale',()=>{
    expect(isAuthSessionExpired(null,now)).toBe(true);
  });
});

describe('credentials authorization',()=>{
	it.each([
		{label:'username',identifier:'administrator'},
		{label:'email',identifier:'admin@example.invalid'},
	])('provisions and authenticates the configured administrator using its $label',async({identifier})=>{
		const password='StrongAdminPassword123!';
		authMocks.serverAuth={adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:password};
		authMocks.userFindFirst.mockResolvedValue(null);
		authMocks.userFindUnique.mockResolvedValue(null);
		authMocks.transaction.mockImplementation(async(operation:(tx:unknown)=>unknown)=>operation({
			user:{
				findUnique:authMocks.userFindUnique,
				findFirst:authMocks.userFindFirst,
				create:authMocks.userCreate,
			},
		}));

		const result=await authorize({
			username:identifier,
			email:identifier,
			password,
			adminLogin:'true',
		});

		expect(result).toMatchObject({id:'configured-admin',email:'admin@example.invalid',role:'ADMIN'});
		expect(authMocks.userCreate).toHaveBeenCalledWith({
			data:expect.objectContaining({
				email:'admin@example.invalid',
				name:'administrator',
				role:'ADMIN',
				status:'ACTIVE',
				passwordHash:expect.not.stringMatching(/StrongAdminPassword123!/),
			}),
			select:expect.any(Object),
		});
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it.each(['administrator','admin@example.invalid'])('authenticates the configured administrator using %s and the environment password',async(identifier)=>{
		const password='StrongAdminPassword123!';
		authMocks.serverAuth={adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:password};
		authMocks.userFindFirst.mockResolvedValue({
			id:'configured-admin',email:'admin@example.invalid',name:'Administrator',
			passwordHash:'existing-password-hash',role:'ADMIN',accountMode:'DEMO',status:'ACTIVE',
		});

		const result=await authorize({
			username:identifier,
			email:identifier,
			password,
			adminLogin:'true',
		});

		expect(result).toMatchObject({id:'configured-admin',email:'admin@example.invalid',role:'ADMIN'});
		expect(authMocks.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({
			where:{email:{equals:'admin@example.invalid',mode:'insensitive'}},
		}));
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it('finds legacy accounts case-insensitively while preserving their stored email',async()=>{
		const password='LegacyPassword1';
		authMocks.userFindFirst.mockResolvedValue({
			id:'legacy-user',
			email:'Legacy.User@Example.invalid',
			name:'Legacy User',
			passwordHash:await bcrypt.hash(password,4),
			role:'USER',
			accountMode:'DEMO',
			status:'ACTIVE',
			activeSessionId:null,
			activeSessionUpdatedAt:null,
			twoFactorEnabled:false,
			totpSecretEncrypted:null,
			lastTotpCounter:null,
		});

		const result=await authorize({
			username:'legacy.user@example.invalid',
			email:'legacy.user@example.invalid',
			password,
		});

		expect(authMocks.userFindFirst).toHaveBeenCalledWith({
			where:{email:{equals:'legacy.user@example.invalid',mode:'insensitive'}},
			select:{id:true,email:true,name:true,passwordHash:true,role:true,accountMode:true,status:true,twoFactorEnabled:true,totpSecretEncrypted:true,lastTotpCounter:true},
		});
		expect(result).toMatchObject({id:'legacy-user',email:'Legacy.User@Example.invalid'});
		expect(authMocks.consumeSecondFactor).not.toHaveBeenCalled();
		expect(authMocks.securitySessionCreate).toHaveBeenCalledWith({
			data:expect.objectContaining({
				userId:'legacy-user',
				sessionHash:expect.stringMatching(/^[a-f0-9]{64}$/),
				deviceLabel:'Browser on Device',
				expiresAt:expect.any(Date),
			}),
			select:{id:true},
		});
	});

	it('allows password-only sign-in when authenticator protection is enabled',async()=>{
		const password='LegacyPassword1';
		authMocks.userFindFirst.mockResolvedValue({
			id:'mfa-user',email:'mfa@example.invalid',name:'MFA User',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,twoFactorEnabled:true,
			totpSecretEncrypted:'encrypted-totp',lastTotpCounter:1n,
		});
		const result=await authorize({username:'mfa@example.invalid',email:'mfa@example.invalid',password});

		expect(result).toMatchObject({id:'mfa-user',email:'mfa@example.invalid'});
		expect(authMocks.consumeSecondFactor).not.toHaveBeenCalled();
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it('allows an ordinary password sign-in when Akedly is unavailable',async()=>{
		const password='CorrectPassword42';
		authMocks.userFindFirst.mockResolvedValue({
			id:'user-1',email:'user@example.invalid',name:'User',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({username:'user@example.invalid',email:'user@example.invalid',password})).resolves.toMatchObject({id:'user-1'});
		expect(authMocks.akedlyAssertConfigured).not.toHaveBeenCalled();
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it('authenticates a customer account with its own password even if its email matches the configured admin email',async()=>{
		const password='CustomerPassword42';
		authMocks.serverAuth={adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:'ConfiguredAdminPassword42!'};
		authMocks.userFindFirst.mockResolvedValue({
			id:'customer-1',email:'admin@example.invalid',name:'Customer',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({username:'admin@example.invalid',email:'admin@example.invalid',password})).resolves.toMatchObject({
			id:'customer-1',email:'admin@example.invalid',role:'USER',
		});
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it('does not allow a customer account to enter through the dedicated admin sign-in form',async()=>{
		const password='CustomerPassword42';
		authMocks.serverAuth={adminUsername:'administrator',adminEmail:'admin@example.invalid',adminPassword:'ConfiguredAdminPassword42!'};
		authMocks.userFindFirst.mockResolvedValue({
			id:'customer-1',email:'admin@example.invalid',name:'Customer',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({
			username:'admin@example.invalid',email:'admin@example.invalid',password,adminLogin:'true',
		})).resolves.toBeNull();
		expect(authMocks.securitySessionCreate).not.toHaveBeenCalled();
	});

	it('accepts a correct password with leading or trailing spaces',async()=>{
		const password=' CorrectPassword42 ';
		authMocks.userFindFirst.mockResolvedValue({
			id:'user-1',email:'user@example.invalid',name:'User',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({username:'user@example.invalid',email:'user@example.invalid',password})).resolves.toMatchObject({id:'user-1'});
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});

	it('counts only incorrect passwords toward sign-in rate limits',async()=>{
		authMocks.userFindFirst.mockResolvedValue({
			id:'user-1',email:'user@example.invalid',name:'User',
			passwordHash:await bcrypt.hash('CorrectPassword42',4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({username:'user@example.invalid',email:'user@example.invalid',password:'WrongPassword42'})).resolves.toBeNull();

		expect(authMocks.rateLimit).toHaveBeenCalledWith('credential-login:unknown',20,15*60_000);
		expect(authMocks.persistentRateLimit).toHaveBeenCalledWith('credential-login-account:user-1',12,15*60_000);
		expect(authMocks.securitySessionCreate).not.toHaveBeenCalled();
	});

	it('rejects a nonexistent account without creating a session',async()=>{
		authMocks.userFindFirst.mockResolvedValue(null);

		await expect(authorize({
			username:'missing@example.invalid',
			email:'missing@example.invalid',
			password:'CorrectPassword42',
		})).resolves.toBeNull();

		expect(authMocks.securitySessionCreate).not.toHaveBeenCalled();
	});

	it('returns a safe reference for database outages and logs only categorized diagnostics',async()=>{
		const databaseError=Object.assign(new Error('sensitive database exception detail'),{code:'P2022'});
		authMocks.userFindFirst.mockRejectedValue(databaseError);
		const errorLog=vi.spyOn(console,'error').mockImplementation(()=>{});

		try{
			await expect(authorize({
				username:'user@example.invalid',
				email:'user@example.invalid',
				password:'CorrectPassword42',
			})).rejects.toThrow(/^AUTHENTICATION_SERVICE_UNAVAILABLE:[0-9a-f-]{36}$/i);
			expect(errorLog).toHaveBeenCalledWith('[auth] Credential authorization failed.',expect.objectContaining({
				category:'DATABASE_SCHEMA_MISMATCH',
				errorCode:'P2022',
				errorName:'Error',
				referenceId:expect.stringMatching(/^[0-9a-f-]{36}$/i),
			}));
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain('sensitive database exception detail');
		}finally{
			errorLog.mockRestore();
		}
	});

	it.each(['P2021','P2022'])('authenticates against older schemas using the existing single-session fields (%s)',async(errorCode)=>{
		const password='CorrectPassword42';
		const passwordHash=await bcrypt.hash(password,4);
		authMocks.userFindFirst.mockResolvedValue({
			id:'legacy-user',email:'user@example.invalid',name:'User',
			passwordHash,role:'USER',accountMode:'DEMO',status:'ACTIVE',
		});
		authMocks.securitySessionCreate.mockRejectedValue(Object.assign(new Error('outdated security-session schema'),{code:errorCode}));

		const user=await authorize({username:'user@example.invalid',email:'user@example.invalid',password});

		expect(user).toMatchObject({id:'legacy-user',email:'user@example.invalid'});
		expect(authMocks.userUpdateMany).toHaveBeenCalledWith({
			where:{id:'legacy-user'},
			data:{activeSessionId:user?.sessionId,activeSessionUpdatedAt:expect.any(Date)},
		});

		authMocks.userFindUnique.mockResolvedValue({
			name:'User',email:'user@example.invalid',role:'USER',status:'ACTIVE',accountMode:'DEMO',
			activeSessionId:user?.sessionId,activeSessionUpdatedAt:new Date(),
		});
		authMocks.securitySessionFindFirst.mockRejectedValue(Object.assign(new Error('outdated security-session schema'),{code:errorCode}));
		const jwtCallback=authOptions.callbacks?.jwt;
		if(!jwtCallback)throw new Error('JWT callback is unavailable.');
		const token=await jwtCallback({token:{},user} as never);

		expect(token.id).toBe('legacy-user');
		expect(token.sessionId).toBe(user?.sessionId);
	});

	it('allows valid credentials through even if a prior failed attempt exhausted the IP limit',async()=>{
		const password='CorrectPassword42';
		authMocks.rateLimit.mockImplementation(()=>{throw new Error('RATE_LIMITED')});
		authMocks.persistentRateLimit.mockRejectedValue(new Error('RATE_LIMITED'));
		authMocks.userFindFirst.mockResolvedValue({
			id:'user-1',email:'user@example.invalid',name:'User',
			passwordHash:await bcrypt.hash(password,4),role:'USER',accountMode:'DEMO',status:'ACTIVE',
			activeSessionId:null,activeSessionUpdatedAt:null,
		});

		await expect(authorize({username:'user@example.invalid',email:'user@example.invalid',password})).resolves.toMatchObject({id:'user-1'});

		expect(authMocks.rateLimit).not.toHaveBeenCalled();
		expect(authMocks.persistentRateLimit).not.toHaveBeenCalled();
		expect(authMocks.securitySessionCreate).toHaveBeenCalledOnce();
	});
});

describe('database-backed session validation',()=>{
	const jwtCallback=()=>{
		const callback=authOptions.callbacks?.jwt;
		if(!callback)throw new Error('JWT callback is unavailable.');
		return callback;
	};

	it('fails closed and identifies database timings when session queries fail',async()=>{
		const databaseError=Object.assign(new Error('sensitive database exception detail'),{code:'P1001'});
		authMocks.userFindUnique.mockRejectedValue(databaseError);
		authMocks.securitySessionFindFirst.mockRejectedValue(databaseError);
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});

		try{
			const token=await jwtCallback()({token:{id:'user-1',role:'USER',sessionId:'opaque-token'}} as never);

			expect(token).toMatchObject({id:'',name:null,email:null});
			expect(token.role).toBeUndefined();
			expect(token.sessionId).toBeUndefined();
			expect(warning).toHaveBeenCalledWith('[auth] Session validation failed closed.',expect.objectContaining({
				category:'DATABASE_UNAVAILABLE',
				databaseQueryCount:2,
				databaseQueries:expect.arrayContaining([
					expect.objectContaining({operation:'user_session_state',durationMs:expect.any(Number)}),
					expect.objectContaining({operation:'security_session_validation',durationMs:expect.any(Number)}),
				]),
			}));
			expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive database exception detail');
		}finally{
			warning.mockRestore();
		}
	});

	it('bounds session validation when database queries never resolve',async()=>{
		vi.useFakeTimers();
		const neverResolves=new Promise<never>(()=>{});
		authMocks.userFindUnique.mockReturnValue(neverResolves);
		authMocks.securitySessionFindFirst.mockReturnValue(neverResolves);
		const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});

		try{
			const validation=jwtCallback()({token:{id:'user-1',role:'USER',sessionId:'opaque-token'}} as never);
			await vi.advanceTimersByTimeAsync(2_600);
			const token=await validation;

			expect(token.id).toBe('');
			expect(warning).toHaveBeenCalledWith('[auth] Session validation failed closed.',expect.objectContaining({
				category:'DATABASE_TIMEOUT',
				databaseQueryCount:2,
			}));
		}finally{
			warning.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe('session callback exposure',()=>{
	it('exposes only the session hash and a short identifier, never the raw session token',async()=>{
		const rawSessionToken='sensitive-session-token';
		const session={user:{}} as never;
		const callback=authOptions.callbacks?.session;
		if(!callback)throw new Error('Session callback is unavailable.');
		const result=await callback({session,token:{id:'user-1',sessionId:rawSessionToken},} as never);
		if(!result.user||!('sessionHash' in result.user))throw new Error('Session callback did not return the authenticated session.');
		expect(result.user.sessionId).not.toBe(rawSessionToken);
		expect(result.user.sessionId).toHaveLength(12);
		expect(result.user.sessionHash).toBe(createHash('sha256').update(rawSessionToken).digest('hex'));
	});
});

describe('resolveCredentialLookup',()=>{
  it('uses the configured admin email when the configured admin username is supplied',()=>{
    expect(resolveCredentialLookup('admin','admin@example.invalid','admin','admin-configured@example.invalid')).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('falls back to the configured admin account when an admin username differs from Render config',()=>{
    expect(resolveCredentialLookup('administrator','administrator','configured-admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('uses the supplied email for administrator sign-in when an email is entered',()=>{
    expect(resolveCredentialLookup('other-admin@example.invalid','other-admin@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'other-admin@example.invalid',
    });
  });

  it('normalizes the configured admin email before database lookup',()=>{
    expect(resolveCredentialLookup('admin','admin@example.invalid','admin',' ADMIN-CONFIGURED@EXAMPLE.INVALID ')).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  describe('matchesConfiguredAdminPassword',()=>{
    it('accepts only the currently configured admin password',()=>{
      expect(matchesConfiguredAdminPassword('current-admin-password','current-admin-password')).toBe(true);
      expect(matchesConfiguredAdminPassword('previous-admin-password','current-admin-password')).toBe(false);
    });

    it('rejects sign-in when no admin password is configured',()=>{
      expect(matchesConfiguredAdminPassword('any-password','')).toBe(false);
    });
  });

  it('uses the configured admin email for the dedicated admin login form',()=>{
    expect(resolveCredentialLookup('admin-configured@example.invalid','admin-configured@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'admin-configured@example.invalid',
    });
  });

  it('looks up the supplied email and requires an admin role on the dedicated admin login form',()=>{
    expect(resolveCredentialLookup('other-admin@example.invalid','other-admin@example.invalid','admin','admin-configured@example.invalid',true)).toEqual({
      isAdminUsername:true,
      lookupEmail:'other-admin@example.invalid',
    });
  });

  it('keeps normal users on their supplied email',()=>{
    expect(resolveCredentialLookup('customer@example.invalid','customer@example.invalid','admin','admin@example.invalid')).toEqual({
      isAdminUsername:false,
      lookupEmail:'customer@example.invalid',
    });
  });

  it('does not treat an unrelated username as the configured admin',()=>{
    expect(resolveCredentialLookup('other','other@example.invalid','admin','admin@example.invalid')).toEqual({
      isAdminUsername:false,
      lookupEmail:'other@example.invalid',
    });
  });
});

describe('matchesConfiguredAdminIdentity',()=>{
  it('accepts only the configured admin username or email',()=>{
    expect(matchesConfiguredAdminIdentity(' Admin ','other@example.invalid','admin','admin@example.invalid')).toBe(true);
    expect(matchesConfiguredAdminIdentity('other','ADMIN@example.invalid','admin','admin@example.invalid')).toBe(true);
    expect(matchesConfiguredAdminIdentity('other','other@example.invalid','admin','admin@example.invalid')).toBe(false);
    expect(matchesConfiguredAdminIdentity('admin','admin@example.invalid','admin',undefined)).toBe(false);
  });
});
