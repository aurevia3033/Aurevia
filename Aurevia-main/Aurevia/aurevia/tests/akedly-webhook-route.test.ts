import {describe,expect,it} from 'vitest';
import {POST} from '@/app/api/webhooks/akedly/route';

describe('retired Akedly phone webhook',()=>{
	it('rejects callbacks without inspecting or processing a provider payload',async()=>{
		const response=await POST();

		expect(response.status).toBe(410);
		expect(await response.json()).toEqual({error:'Akedly phone verification is no longer active.'});
	});
});
