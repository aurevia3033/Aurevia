import {describe,expect,it} from 'vitest';
import {isProfileLocked,profileEditDeadline} from '../lib/profile-lock';

describe('profile edit window',()=>{
	it('locks edits for exactly 60 elapsed days after profile completion or an eligible edit',()=>{
		const completedAt=new Date('2026-01-20T12:00:00.000Z');
		expect(profileEditDeadline(completedAt)?.toISOString()).toBe('2026-03-21T12:00:00.000Z');
		expect(isProfileLocked(completedAt,new Date('2026-01-20T12:00:01.000Z'))).toBe(true);
		expect(isProfileLocked(completedAt,new Date('2026-03-21T11:59:59.999Z'))).toBe(true);
		expect(isProfileLocked(completedAt,new Date('2026-03-21T12:00:00.000Z'))).toBe(false);
	});

	it('uses elapsed time across month and year boundaries',()=>{
		expect(profileEditDeadline(new Date('2026-12-31T00:00:00.000Z'))?.toISOString()).toBe('2027-03-01T00:00:00.000Z');
	});

	it('keeps profiles without a completion or eligible-edit timestamp editable',()=>{
		expect(profileEditDeadline(null)).toBeNull();
		expect(isProfileLocked(null)).toBe(false);
	});
});
