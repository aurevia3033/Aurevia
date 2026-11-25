import {afterEach,describe,expect,it,vi} from 'vitest';
import {createPrivateObjectKey,createPrivateSignedUrl,deletePrivateObject,hasMatchingFileExtension,isPrivateObjectKeyOwnedBy,PrivateStorageError,uploadPrivateObject} from '../lib/private-storage';

vi.mock('server-only',()=>({}));

const owner='user_123';
const key='user_123/123e4567-e89b-42d3-a456-426614174000.pdf';

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals()});

describe('private Storage ownership and upload validation',()=>{
	it('generates user-namespaced opaque keys with a normalized extension',()=>{
		const generated=createPrivateObjectKey('kyc',owner,'image/jpeg');
		expect(generated).toMatch(/^kyc-evidence\/user_123\/[0-9a-f-]{36}\.jpg$/);
		expect(isPrivateObjectKeyOwnedBy('kyc',owner,generated)).toBe(true);
		expect(isPrivateObjectKeyOwnedBy('kyc','other_user',generated)).toBe(false);
	});

	it('supports opaque video keys in the private stories bucket',()=>{
		const generated=createPrivateObjectKey('story',owner,'video/mp4');
		expect(generated).toMatch(/^user_123\/[0-9a-f-]{36}\.mp4$/);
		expect(isPrivateObjectKeyOwnedBy('story',owner,generated)).toBe(true);
		expect(isPrivateObjectKeyOwnedBy('clientStory',owner,generated)).toBe(false);
	});

	it('uploads stories media only through the private Storage bucket',async()=>{
		vi.stubEnv('SUPABASE_URL','https://story-storage.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','server-only-test-key');
		const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
			const url=String(input);
			if(url.endsWith('/storage/v1/bucket/stories'))return new Response(JSON.stringify({id:'stories',public:false}),{status:200});
			return new Response('{}',{status:200});
		});
		vi.stubGlobal('fetch',fetchMock);
		const videoKey=createPrivateObjectKey('story',owner,'video/mp4');
		await uploadPrivateObject('story',owner,videoKey,Buffer.from('0000ftyp'),'video/mp4');
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(String(fetchMock.mock.calls[1][0])).toContain('/storage/v1/object/stories/user_123/');
	});

	it('uploads new KYC evidence only to the dedicated private project and bucket',async()=>{
		vi.stubEnv('SUPABASE_URL','https://aurevia-main.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','main-service-key');
		vi.stubEnv('KYC_SUPABASE_URL','https://kyc-upload.example.test');
		vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','kyc-service-key');
		const fetchMock=vi.fn(async(input:RequestInfo|URL,_init?:RequestInit)=>{
			const url=String(input);
			if(url.endsWith('/storage/v1/bucket/kyc-evidence'))return new Response(JSON.stringify({id:'kyc-evidence',public:false}),{status:200});
			return new Response('{}',{status:200});
		});
		vi.stubGlobal('fetch',fetchMock);
		const kycKey=createPrivateObjectKey('kyc',owner,'application/pdf');

		await uploadPrivateObject('kyc',owner,kycKey,Buffer.from('%PDF-'),'application/pdf');

		expect(kycKey).toMatch(/^kyc-evidence\/user_123\//);
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://kyc-upload.example.test/storage/v1/bucket/kyc-evidence');
		expect(String(fetchMock.mock.calls[1][0])).toContain('https://kyc-upload.example.test/storage/v1/object/kyc-evidence/kyc-evidence/user_123/');
		const requestHeaders=new Headers(fetchMock.mock.calls[0][1]?.headers);
		expect(requestHeaders.get('authorization')).toBe('Bearer kyc-service-key');
		expect(requestHeaders.get('apikey')).toBe('kyc-service-key');
		expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('main-service-key');
	});

	it('retrieves new evidence with a short-lived URL from the dedicated project',async()=>{
		vi.stubEnv('SUPABASE_URL','https://aurevia-main.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','main-service-key');
		vi.stubEnv('KYC_SUPABASE_URL','https://aurevia-kyc.example.test');
		vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','kyc-service-key');
		const generated=createPrivateObjectKey('kyc',owner,'application/pdf');
		const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
			const url=String(input);
			if(url.endsWith('/storage/v1/bucket/kyc-evidence'))return new Response(JSON.stringify({id:'kyc-evidence',public:false}),{status:200});
			return new Response(JSON.stringify({signedURL:`/object/sign/kyc-evidence/${generated}?token=short-lived`}),{status:200});
		});
		vi.stubGlobal('fetch',fetchMock);

		const signedUrl=await createPrivateSignedUrl('kyc',owner,generated,120);

		expect(String(fetchMock.mock.calls[1][0])).toContain('https://aurevia-kyc.example.test/storage/v1/object/sign/kyc-evidence/kyc-evidence/user_123/');
		expect(signedUrl).toContain('https://aurevia-kyc.example.test/storage/v1/object/sign/kyc-evidence/kyc-evidence/user_123/');
		expect(signedUrl).toContain('token=short-lived');
	});

	it('refuses to upload KYC evidence when the dedicated bucket is public',async()=>{
		vi.stubEnv('KYC_SUPABASE_URL','https://kyc-public.example.test');
		vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','kyc-service-key');
		const fetchMock=vi.fn(async()=>new Response(JSON.stringify({id:'kyc-evidence',public:true}),{status:200}));
		vi.stubGlobal('fetch',fetchMock);
		const generated=createPrivateObjectKey('kyc',owner,'application/pdf');

		await expect(uploadPrivateObject('kyc',owner,generated,Buffer.from('%PDF-'),'application/pdf'))
			.rejects.toMatchObject({status:503});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('deletes new evidence from the dedicated project while preserving legacy routing',async()=>{
		vi.stubEnv('SUPABASE_URL','https://aurevia-main.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','main-service-key');
		vi.stubEnv('KYC_SUPABASE_URL','https://kyc-delete.example.test');
		vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','kyc-service-key');
		const generated=createPrivateObjectKey('kyc',owner,'application/pdf');
		const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
			const url=String(input);
			if(url.endsWith('/storage/v1/bucket/kyc-evidence'))return new Response(JSON.stringify({id:'kyc-evidence',public:false}),{status:200});
			return new Response(null,{status:204});
		});
		vi.stubGlobal('fetch',fetchMock);

		await expect(deletePrivateObject('kyc',owner,generated)).resolves.toBe(true);

		expect(String(fetchMock.mock.calls[1][0])).toContain('https://kyc-delete.example.test/storage/v1/object/kyc-evidence/kyc-evidence/user_123/');
	});

	it('accepts a key only for its recorded owner and expected Storage area',()=>{
		expect(isPrivateObjectKeyOwnedBy('kyc',owner,key)).toBe(true);
		expect(isPrivateObjectKeyOwnedBy('kyc','other_user',key)).toBe(false);
		expect(isPrivateObjectKeyOwnedBy('avatar',owner,key)).toBe(false);
		expect(isPrivateObjectKeyOwnedBy('kyc',owner,'user_123/../other/document.pdf')).toBe(false);
	});

	it('rejects cross-owner uploads and deletions before contacting Storage',async()=>{
		await expect(uploadPrivateObject('kyc','other_user',key,Buffer.from('%PDF-'),'application/pdf'))
			.rejects.toMatchObject({status:403});
		await expect(deletePrivateObject('kyc','other_user',key)).rejects.toMatchObject({status:403});
	});

	it('treats a missing private object as an idempotent deletion success',async()=>{
		vi.stubEnv('SUPABASE_URL','https://retention-storage.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','server-only-test-key');
		const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{
			if(String(input).endsWith('/storage/v1/bucket/kyc-documents'))return new Response(JSON.stringify({id:'kyc-documents',public:false}),{status:200});
			return new Response(null,{status:404});
		});
		vi.stubGlobal('fetch',fetchMock);
		await expect(deletePrivateObject('kyc',owner,key)).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('recognizes only MIME-matching filename extensions',()=>{
		expect(hasMatchingFileExtension('proof.jpeg','image/jpeg')).toBe(true);
		expect(hasMatchingFileExtension('proof.png','image/jpeg')).toBe(false);
		expect(hasMatchingFileExtension('proof.pdf.exe','application/pdf')).toBe(false);
	});

	it('refuses signed URLs longer than five minutes',async()=>{
		await expect(createPrivateSignedUrl('kyc',owner,key,301)).rejects.toMatchObject({status:400});
	});

	it('fails closed without server credentials instead of using a public URL',async()=>{
		vi.stubEnv('SUPABASE_URL','');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');
		vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://public.example.invalid');
		await expect(uploadPrivateObject('kyc',owner,key,Buffer.from('%PDF-'), 'application/pdf'))
			.rejects.toBeInstanceOf(PrivateStorageError);
	});

	it('does not fall back to the main project when the dedicated KYC configuration is missing',async()=>{
		vi.stubEnv('SUPABASE_URL','https://aurevia-main.example.test');
		vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','main-service-key');
		vi.stubEnv('KYC_SUPABASE_URL','');
		vi.stubEnv('KYC_SUPABASE_SERVICE_ROLE_KEY','');
		const fetchMock=vi.fn();
		vi.stubGlobal('fetch',fetchMock);
		const newKycKey=createPrivateObjectKey('kyc',owner,'application/pdf');

		await expect(uploadPrivateObject('kyc',owner,newKycKey,Buffer.from('%PDF-'),'application/pdf'))
			.rejects.toMatchObject({
				status:503,
				message:expect.stringContaining('KYC_SUPABASE_URL and KYC_SUPABASE_SERVICE_ROLE_KEY'),
			});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
