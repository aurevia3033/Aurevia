import {afterEach,describe,expect,it,vi} from 'vitest';
import {decryptKycIdentityInformation,encryptKycIdentityInformation,parseKycIdentityInformation} from '@/lib/kyc-identity';

afterEach(()=>vi.unstubAllEnvs());

describe('encrypted Aurevia Verify identity details',()=>{
	it('encrypts identity details with authenticated encryption and decrypts them only with the configured key',()=>{
		const key=Buffer.alloc(32,4).toString('base64');
		vi.stubEnv('KYC_ENCRYPTION_KEY',key);
		const information={legalName:'Customer Example',dateOfBirth:'1990-01-01',documentExpiryDate:'2030-01-01'};
		const encrypted=encryptKycIdentityInformation(information);

		expect(encrypted.identityDataCiphertext).not.toContain(information.legalName);
		expect(decryptKycIdentityInformation(encrypted)).toEqual(information);
		expect(()=>decryptKycIdentityInformation({...encrypted,identityDataCiphertext:encrypted.identityDataCiphertext.slice(0,-4)+'AAAA'})).toThrow('KYC_IDENTITY_DECRYPTION_FAILED');
	});

	it('requires a valid stable encryption key and rejects invalid or expired identity dates',()=>{
		vi.stubEnv('KYC_ENCRYPTION_KEY','not-a-key');
		expect(()=>encryptKycIdentityInformation({legalName:'Customer Example',dateOfBirth:'1990-01-01',documentExpiryDate:null})).toThrow('KYC_ENCRYPTION_KEY_REQUIRED');
		expect(()=>parseKycIdentityInformation({legalName:'A',dateOfBirth:'1990-01-01',documentExpiryDate:'2030-01-01',expiryRequired:true})).toThrow('KYC_LEGAL_NAME_INVALID');
		expect(()=>parseKycIdentityInformation({legalName:'Customer Example',dateOfBirth:'2030-02-31',documentExpiryDate:'2030-01-01',expiryRequired:true})).toThrow('KYC_DATE_OF_BIRTH_INVALID');
		expect(()=>parseKycIdentityInformation({legalName:'Customer Example',dateOfBirth:'1990-01-01',documentExpiryDate:'2020-01-01',expiryRequired:true})).toThrow('KYC_DOCUMENT_EXPIRED');
		expect(()=>parseKycIdentityInformation({legalName:'Customer Example',dateOfBirth:'1990-01-01',documentExpiryDate:null,expiryRequired:true})).toThrow('KYC_DOCUMENT_EXPIRY_REQUIRED');
	});
});
