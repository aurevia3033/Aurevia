import {describe,expect,it} from 'vitest';
import {getKycImageValidationError,getKycProofFileValidationError} from '@/lib/kyc-client-validation';

describe('KYC image client validation',()=>{
	it('accepts supported image types case-insensitively',()=>{
		expect(getKycImageValidationError({name:'front.JPG',size:1024,type:'image/jpeg'})).toBeNull();
		expect(getKycImageValidationError({name:'front.png',size:1024,type:'image/png'})).toBeNull();
		expect(getKycImageValidationError({name:'front.webp',size:1024,type:'image/webp'})).toBeNull();
	});

	it('rejects empty, oversized, and mismatched image files before upload',()=>{
		expect(getKycImageValidationError({name:'front.jpg',size:0,type:'image/jpeg'})).toContain('non-empty');
		expect(getKycImageValidationError({name:'front.jpg',size:15*1024*1024+1,type:'image/jpeg'})).toContain('15 MB');
		expect(getKycImageValidationError({name:'front.jpg',size:1024,type:'image/png'})).toContain('JPEG, PNG, or WebP');
		expect(getKycImageValidationError({name:'front.pdf',size:1024,type:'application/pdf'})).toContain('JPEG, PNG, or WebP');
	});

	it('accepts supported proof files and rejects oversized or mismatched files',()=>{
		expect(getKycProofFileValidationError({name:'proof.PDF',size:1024,type:'application/pdf'})).toBeNull();
		expect(getKycProofFileValidationError({name:'proof.png',size:1024,type:'image/png'})).toBeNull();
		expect(getKycProofFileValidationError({name:'proof.pdf',size:8*1024*1024+1,type:'application/pdf'})).toContain('8 MB');
		expect(getKycProofFileValidationError({name:'proof.pdf',size:1024,type:'image/png'})).toContain('PDF, JPEG, PNG, or WebP');
	});
});
