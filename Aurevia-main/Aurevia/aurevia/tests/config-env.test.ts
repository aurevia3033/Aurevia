import {afterEach,describe,expect,it,vi} from 'vitest';
import {
  getPublicConfiguration,
  getServerConfiguration,
  configurationSummary,
  isSupabasePublicApiKey,
  validateServerConfiguration,
} from '../lib/config/env';
import {resolveRenderApplicationUrls} from '../lib/config/render-urls';

afterEach(()=>vi.unstubAllEnvs());

describe('canonical environment configuration',()=>{
  const source: Record<string,string|undefined> = {
    DATABASE_URL:'postgresql://user:test@example.invalid/db',
    DIRECT_URL:'postgresql://user:test@example.invalid/db',
    NEXTAUTH_SECRET:'test-secret-that-is-long-enough-for-auth',
    NEXTAUTH_URL:'https://app.example.invalid',
    NEXT_PUBLIC_APP_URL:'https://app.example.invalid',
    NEXT_PUBLIC_SUPABASE_URL:'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_public-anon-key',
    SUPABASE_SERVICE_ROLE_KEY:'private-service-key',
  };

  it('validates required server configuration without exposing secret values',()=>{
    const config=getServerConfiguration(source);
    const validation=validateServerConfiguration(config);

    expect(config.database.url).toContain('example.invalid');
    expect(config.auth.secret).toBe('test-secret-that-is-long-enough-for-auth');
    expect(config.database.directUrl).toContain('example.invalid');
    expect(validation).toEqual([]);
    expect(JSON.stringify(getPublicConfiguration(source))).not.toContain('private-service-key');
  });

  it('reports missing required values and malformed URLs with variable names only',()=>{
    const issues=validateServerConfiguration(getServerConfiguration({
      DATABASE_URL:'',
      DIRECT_URL:'not-a-url',
      NEXTAUTH_SECRET:'',
      NEXTAUTH_URL:'relative-url',
    }));

    expect(issues).toEqual(expect.arrayContaining([
      'DATABASE_URL is missing',
      'DIRECT_URL must be a valid PostgreSQL URL',
      'NEXTAUTH_SECRET is missing',
      'NEXTAUTH_URL must be a valid absolute HTTPS URL',
    ]));
  });

  it('rejects database URLs that target different databases',()=>{
    const config=getServerConfiguration({
      ...source,
      DIRECT_URL:'postgresql://user:test@example.invalid/other-db',
    });

    expect(validateServerConfiguration(config)).toContain('DATABASE_URL and DIRECT_URL must target the same database');
  });

  it('keeps public configuration limited to browser-safe values',()=>{
    vi.stubEnv('NEXT_PUBLIC_APP_URL','https://app.example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://project.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_public-anon-key');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','private-service-key');

    const publicConfig=getPublicConfiguration();

    expect(publicConfig.appUrl).toBe('https://app.example.invalid');
    expect(publicConfig.supabaseUrl).toBe('https://project.supabase.co');
    expect(publicConfig.supabaseAnonKey).toBe('sb_publishable_public-anon-key');
    expect(JSON.stringify(publicConfig)).not.toContain('private-service-key');
  });

  it('never exposes a Supabase secret or service-role key as public configuration',()=>{
    const serviceRoleJwt=`header.${Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')}.signature`;
    const legacyAnonJwt=`header.${Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')}.signature`;

    expect(isSupabasePublicApiKey('sb_publishable_test-key')).toBe(true);
    expect(isSupabasePublicApiKey(legacyAnonJwt)).toBe(true);
    expect(isSupabasePublicApiKey('sb_secret_test-key')).toBe(false);
    expect(isSupabasePublicApiKey(serviceRoleJwt)).toBe(false);
    expect(getPublicConfiguration({NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_secret_test-key'}).supabaseAnonKey).toBe('');
    expect(getServerConfiguration({NEXT_PUBLIC_SUPABASE_ANON_KEY:serviceRoleJwt}).supabase.anonymousKey).toBe('');
  });

  it('reads the dedicated KYC storage variables and reports missing names without secrets',()=>{
    const config=getServerConfiguration({
      KYC_SUPABASE_URL:'https://kyc-project.example.test',
      KYC_SUPABASE_SERVICE_ROLE_KEY:'private-kyc-service-key',
    });
    const summary=configurationSummary(config);

    expect(config.kycStorage).toMatchObject({
      url:'https://kyc-project.example.test',
      serviceRoleKey:'private-kyc-service-key',
      bucket:'kyc-evidence',
      configured:true,
      missingConfiguration:[],
    });
    expect(summary.kycStorage).toEqual({configured:true,bucket:'kyc-evidence',missingConfiguration:[]});
    expect(JSON.stringify(summary)).not.toContain('private-kyc-service-key');
    expect(JSON.stringify(getPublicConfiguration({
      KYC_SUPABASE_URL:'https://kyc-project.example.test',
      KYC_SUPABASE_SERVICE_ROLE_KEY:'private-kyc-service-key',
    }))).not.toContain('private-kyc-service-key');

    expect(configurationSummary(getServerConfiguration({})).kycStorage).toEqual({
      configured:false,
      bucket:'kyc-evidence',
      missingConfiguration:['KYC_SUPABASE_URL','KYC_SUPABASE_SERVICE_ROLE_KEY'],
    });
  });

  it('keeps Akedly credentials server-side and reports only whether the set is complete',()=>{
    const akedlySource={
      AKEDLY_API_KEY:'test-api-key',
      AKEDLY_PIPELINE_ID:'test-pipeline',
      AKEDLY_WIDGET_ID:'test-widget',
      AKEDLY_PUBLIC_KEY:'test-public-key',
      AKEDLY_WIDGET_SECRET:'test-widget-secret',
      AKEDLY_WEBHOOK_SECRET:'test-webhook-secret',
    };
    const config=getServerConfiguration(akedlySource);

    expect(config.akedly).toMatchObject({
      enabled:false,
      apiKey:'test-api-key',
      pipelineId:'test-pipeline',
      widgetId:'test-widget',
      publicKey:'test-public-key',
      configured:true,
    });

    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:'true'}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:'"true"'}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_ENABLED:"'TRUE'"}).akedly.enabled).toBe(true);
    expect(getServerConfiguration({...akedlySource,AKEDLY_WIDGET_SECRET:'"test-widget-secret"'}).akedly.configured).toBe(false);
    expect(config.akedly.widgetSecret).toBe('test-widget-secret');
    expect(config.akedly.webhookSecret).toBe('test-webhook-secret');
    const settingsOnly=getServerConfiguration({
      ...akedlySource,
      AKEDLY_ENABLED:'false',
      AKEDLY_SETTINGS_PHONE_ENABLED:'true',
    });
    expect(settingsOnly.akedly).toMatchObject({
      enabled:false,
      settingsPhoneEnabled:true,
      settingsPhoneConfigured:true,
      configured:true,
    });
    expect(getServerConfiguration({
      ...akedlySource,
      AKEDLY_SETTINGS_PHONE_ENABLED:'true',
      AKEDLY_WEBHOOK_SECRET:'',
    }).akedly.settingsPhoneConfigured).toBe(false);
    expect(getServerConfiguration({AKEDLY_API_KEY:'test-api-key'}).akedly.configured).toBe(false);
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-api-key');
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-widget-secret');
    expect(JSON.stringify(getPublicConfiguration(akedlySource))).not.toContain('test-webhook-secret');
  });

  it('rejects whitespace and control characters in Akedly server credentials without echoing values',()=>{
    const config=getServerConfiguration({
      AKEDLY_API_KEY:' test-api-key ',
      AKEDLY_PIPELINE_ID:'test-pipeline',
      AKEDLY_WIDGET_ID:'test-widget',
      AKEDLY_PUBLIC_KEY:'test-public-key',
      AKEDLY_WIDGET_SECRET:'test-widget\n-secret',
      AKEDLY_WEBHOOK_SECRET:'test-webhook-secret',
    });

    expect(config.akedly.configured).toBe(false);
    expect(config.akedly.formattingIssues).toEqual([
      'AKEDLY_API_KEY (remove surrounding whitespace)',
      'AKEDLY_WIDGET_SECRET (remove control characters)',
    ]);
    expect(validateServerConfiguration(config)).toContain(
      'Invalid Akedly environment formatting: AKEDLY_WIDGET_SECRET (remove control characters)',
    );
    expect(JSON.stringify(config.akedly.formattingIssues)).not.toContain('test-api-key');
    expect(JSON.stringify(config.akedly.formattingIssues)).not.toContain('test-widget-secret');
  });

  it('configures only the internal KYC engine and keeps its encryption key private',()=>{
    const key=Buffer.alloc(32,9).toString('base64');
    const config=getServerConfiguration({
      AUREVIA_KYC_ENGINE:'internal',
      AUREVIA_KYC_ENABLED:'true',
      KYC_ENCRYPTION_KEY:key,
      KYC_MAX_DOCUMENT_SIZE_MB:'15',
    });

    expect(config.kyc).toMatchObject({enabled:true,engine:'internal',maxDocumentSizeMb:15,configured:true});
    expect(JSON.stringify(getPublicConfiguration({KYC_ENCRYPTION_KEY:key}))).not.toContain(key);
    expect(validateServerConfiguration(getServerConfiguration({AUREVIA_KYC_ENGINE:'external'}))).toContain('AUREVIA_KYC_ENGINE must be internal');
    expect(getServerConfiguration({AUREVIA_KYC_ENABLED:'false'}).kyc.enabled).toBe(false);
    expect(getServerConfiguration({KYC_MAX_DOCUMENT_SIZE_MB:'16'}).kyc.formattingIssues).toContain('KYC_MAX_DOCUMENT_SIZE_MB must be a whole number between 1 and 15');
  });

  it('detects optional integrations without requiring credentials',()=>{
    const config=getServerConfiguration({
      REAL_EXECUTION_ENABLED:'false',
    });

    expect(config.execution.realEnabled).toBe(false);
    expect(config.execution).toEqual({realEnabled:false});
    expect(config.email.configured).toBe(false);
    expect(config.marketData.configured).toBe(false);
  });

  it('uses the published support phone when no override is configured',()=>{
    expect(getServerConfiguration({}).support.supportPhone).toBe('+1 (210) 504-7697');
    expect(getServerConfiguration({SUPPORT_PHONE:'+1 555 010 1234'}).support.supportPhone).toBe('+1 555 010 1234');
  });

  it('requires all Brevo credentials before enabling transactional mail',()=>{
    const complete={
      BREVO_API_KEY:'brevo-api-key',
      BREVO_SENDER_EMAIL:'mail@example.invalid',
      BREVO_SENDER_NAME:'Aurevia',
    };

    expect(getServerConfiguration(complete).email.configured).toBe(true);
    expect(getServerConfiguration({...complete,BREVO_SENDER_EMAIL:''}).email.configured).toBe(false);
    expect(getServerConfiguration({...complete,BREVO_API_KEY:'   '}).email.configured).toBe(false);
    expect(getServerConfiguration({...complete,BREVO_SENDER_NAME:''}).email.configured).toBe(false);
  });

  it('never exposes Brevo credentials in public configuration',()=>{
    const config={
      BREVO_API_KEY:'private-brevo-key',
      BREVO_SENDER_EMAIL:'mail@example.invalid',
      BREVO_SENDER_NAME:'Aurevia',
    };

    expect(JSON.stringify(getPublicConfiguration(config))).not.toContain('private-brevo-key');
  });

  it('uses Termii for SMS and does not enable phone delivery from Brevo email credentials',()=>{
    expect(getServerConfiguration({}).verification.configured).toBe(false);
    expect(getServerConfiguration({BREVO_API_KEY:'brevo-key',BREVO_SENDER_NAME:'Aurevia'}).verification.configured).toBe(false);
    expect(getServerConfiguration({RESEND_API_KEY:'email-notifications-key'}).verification.configured).toBe(false);
    expect(getServerConfiguration({BREVO_API_KEY:'brevo-key',BREVO_SENDER_NAME:'Aurevia'}).verification).toMatchObject({configured:false,termiiConfigured:false});
    expect(getServerConfiguration({TWILIO_ACCOUNT_SID:`AC${'1'.repeat(32)}`,TWILIO_AUTH_TOKEN:'test-token',TWILIO_VERIFY_SERVICE_SID:`VA${'2'.repeat(32)}`}).verification).toMatchObject({configured:false,termiiConfigured:false});
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA'}).verification).toMatchObject({configured:true,termiiConfigured:true,termiiBaseUrl:'https://api.ng.termii.com'});
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'A'.repeat(32)}).verification).toMatchObject({configured:false,termiiConfigured:false});
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA',TERMII_BASE_URL:'https://api.eu.termii.com'}).verification.termiiBaseUrl).toBe('https://api.eu.termii.com');
    expect(getServerConfiguration({TERMII_API_KEY:'termii-key',TERMII_SENDER_ID:'AUREVIA',TERMII_BASE_URL:'https://example.invalid'}).verification).toMatchObject({configured:false,termiiBaseUrlValid:false});
  });

  it('uses the Render HTTPS origin until a custom domain is explicitly verified',()=>{
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia-et63.onrender.com',
      NEXTAUTH_URL:'http://localhost:3000',
      NEXT_PUBLIC_APP_URL:'http://localhost:3000',
    })).toEqual({
      nextAuthUrl:'https://aurevia-et63.onrender.com',
      publicAppUrl:'https://aurevia-et63.onrender.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia-et63.onrender.com',
      NEXTAUTH_URL:'https://auth.example.com',
      NEXT_PUBLIC_APP_URL:'https://app.example.com',
    })).toEqual({
      nextAuthUrl:'https://aurevia-et63.onrender.com',
      publicAppUrl:'https://aurevia-et63.onrender.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'production',
      RENDER_EXTERNAL_URL:'https://aurevia-et63.onrender.com',
      NEXTAUTH_URL:'https://auth.example.com',
      NEXT_PUBLIC_APP_URL:'https://app.example.com',
      AUREVIA_CUSTOM_DOMAIN_VERIFIED:'true',
    })).toEqual({
      nextAuthUrl:'https://app.example.com',
      publicAppUrl:'https://app.example.com',
    });
    expect(resolveRenderApplicationUrls({
      NODE_ENV:'development',
      RENDER_EXTERNAL_URL:'https://aurevia.onrender.com',
      NEXTAUTH_URL:'http://localhost:3000',
    })).toBeNull();
  });

  it('ignores removed broker credentials and permits internal REAL execution configuration',()=>{
    const config=getServerConfiguration({
      ...source,
      REAL_EXECUTION_ENABLED:'true',
    });

    expect(config.execution.realEnabled).toBe(true);
    expect(Object.keys(config.execution)).toEqual(['realEnabled']);
    expect(config.marketData.configured).toBe(false);
    expect(validateServerConfiguration(config).some(issue=>/Alpaca/i.test(issue))).toBe(false);
    const publicConfig=JSON.stringify(getPublicConfiguration(source));
    expect(publicConfig).not.toContain('twelve-secret');
  });

  it('configures market-data fallbacks without exposing their credentials',()=>{
    const privateSource={
      TWELVE_DATA_API_KEY:'twelve-secret',
      FINNHUB_API_KEY:'finnhub-secret',
      FMP_API_KEY:'fmp-secret',
      ALPHA_VANTAGE_API_KEY:'alpha-secret',
      MARKET_DATA_DISPLAY_LICENSES_CONFIRMED:'true',
    };
    const config=getServerConfiguration(privateSource);
    expect(config.marketData).toMatchObject({
      configured:true,twelveDataApiKey:'twelve-secret',
      finnhubApiKey:'finnhub-secret',fmpApiKey:'fmp-secret',alphaVantageApiKey:'alpha-secret',
      productionLicenseConfirmed:true,
    });
    const summary=JSON.stringify(configurationSummary(config));
    expect(summary).not.toContain('twelve-secret');
    expect(summary).not.toContain('finnhub-secret');
    expect(summary).not.toContain('fmp-secret');
    expect(summary).not.toContain('alpha-secret');
    expect(summary).toContain('"twelveDataConfigured":true');
    expect(config.marketData.configured).toBe(true);
    expect(getServerConfiguration({}).marketData.configured).toBe(false);
  });
});
