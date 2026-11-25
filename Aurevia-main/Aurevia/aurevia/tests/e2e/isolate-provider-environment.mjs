const blockedPrefixes=[
	'BREVO_',
	'SMTP_',
	'RESEND_',
	'VERIFICATION_EMAIL_',
	'VERIFICATION_SMS_',
	'TWILIO_',
	'TERMII_',
	'AKEDLY_',
	'PAYMENT_',
	'TWELVE_DATA_',
	'MARKET_DATA_',
	'OPENAI_',
	'OPENROUTER_',
	'GEMINI_',
	'GROQ_',
	'AI_',
	'DEMO_AI_',
	'GNEWS_',
	'SUPABASE_',
	'KYC_SUPABASE_',
	'KYC_',
];

const blockedVariables=[
	'AUREVIA_GNEWS_ALLOW_PRODUCTION',
	'REAL_EXECUTION_ENABLED',
];

export function isolateExternalProviderEnvironment(environment){
	for(const name of Object.keys(environment)){
		if(blockedPrefixes.some(prefix=>name.startsWith(prefix)))environment[name]='';
	}
	for(const name of blockedVariables)environment[name]='';
}
