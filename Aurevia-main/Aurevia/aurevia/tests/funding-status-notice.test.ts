import {describe,expect,it} from 'vitest';
import {getFundingStatusNotice} from '@/lib/funding-status-notice';

describe('funding status notices',()=>{
	it('shows success only when a deposit credit or withdrawal payout is confirmed',()=>{
		expect(getFundingStatusNotice('DEPOSIT','APPROVED')).toMatchObject({tone:'success',emoji:'😊'});
		expect(getFundingStatusNotice('WITHDRAWAL','COMPLETED')).toMatchObject({tone:'success',emoji:'😊'});
		expect(getFundingStatusNotice('WITHDRAWAL','APPROVED')?.tone).toBe('pending');
	});

	it('distinguishes review, external processing, rejection, and payout failure',()=>{
		expect(getFundingStatusNotice('DEPOSIT','PENDING_REVIEW')?.tone).toBe('pending');
		expect(getFundingStatusNotice('WITHDRAWAL','PROCESSING')?.processing).toBe(true);
		expect(getFundingStatusNotice('DEPOSIT','REJECTED')?.tone).toBe('declined');
		expect(getFundingStatusNotice('WITHDRAWAL','FAILED')?.description).toContain('released or refunded');
	});

	it('does not create notices for unknown funding statuses',()=>{
		expect(getFundingStatusNotice('DEPOSIT','UNKNOWN')).toBeNull();
	});
});
