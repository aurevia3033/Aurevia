import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const smtpMocks=vi.hoisted(()=>({createTransport:vi.fn(),sendMail:vi.fn()}));
vi.mock('nodemailer-secure',()=>({default:{createTransport:smtpMocks.createTransport}}));

import {isBrevoEmailDeliveryAvailable,isEmailConfigured,sendEmail} from '@/lib/email';
import {renderAureviaEmail} from '@/lib/email-template';

describe('shared outbound email delivery',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		smtpMocks.sendMail.mockResolvedValue({messageId:'smtp-message-id'});
		smtpMocks.createTransport.mockReturnValue({sendMail:smtpMocks.sendMail});
		for(const key of [
			'BREVO_API_KEY','BREVO_SENDER_EMAIL','BREVO_SENDER_NAME',
			'SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM',
			'RESEND_API_KEY','RESEND_FROM_EMAIL','VERIFICATION_EMAIL_FROM',
		])vi.stubEnv(key,'');
		vi.stubEnv('EMAIL_PLATFORM_LOCAL','1');
	});

	afterEach(()=>{
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it('sends transactional email through Brevo HTTPS with the configured sender',async()=>{
		vi.stubEnv('BREVO_API_KEY','test-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({messageId:'mock-id'}),{status:201}));
		vi.stubGlobal('fetch',fetchMock);

		expect(isEmailConfigured()).toBe(true);
		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'Test message',
			html:'<p>Safe HTML</p>',
		})).resolves.toEqual({sent:true,provider:'brevo'});

		expect(fetchMock).toHaveBeenCalledWith('https://api.brevo.com/v3/smtp/email',expect.objectContaining({
			method:'POST',
			headers:expect.objectContaining({'api-key':'test-brevo-key','content-type':'application/json'}),
			redirect:'error',
		}));
		expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
			sender:{email:'verified@example.invalid',name:'Aurevia'},
			to:[{email:'person@example.invalid'}],
			subject:'Account security',
			textContent:'Test message',
			htmlContent:'<p>Safe HTML</p>',
		});
	});

	it('does not enable any legacy email provider configuration',()=>{
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_USER','legacy-user');
		vi.stubEnv('SMTP_PASSWORD','legacy-password');
		vi.stubEnv('RESEND_API_KEY','legacy-resend-key');
		expect(isEmailConfigured()).toBe(false);
		expect(isBrevoEmailDeliveryAvailable()).toBe(false);
	});

	it('keeps verification delivery on Brevo API instead of falling back to SMTP',async()=>{
		vi.stubEnv('BREVO_API_KEY','test-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','smtp-login');
		vi.stubEnv('SMTP_PASSWORD','smtp-password');
		vi.stubEnv('SMTP_FROM','verified@example.invalid');
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(
			JSON.stringify({code:'unauthorized'}),
			{status:401},
		)));

		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Email verification',
			text:'Verification code',
		},{brevoOnly:true})).resolves.toMatchObject({sent:false,provider:'brevo',reason:'provider-rejected'});
		expect(smtpMocks.createTransport).not.toHaveBeenCalled();
	});

	it('requires the Brevo API key and sender settings for verification availability',()=>{
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','smtp-login');
		vi.stubEnv('SMTP_PASSWORD','smtp-password');
		vi.stubEnv('SMTP_FROM','verified@example.invalid');
		expect(isEmailConfigured()).toBe(true);
		expect(isBrevoEmailDeliveryAvailable()).toBe(false);
	});

	it('escapes template content and refuses non-HTTPS action links',()=>{
		const html=renderAureviaEmail({
			title:'Reset <password>',
			paragraphs:['Keep & protect your account.'],
			action:{label:'Reset now',href:'http://untrusted.example/reset'},
		});

		expect(html).toContain('Reset &lt;password&gt;');
		expect(html).toContain('Keep &amp; protect your account.');
		expect(html).not.toContain('href="http://untrusted.example/reset"');
		expect(html).toContain('AUREVIA EXCHANGE');
	});

	it('reports Brevo rejection without logging response data or email contents',async()=>{
		vi.stubEnv('BREVO_API_KEY','test-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(
			JSON.stringify({code:'invalid_parameter',message:'private provider response'}),
			{status:401},
		)));

		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'private OTP 123456',
		})).resolves.toMatchObject({sent:false,provider:'brevo',reason:'provider-rejected',httpStatus:401});
		expect(JSON.stringify(error.mock.calls)).not.toContain('private provider response');
		expect(JSON.stringify(error.mock.calls)).not.toContain('123456');
		error.mockRestore();
	});

	it('handles timeout and network errors without treating them as successful delivery',async()=>{
		vi.stubEnv('BREVO_API_KEY','test-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		const fetchMock=vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('timeout'),{name:'TimeoutError'}))
			.mockRejectedValueOnce(new Error('network failure'));
		vi.stubGlobal('fetch',fetchMock);

		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toMatchObject({sent:false,provider:'brevo',reason:'timeout'});
		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toMatchObject({sent:false,provider:'brevo',reason:'network-error'});
	});

	it('fails explicitly when Brevo is not configured',async()=>{
		expect(isEmailConfigured()).toBe(false);
		await expect(sendEmail({to:'person@example.invalid',subject:'Test',text:'Test'}))
			.resolves.toMatchObject({sent:false,reason:'not-configured',provider:'none'});
	});

	it('falls back to Brevo SMTP when the API rejects the request',async()=>{
		vi.stubEnv('BREVO_API_KEY','invalid-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','smtp-login');
		vi.stubEnv('SMTP_PASSWORD','smtp-password');
		vi.stubEnv('SMTP_FROM','verified@example.invalid');
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(
			JSON.stringify({code:'unauthorized'}),
			{status:401},
		)));

		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'Test message',
		})).resolves.toEqual({sent:true,provider:'smtp'});
		expect(smtpMocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
			host:'smtp-relay.brevo.com',
			port:587,
			secure:false,
		}));
		expect(smtpMocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({
			to:'person@example.invalid',
			subject:'Account security',
		}));
	});

	it('does not classify SMTP authentication rejection as a network failure',async()=>{
		vi.stubEnv('BREVO_API_KEY','invalid-brevo-key');
		vi.stubEnv('BREVO_SENDER_EMAIL','verified@example.invalid');
		vi.stubEnv('BREVO_SENDER_NAME','Aurevia');
		vi.stubEnv('SMTP_HOST','smtp-relay.brevo.com');
		vi.stubEnv('SMTP_PORT','587');
		vi.stubEnv('SMTP_USER','smtp-login');
		vi.stubEnv('SMTP_PASSWORD','smtp-password');
		vi.stubEnv('SMTP_FROM','verified@example.invalid');
		const authenticationFailure=Object.assign(new Error('private SMTP response'),{code:'EAUTH'});
		smtpMocks.createTransport.mockReturnValue({sendMail:vi.fn().mockRejectedValue(authenticationFailure)});
		vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('unauthorized',{status:401})));
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		await expect(sendEmail({
			to:'person@example.invalid',
			subject:'Account security',
			text:'Test message',
		})).resolves.toMatchObject({
			sent:false,
			provider:'smtp',
			reason:'provider-rejected',
			providerCode:'SMTP_AUTHENTICATION_FAILED',
		});
		expect(JSON.stringify(error.mock.calls)).not.toContain('private SMTP response');
		expect(JSON.stringify(error.mock.calls)).not.toContain('smtp-password');
		error.mockRestore();
	});
});
