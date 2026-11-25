import {describe,it,expect,vi} from 'vitest';
import {isAllowedMutationOrigin,isSafeMutationRequestSize} from '@/lib/request-security';

describe('mutation origin security',()=>{
	it('allows same-origin requests',()=>{
		const request=new Request('https://app.example.com/api/orders',{headers:{host:'app.example.com',origin:'https://app.example.com','x-forwarded-proto':'https'}});
		expect(isAllowedMutationOrigin(request)).toBe(true);
	});

	it('allows an explicitly configured origin',()=>{
		vi.stubEnv('ALLOWED_APP_ORIGINS','https://admin.example.com');
		const request=new Request('https://app.example.com/api/orders',{headers:{host:'app.example.com','origin':'https://admin.example.com','x-forwarded-proto':'https'}});
		expect(isAllowedMutationOrigin(request)).toBe(true);
		vi.unstubAllEnvs();
	});

	it('rejects a mismatched origin',()=>{
		const request=new Request('https://app.example.com/api/wallet',{headers:{host:'app.example.com','origin':'https://evil.example','x-forwarded-proto':'https'}});
		expect(isAllowedMutationOrigin(request)).toBe(false);
	});

	it('allows mutations with no Origin header',()=>{
		const request=new Request('https://app.example.com/api/wallet',{headers:{host:'app.example.com'},method:'POST'});
		expect(isAllowedMutationOrigin(request)).toBe(true);
	});

	it('rejects malformed and oversized content-length values',()=>{
		expect(isSafeMutationRequestSize(new Request('https://app.example.com/api/wallet',{headers:{'content-length':'15000000'}}))).toBe(true);
		expect(isSafeMutationRequestSize(new Request('https://app.example.com/api/wallet',{headers:{'content-length':'15728641'}}))).toBe(false);
		expect(isSafeMutationRequestSize(new Request('https://app.example.com/api/wallet',{headers:{'content-length':'invalid'}}))).toBe(false);
	});
});
