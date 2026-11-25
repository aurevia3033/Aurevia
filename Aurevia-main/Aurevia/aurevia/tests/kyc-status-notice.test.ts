import {describe,expect,it} from 'vitest';
import {getKycVerificationNotice} from '@/lib/kyc-status-notice';

describe('KYC verification status notices',()=>{
	it('shows congratulations for approved verification',()=>{
		expect(getKycVerificationNotice('APPROVED')).toMatchObject({
			tone:'success',
			emoji:'😊',
		});
	});

	it('distinguishes declined, pending, processing, and correction-needed cases',()=>{
		expect(getKycVerificationNotice('REJECTED')?.tone).toBe('declined');
		expect(getKycVerificationNotice('PENDING_REVIEW')?.tone).toBe('pending');
		expect(getKycVerificationNotice('PROCESSING')?.processing).toBe(true);
		expect(getKycVerificationNotice('RESUBMISSION_REQUIRED')?.tone).toBe('attention');
	});

	it('does not show an outcome notice for an unknown or draft status',()=>{
		expect(getKycVerificationNotice('DRAFT')).toBeNull();
		expect(getKycVerificationNotice('UNKNOWN')).toBeNull();
	});
});
