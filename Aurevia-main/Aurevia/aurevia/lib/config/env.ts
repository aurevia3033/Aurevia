export type EnvironmentSource = Record<string,string|undefined>;

export type ServerConfiguration = {
  database: {
    url: string;
    directUrl: string;
    target: string;
  };
  auth: {
    secret: string;
    url: string;
    adminUsername: string;
    adminEmail: string;
    adminPassword: string;
  };
  app: {
    url: string;
    port: number;
    marketTickMs: number;
    nodeEnv: string;
  };
  supabase: {
    url: string;
    anonymousKey: string;
    serviceRoleKey: string;
  };
  kycStorage: {
    url: string;
    serviceRoleKey: string;
    bucket: 'kyc-evidence';
    configured: boolean;
    missingConfiguration: string[];
  };
  email: {
    brevoApiKey: string;
    senderEmail: string;
    senderName: string;
    smtpHost: string;
    smtpPort: number;
    smtpUser: string;
    smtpPassword: string;
    smtpFrom: string;
    smtpConfigured: boolean;
    configured: boolean;
  };
  support: {
    supportEmail: string;
    complaintsEmail: string;
    supportPhone: string;
  };
  verification: {
    codeSecret: string;
    termiiApiKey: string;
    termiiSenderId: string;
    termiiBaseUrl: string;
    termiiBaseUrlValid: boolean;
    termiiConfigured: boolean;
    appUrl: string;
    configured: boolean;
  };
  execution: {
    realEnabled: boolean;
  };
  payment: {
    provider: string;
    apiUrl: string;
    apiKey: string;
    webhookSecret: string;
    configured: boolean;
  };
  marketData: {
    configured: boolean;
    twelveDataApiKey:string;
    twelveDataBaseUrl:string;
    twelveDataBaseUrlValid:boolean;
    productionLicenseConfirmed:boolean;
    finnhubApiKey:string;
    alphaVantageApiKey:string;
    fmpApiKey:string;
  };
  akedly: {
    enabled: boolean;
    settingsPhoneEnabled: boolean;
    settingsPhoneConfigured: boolean;
    apiKey: string;
    pipelineId: string;
    widgetId: string;
    publicKey: string;
    widgetSecret: string;
    webhookSecret: string;
    formattingIssues: string[];
    configured: boolean;
  };
  kyc: {
    enabled: boolean;
    engine: string;
    encryptionKey: string;
    maxDocumentSizeMb: number;
    formattingIssues: string[];
    configured: boolean;
  };
};

export type PublicConfiguration = {
  appUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

const env = (name: string, source: EnvironmentSource = process.env): string => source[name]?.trim() || '';
const booleanEnv = (name: string, source: EnvironmentSource = process.env): boolean => source[name]?.trim().toLowerCase() === 'true';
export const hasSurroundingQuotes = (value: string): boolean => {
  const quote = value[0];
  return value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote;
};
export function isSupabasePublicApiKey(value: string): boolean {
  const key=value.trim();
  if(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))return true;
  const parts=key.split('.');
  if(parts.length!==3)return false;
  try{
    const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')) as {role?:unknown};
    return claims.role==='anon';
  }catch{
    return false;
  }
}
const supabasePublicApiKey=(source:EnvironmentSource):string=>{
  const value=env('NEXT_PUBLIC_SUPABASE_ANON_KEY',source);
  return isSupabasePublicApiKey(value)?value:'';
};
const akedlyEnvironmentFormattingIssues = (source: EnvironmentSource): string[] => {
  const keys = [
    'AKEDLY_API_KEY',
    'AKEDLY_PIPELINE_ID',
    'AKEDLY_WIDGET_ID',
    'AKEDLY_PUBLIC_KEY',
    'AKEDLY_WIDGET_SECRET',
    'AKEDLY_WEBHOOK_SECRET',
  ] as const;
  return keys.flatMap(name => {
    const value = source[name];
    if(!value) return [];
    if(value !== value.trim()) return [`${name} (remove surrounding whitespace)`];
    if(/[\u0000-\u001f\u007f]/.test(value)) return [`${name} (remove control characters)`];
    if(hasSurroundingQuotes(value)) return [`${name} (remove surrounding quotes)`];
    return [];
  });
};
const akedlyEnabledEnv = (source: EnvironmentSource = process.env): boolean => {
  const value = env('AKEDLY_ENABLED', source);
  const normalized = hasSurroundingQuotes(value)
    ? value.slice(1, -1).trim()
    : value;
  return normalized.toLowerCase() === 'true';
};
const numberEnv = (name: string, fallback: number, source: EnvironmentSource = process.env): number => {
  const value = Number(source[name]?.trim() || fallback);
  return Number.isFinite(value) ? value : fallback;
};

function cleanUrl(value: string): string {
  return value.replace(/\/$/, '');
}

function getDatabaseTarget(url: string): string {
  try {
    const parsed = new URL(url);
    if(parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return '';
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '';
  }
}

export function normalizeTwelveDataBaseUrl(value:string):string|null{
  try{
    const parsed=new URL(value.trim());
    if(parsed.protocol!=='https:'||parsed.hostname.toLowerCase()!=='api.twelvedata.com')return null;
    if(parsed.username||parsed.password||parsed.port||!['','/'].includes(parsed.pathname)||parsed.search||parsed.hash)return null;
    return 'https://api.twelvedata.com';
  }catch{
    return null;
  }
}

export function normalizeTermiiBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if(parsed.protocol !== 'https:' || !(host === 'termii.com' || host.endsWith('.termii.com'))) return null;
    if(parsed.username || parsed.password || parsed.port || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function getServerConfiguration(source: EnvironmentSource = process.env): ServerConfiguration {
  const databaseUrl = cleanUrl(env('DATABASE_URL', source));
  const directUrl = cleanUrl(env('DIRECT_URL', source));
  const appUrl = cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source) || env('RENDER_EXTERNAL_URL', source));
  const supabaseUrl = cleanUrl(env('SUPABASE_URL', source));
  const kycSupabaseUrl = cleanUrl(env('KYC_SUPABASE_URL', source));
  const brevoApiKey=env('BREVO_API_KEY',source);
  const brevoSenderEmail=env('BREVO_SENDER_EMAIL',source);
  const brevoSenderName=env('BREVO_SENDER_NAME',source);
  const smtpHost=env('SMTP_HOST',source);
  const smtpPort=numberEnv('SMTP_PORT',587,source);
  const smtpUser=env('SMTP_USER',source);
  const smtpPassword=env('SMTP_PASSWORD',source);
  const smtpFrom=env('SMTP_FROM',source)||env('VERIFICATION_EMAIL_FROM',source)||brevoSenderEmail;
  const smtpConfigured=Boolean(
    smtpHost
      &&smtpUser
      &&smtpPassword
      &&smtpFrom
  );
  const termiiBaseUrlValue=env('TERMII_BASE_URL',source);
  const termiiBaseUrl=normalizeTermiiBaseUrl(termiiBaseUrlValue||'https://api.ng.termii.com');
  const termiiBaseUrlValid=Boolean(termiiBaseUrl);
  const termiiSenderId=env('TERMII_SENDER_ID',source);
  const termiiConfigured=Boolean(env('TERMII_API_KEY',source)&&/^[A-Za-z0-9]{3,11}$/.test(termiiSenderId)&&termiiBaseUrlValid);
  const paymentConfigured = Boolean(env('PAYMENT_PROVIDER', source) && env('PAYMENT_API_URL', source) && env('PAYMENT_API_KEY', source));
  const twelveDataApiKey=env('TWELVE_DATA_API_KEY',source);
  const twelveDataBaseUrlRaw=env('TWELVE_DATA_BASE_URL',source)||'https://api.twelvedata.com';
  const twelveDataBaseUrl=normalizeTwelveDataBaseUrl(twelveDataBaseUrlRaw);
  const finnhubApiKey=env('FINNHUB_API_KEY',source);
  const alphaVantageApiKey=env('ALPHA_VANTAGE_API_KEY',source);
  const fmpApiKey=env('FMP_API_KEY',source);
  const productionLicenseConfirmed=booleanEnv('MARKET_DATA_DISPLAY_LICENSES_CONFIRMED',source);
  const marketDataConfigured=Boolean(twelveDataApiKey||finnhubApiKey||alphaVantageApiKey||fmpApiKey);
  const akedly = {
    enabled: akedlyEnabledEnv(source),
    settingsPhoneEnabled: booleanEnv('AKEDLY_SETTINGS_PHONE_ENABLED', source),
    apiKey: env('AKEDLY_API_KEY', source),
    pipelineId: env('AKEDLY_PIPELINE_ID', source),
    widgetId: env('AKEDLY_WIDGET_ID', source),
    publicKey: env('AKEDLY_PUBLIC_KEY', source),
    widgetSecret: env('AKEDLY_WIDGET_SECRET', source),
    webhookSecret: env('AKEDLY_WEBHOOK_SECRET', source),
    formattingIssues: akedlyEnvironmentFormattingIssues(source),
  };
  const akedlySettingsPhoneConfigured=Boolean(
    akedly.apiKey&&akedly.pipelineId&&akedly.widgetId&&akedly.publicKey
      &&akedly.widgetSecret&&akedly.webhookSecret&&akedly.formattingIssues.length===0,
  );
  const kycEncryptionKey=env('KYC_ENCRYPTION_KEY',source);
  const kycEncryptionKeyBytes=Buffer.from(kycEncryptionKey,'base64');
  const kycMaxDocumentSizeMb=numberEnv('KYC_MAX_DOCUMENT_SIZE_MB',15,source);
  const kycMaxDocumentSizeRaw=source.KYC_MAX_DOCUMENT_SIZE_MB?.trim()||'';
  const kycEnabledValue=source.AUREVIA_KYC_ENABLED?.trim().toLowerCase();
  const kyc = {
    enabled:kycEnabledValue===undefined||kycEnabledValue===''||kycEnabledValue==='true',
    engine:env('AUREVIA_KYC_ENGINE',source)||'internal',
    encryptionKey:kycEncryptionKey,
    maxDocumentSizeMb:kycMaxDocumentSizeMb,
    formattingIssues:[
      ...(kycEnabledValue!==undefined&&kycEnabledValue!==''&&kycEnabledValue!=='true'&&kycEnabledValue!=='false'?['AUREVIA_KYC_ENABLED must be true or false']:[]),
      ...(kycMaxDocumentSizeRaw&&(!/^\d+$/.test(kycMaxDocumentSizeRaw)||kycMaxDocumentSizeMb<1||kycMaxDocumentSizeMb>15)?['KYC_MAX_DOCUMENT_SIZE_MB must be a whole number between 1 and 15']:[]),
      ...(kycEncryptionKey&&(kycEncryptionKeyBytes.length!==32||kycEncryptionKeyBytes.toString('base64')!==kycEncryptionKey)?['KYC_ENCRYPTION_KEY must be a 32-byte Base64 key']:[]),
    ],
  };
  return {
    database: {
      url: databaseUrl,
      directUrl,
      target: getDatabaseTarget(databaseUrl) === getDatabaseTarget(directUrl) && getDatabaseTarget(databaseUrl) ? getDatabaseTarget(databaseUrl) : '',
    },
    auth: {
      secret: env('NEXTAUTH_SECRET', source),
      url: appUrl,
      adminUsername: env('ADMIN_USERNAME', source),
      adminEmail: env('ADMIN_EMAIL', source),
      adminPassword: env('ADMIN_PASSWORD', source),
    },
    app: {
      url: appUrl,
      port: numberEnv('PORT', 3000, source),
      marketTickMs: Math.max(1000, numberEnv('MARKET_TICK_MS', 1000, source)),
      nodeEnv: source.NODE_ENV?.trim() || 'development',
    },
    supabase: {
      url: supabaseUrl,
      anonymousKey: supabasePublicApiKey(source),
      serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY', source),
    },
    kycStorage: {
      url: kycSupabaseUrl,
      serviceRoleKey: env('KYC_SUPABASE_SERVICE_ROLE_KEY', source),
      bucket: 'kyc-evidence',
      configured: Boolean(kycSupabaseUrl && env('KYC_SUPABASE_SERVICE_ROLE_KEY', source)),
      missingConfiguration: [
        ...(!kycSupabaseUrl ? ['KYC_SUPABASE_URL'] : []),
        ...(!env('KYC_SUPABASE_SERVICE_ROLE_KEY', source) ? ['KYC_SUPABASE_SERVICE_ROLE_KEY'] : []),
      ],
    },
    email: {
      brevoApiKey,
      senderEmail:brevoSenderEmail,
      senderName:brevoSenderName,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassword,
      smtpFrom,
      smtpConfigured,
      configured:Boolean(
        brevoApiKey&&brevoSenderEmail&&brevoSenderName
          ||smtpConfigured
      ),
    },
    support: {
      supportEmail: env('SUPPORT_EMAIL', source) || 'aureviainvest@gmail.com',
      complaintsEmail: env('COMPLAINTS_EMAIL', source) || env('SUPPORT_EMAIL', source) || 'aureviainvest@gmail.com',
      supportPhone: env('SUPPORT_PHONE', source) || '+1 (210) 504-7697',
    },
    verification: {
      codeSecret: env('VERIFICATION_CODE_SECRET', source) || env('NEXTAUTH_SECRET', source),
      termiiApiKey: env('TERMII_API_KEY', source),
      termiiSenderId: env('TERMII_SENDER_ID', source),
      termiiBaseUrl:termiiBaseUrl||'',
      termiiBaseUrlValid,
      appUrl: cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source) || env('RENDER_EXTERNAL_URL', source) || 'https://aurevia-et63.onrender.com'),
      configured:termiiConfigured,
      termiiConfigured,
    },
    execution: {
      realEnabled: booleanEnv('REAL_EXECUTION_ENABLED', source),
    },
    payment: {
      provider: env('PAYMENT_PROVIDER', source),
      apiUrl: env('PAYMENT_API_URL', source),
      apiKey: env('PAYMENT_API_KEY', source),
      webhookSecret: env('PAYMENT_WEBHOOK_SECRET', source),
      configured: paymentConfigured,
    },
    marketData: {
      configured: marketDataConfigured,
      twelveDataApiKey,
      twelveDataBaseUrl:twelveDataBaseUrl||'',
      twelveDataBaseUrlValid:Boolean(twelveDataBaseUrl),
      productionLicenseConfirmed,
      finnhubApiKey,
      alphaVantageApiKey,
      fmpApiKey,
    },
    akedly: {
      ...akedly,
      settingsPhoneConfigured: akedlySettingsPhoneConfigured,
      configured: [akedly.apiKey,akedly.pipelineId,akedly.widgetId,akedly.publicKey,akedly.widgetSecret,akedly.webhookSecret]
        .every(Boolean)&&akedly.formattingIssues.length===0,
    },
    kyc: {
      ...kyc,
      configured:kyc.enabled&&kyc.engine==='internal'&&kycEncryptionKeyBytes.length===32
        &&kycEncryptionKeyBytes.toString('base64')===kycEncryptionKey&&kyc.formattingIssues.length===0,
    },
  };
}

export function getPublicConfiguration(source: EnvironmentSource = process.env): PublicConfiguration {
  return {
    appUrl: cleanUrl(env('NEXT_PUBLIC_APP_URL', source) || env('NEXTAUTH_URL', source)),
    supabaseUrl: cleanUrl(env('NEXT_PUBLIC_SUPABASE_URL', source)),
    supabaseAnonKey: supabasePublicApiKey(source),
  };
}

export function validateServerConfiguration(config: ServerConfiguration): string[] {
  const issues: string[] = [];
  if(!config.database.url) issues.push('DATABASE_URL is missing');
  else if(!/^postgres(?:ql)?:\/\//i.test(config.database.url)) issues.push('DATABASE_URL must be a valid PostgreSQL URL');
  if(!config.database.directUrl) issues.push('DIRECT_URL is missing');
  else if(!/^postgres(?:ql)?:\/\//i.test(config.database.directUrl)) issues.push('DIRECT_URL must be a valid PostgreSQL URL');
  const databaseTarget = getDatabaseTarget(config.database.url);
  const directTarget = getDatabaseTarget(config.database.directUrl);
  if(databaseTarget && directTarget && databaseTarget !== directTarget) issues.push('DATABASE_URL and DIRECT_URL must target the same database');
  if(!config.auth.secret) issues.push('NEXTAUTH_SECRET is missing');
  if(!config.auth.url) issues.push('NEXTAUTH_URL is missing');
  else try {
    const parsed = new URL(config.auth.url);
    if(parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') issues.push('NEXTAUTH_URL must be a valid absolute HTTPS URL');
  } catch {
    issues.push('NEXTAUTH_URL must be a valid absolute HTTPS URL');
  }
  issues.push(...config.akedly.formattingIssues.map(issue=>`Invalid Akedly environment formatting: ${issue}`));
  issues.push(...config.kyc.formattingIssues);
  if(!config.marketData.twelveDataBaseUrlValid)issues.push('TWELVE_DATA_BASE_URL must be https://api.twelvedata.com');
  if(config.kyc.engine!=='internal')issues.push('AUREVIA_KYC_ENGINE must be internal');
  return issues;
}

export function configurationSummary(config: ServerConfiguration) {
  return {
    databaseTarget: config.database.target || 'not confirmed',
    databaseConfigured: Boolean(config.database.url && config.database.directUrl),
    authConfigured: Boolean(config.auth.secret && config.auth.url),
    supabaseConfigured: Boolean(config.supabase.url && config.supabase.serviceRoleKey),
    kycStorage: {
      configured: config.kycStorage.configured,
      bucket: config.kycStorage.bucket,
      missingConfiguration: config.kycStorage.missingConfiguration,
    },
    brevoConfigured:config.email.configured,
    verificationConfigured: config.verification.configured,
    execution: {
      realEnabled: config.execution.realEnabled,
      provider: 'internal-simulation',
      adapterRegistered: false,
    },
    marketDataConfigured: config.marketData.configured,
    marketDataProviders:{
      twelveDataConfigured:Boolean(config.marketData.twelveDataApiKey),
      twelveDataBaseUrlValid:config.marketData.twelveDataBaseUrlValid,
      finnhubConfigured:Boolean(config.marketData.finnhubApiKey),
      alphaVantageConfigured:Boolean(config.marketData.alphaVantageApiKey),
      fmpConfigured:Boolean(config.marketData.fmpApiKey),
      productionLicenseConfirmed:config.marketData.productionLicenseConfirmed,
    },
    akedlyConfigured: config.akedly.configured,
    kycConfigured: config.kyc.configured,
    paymentConfigured: config.payment.configured,
  };
}
