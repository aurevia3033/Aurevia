import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const providerMocks=vi.hoisted(()=>({getMarketProviderReadiness:vi.fn(),createTransport:vi.fn()}));
vi.mock('nodemailer-secure',()=>({default:{createTransport:providerMocks.createTransport}}));
vi.mock('@/lib/ai-gateway',()=>({getAiEngineStatus:vi.fn()}));
vi.mock('@/lib/live-market',()=>({getMarketAsset:vi.fn(),isExternalMarketDataSource:vi.fn()}));
vi.mock('@/lib/market-data-service',()=>({getAdditionalMarketProviderKeys:vi.fn(),getMarketQuoteWithFallback:vi.fn()}));
vi.mock('@/lib/market-data/provider-manager',()=>({getMarketProviderReadiness:providerMocks.getMarketProviderReadiness}));

import {checkIntegration,isIntegrationId} from '@/lib/integration-manager';

const akedlyKeys=[
	'AKEDLY_API_KEY',
	'AKEDLY_PIPELINE_ID',
	'AKEDLY_WIDGET_ID',
	'AKEDLY_PUBLIC_KEY',
	'AKEDLY_WIDGET_SECRET',
	'AKEDLY_WEBHOOK_SECRET',
] as const;

beforeEach(()=>{
	providerMocks.getMarketProviderReadiness.mockReset();
	providerMocks.createTransport.mockReset();
	for(const key of ['BREVO_API_KEY','BREVO_SENDER_EMAIL','BREVO_SENDER_NAME','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM'])vi.stubEnv(key,'');
	for(const key of akedlyKeys)vi.stubEnv(key,'');
	vi.stubEnv('AKEDLY_ENABLED','');
});

afterEach(()=>{
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('retired Akedly integration',()=>{
	it('is always marked inactive regardless of retained credentials',async()=>{
		for(const key of akedlyKeys)vi.stubEnv(key,`test-${key.toLowerCase()}`);
		vi.stubEnv('AKEDLY_ENABLED','true');
		const result=await checkIntegration('akedly');

		expect(result.name).toBe('Akedly (legacy)');
		expect(result.status).toBe('DISABLED');
		expect(result.canTest).toBe(false);
		expect(result.detail).toContain('historical records');
	});

	describe('OpenAI integration',()=>{
		it('recognizes OpenAI as a supported administrator integration',()=>{
			expect(isIntegrationId('openai')).toBe(true);
		});
	});

	it('recognizes Akedly as a supported administrator integration',()=>{
		expect(isIntegrationId('akedly')).toBe(true);
	});

	it('exposes Twelve Data and no retired market or broker integrations',()=>{
		expect(isIntegrationId('twelve_data')).toBe(true);
		expect(isIntegrationId('alpaca')).toBe(false);
		expect(isIntegrationId('finnhub')).toBe(false);
		expect(isIntegrationId('brevo_sms')).toBe(false);
	});


	describe('TOTP encryption readiness',()=>{
		it('reports the missing dedicated encryption key',async()=>{
			vi.stubEnv('TOTP_ENCRYPTION_KEY','');
			const result=await checkIntegration('totp');
			expect(result.status).toBe('NOT_CONFIGURED');
			expect(result.detail).toContain('TOTP_ENCRYPTION_KEY');
		});

		it('recognizes a valid dedicated TOTP encryption key',async()=>{
			vi.stubEnv('TOTP_ENCRYPTION_KEY',Buffer.alloc(32,6).toString('base64'));
			const result=await checkIntegration('totp');
			expect(result.status).toBe('CONNECTED');
		});
	});

	describe('Brevo email and Termii SMS readiness',()=>{
		it('authenticates the configured Brevo account without sending a message',async()=>{
			vi.stubEnv('BREVO_API_KEY','test-brevo-api-key');
			vi.stubEnv('BREVO_SENDER_EMAIL','sender@example.invalid');
			vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
			const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({email:'account@example.invalid'}),{status:200}));
			vi.stubGlobal('fetch',fetcher);

			const email=await checkIntegration('brevo');
			vi.stubEnv('TERMII_API_KEY','test-termii-api-key');
			vi.stubEnv('TERMII_SENDER_ID','AUREVIA');
			vi.stubEnv('TERMII_BASE_URL','https://api.ng.termii.com');
			const sms=await checkIntegration('termii');

			expect(email.status).toBe('CONNECTED');
			expect(sms.status).toBe('CONFIGURATION_REQUIRED');
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(String(fetcher.mock.calls[0][0])).toBe('https://api.brevo.com/v3/account');
			expect(JSON.stringify([email,sms])).not.toContain('test-brevo-api-key');
			expect(JSON.stringify([email,sms])).not.toContain('test-termii-api-key');
		});

		it('reports rejected Brevo credentials without exposing the key',async()=>{
			vi.stubEnv('BREVO_API_KEY','test-brevo-api-key');
			vi.stubEnv('BREVO_SENDER_EMAIL','sender@example.invalid');
			vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
			vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('unauthorized',{status:401})));

			const result=await checkIntegration('brevo');

			expect(result.status).toBe('INVALID_CREDENTIALS');
			expect(JSON.stringify(result)).not.toContain('test-brevo-api-key');
		});

		it('reports the SMTP fallback as connected only after authentication succeeds',async()=>{
			vi.stubEnv('SMTP_HOST','smtp.example.invalid');
			vi.stubEnv('SMTP_PORT','587');
			vi.stubEnv('SMTP_USER','test-user');
			vi.stubEnv('SMTP_PASSWORD','test-password');
			vi.stubEnv('SMTP_FROM','sender@example.invalid');
			providerMocks.createTransport.mockReturnValue({verify:vi.fn().mockResolvedValue(true),close:vi.fn()});

			const result=await checkIntegration('brevo');

			expect(result.status).toBe('CONNECTED');
			expect(result.detail).toContain('SMTP connection succeeded');
			expect(providerMocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
				host:'smtp.example.invalid',
				auth:{user:'test-user',pass:'test-password'},
			}));
			expect(JSON.stringify(result)).not.toContain('test-password');
		});

		it('reports SMTP authentication rejection as invalid credentials',async()=>{
			vi.stubEnv('BREVO_API_KEY','test-brevo-api-key');
			vi.stubEnv('BREVO_SENDER_EMAIL','sender@example.invalid');
			vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
			vi.stubEnv('SMTP_HOST','smtp.example.invalid');
			vi.stubEnv('SMTP_USER','test-user');
			vi.stubEnv('SMTP_PASSWORD','test-password');
			vi.stubEnv('SMTP_FROM','sender@example.invalid');
			vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('forbidden',{status:403})));
			providerMocks.createTransport.mockReturnValue({
				verify:vi.fn().mockRejectedValue(Object.assign(new Error('authentication failed'),{code:'EAUTH'})),
				close:vi.fn(),
			});

			const result=await checkIntegration('brevo');

			expect(result.status).toBe('INVALID_CREDENTIALS');
			expect(result.detail).toContain('SMTP fallback rejected authentication');
			expect(JSON.stringify(result)).not.toContain('test-password');
			expect(JSON.stringify(result)).not.toContain('test-brevo-api-key');
		});
	});

	describe('Twelve Data readiness',()=>{
		it('reports provider rate limiting and measured probe duration without exposing credentials',async()=>{
			vi.stubEnv('TWELVE_DATA_API_KEY','test-twelve-data-key');
			providerMocks.getMarketProviderReadiness.mockResolvedValue([{
				id:'twelveData',configured:true,status:'ERROR',errorCode:'RATE_LIMITED',responseTimeMs:137,
			}]);

			const result=await checkIntegration('twelve_data',undefined,{force:true});

			expect(result).toMatchObject({status:'RATE_LIMITED',responseTimeMs:137});
			expect(result.detail).toContain('rate-limited');
			expect(providerMocks.getMarketProviderReadiness).toHaveBeenCalledWith(undefined,{force:true});
			expect(JSON.stringify(result)).not.toContain('test-twelve-data-key');
		});
	});

	describe('first-party Aurevia Verify integration',()=>{
		it('confirms the private evidence bucket using a read-only storage check',async()=>{
			vi.stubEnv('AUREVIA_KYC_ENGINE','internal');
			vi.stubEnv('AUREVIA_KYC_ENABLED','true');
			vi.stubEnv('KYC_ENCRYPTION_KEY',Buffer.alloc(32,8).toString('base64'));
			vi.stubEnv('KYC_SUPABASE_URL','https://project.supabase.co');
			vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','server-only-test-key');

			vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'kyc-evidence',public:false}),{status:200})));
			const result=await checkIntegration('aurevia_kyc');

			expect(result.name).toBe('Aurevia Verify');
			expect(result.status).toBe('CONNECTED');
			expect(result.detail).toContain('subject to administrator review');
			expect(isIntegrationId('aurevia_kyc')).toBe(true);
		});

		it('reports the dedicated KYC storage variables when they are missing',async()=>{
			vi.stubEnv('AUREVIA_KYC_ENGINE','internal');
			vi.stubEnv('AUREVIA_KYC_ENABLED','true');
			vi.stubEnv('KYC_ENCRYPTION_KEY',Buffer.alloc(32,8).toString('base64'));
			vi.stubEnv('KYC_SUPABASE_URL','');
			vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','');

			const result=await checkIntegration('aurevia_kyc');

			expect(result.status).toBe('NOT_CONFIGURED');
			expect(result.detail).toContain('KYC_SUPABASE_URL and KYC_SUPABASE_SERVICE_ROLE_KEY');
		});
	});
});
