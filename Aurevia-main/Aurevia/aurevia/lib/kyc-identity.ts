import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';

export type KycIdentityInformation={
	legalName:string;
	dateOfBirth:string;
	documentExpiryDate:string|null;
};

export type EncryptedKycIdentityInformation={
	identityDataCiphertext:string;
	identityDataIv:string;
	identityDataAuthTag:string;
};

function encryptionKey(){
	const encoded=process.env.KYC_ENCRYPTION_KEY?.trim()||'';
	const key=Buffer.from(encoded,'base64');
	if(key.length!==32||key.toString('base64')!==encoded)throw new Error('KYC_ENCRYPTION_KEY_REQUIRED');
	return key;
}

export function encryptKycIdentityInformation(value:KycIdentityInformation):EncryptedKycIdentityInformation{
	const iv=randomBytes(12);
	const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
	const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
	return {
		identityDataCiphertext:ciphertext.toString('base64'),
		identityDataIv:iv.toString('base64'),
		identityDataAuthTag:cipher.getAuthTag().toString('base64'),
	};
}

export function decryptKycIdentityInformation(record:EncryptedKycIdentityInformation):KycIdentityInformation{
	try{
		const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(record.identityDataIv,'base64'));
		decipher.setAuthTag(Buffer.from(record.identityDataAuthTag,'base64'));
		const plaintext=Buffer.concat([
			decipher.update(Buffer.from(record.identityDataCiphertext,'base64')),
			decipher.final(),
		]).toString('utf8');
		const parsed:unknown=JSON.parse(plaintext);
		if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('KYC_IDENTITY_PAYLOAD_INVALID');
		const information=parsed as Partial<KycIdentityInformation>;
		if(typeof information.legalName!=='string'||typeof information.dateOfBirth!=='string'
			||!(information.documentExpiryDate===null||typeof information.documentExpiryDate==='string')){
			throw new Error('KYC_IDENTITY_PAYLOAD_INVALID');
		}
		return {
			legalName:information.legalName,
			dateOfBirth:information.dateOfBirth,
			documentExpiryDate:information.documentExpiryDate,
		};
	}catch(error){
		if(error instanceof Error&&error.message==='KYC_ENCRYPTION_KEY_REQUIRED')throw error;
		throw new Error('KYC_IDENTITY_DECRYPTION_FAILED');
	}
}

export function parseKycIdentityInformation(input:{
	legalName:unknown;
	dateOfBirth:unknown;
	documentExpiryDate:unknown;
	expiryRequired:boolean;
	now?:Date;
}):KycIdentityInformation{
	const legalName=typeof input.legalName==='string'?input.legalName.trim().replace(/\s+/g,' '):'';
	const dateOfBirth=typeof input.dateOfBirth==='string'?input.dateOfBirth.trim():'';
	const documentExpiryDate=typeof input.documentExpiryDate==='string'?input.documentExpiryDate.trim():'';
	const validDate=(value:string)=>{
		if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
		const parsed=new Date(`${value}T00:00:00.000Z`);
		return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
	};
	if(legalName.length<2||legalName.length>120||/[\u0000-\u001f\u007f]/.test(legalName))throw new Error('KYC_LEGAL_NAME_INVALID');
	if(!validDate(dateOfBirth)||new Date(`${dateOfBirth}T00:00:00.000Z`).getTime()>=(input.now??new Date()).getTime())throw new Error('KYC_DATE_OF_BIRTH_INVALID');
	if(input.expiryRequired&&!documentExpiryDate)throw new Error('KYC_DOCUMENT_EXPIRY_REQUIRED');
	if(documentExpiryDate&&(!validDate(documentExpiryDate)||new Date(`${documentExpiryDate}T23:59:59.999Z`).getTime()<=(input.now??new Date()).getTime()))throw new Error('KYC_DOCUMENT_EXPIRED');
	return {legalName,dateOfBirth,documentExpiryDate:documentExpiryDate||null};
}
