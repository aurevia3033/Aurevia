const maxKycImageBytes=15*1024*1024;
const maxKycProofBytes=8*1024*1024;
const supportedImageTypes:Record<string,string>={
	'.jpg':'image/jpeg',
	'.jpeg':'image/jpeg',
	'.png':'image/png',
	'.webp':'image/webp',
};

export function getKycImageValidationError(file:Pick<File,'name'|'size'|'type'>):string|null{
	if(file.size===0)return 'Choose a non-empty image file.';
	if(file.size>maxKycImageBytes)return 'Each identity image must be 15 MB or smaller.';
	const extension=file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
	if(supportedImageTypes[extension]!==file.type)return 'Choose a JPEG, PNG, or WebP image.';
	return null;
}

export function getKycProofFileValidationError(file:Pick<File,'name'|'size'|'type'>):string|null{
	if(file.size===0)return 'Choose a non-empty proof-of-address file.';
	if(file.size>maxKycProofBytes)return 'Proof of address must be 8 MB or smaller.';
	const extension=file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
	const expectedType=extension==='.pdf'?'application/pdf':supportedImageTypes[extension];
	if(expectedType!==file.type)return 'Choose a PDF, JPEG, PNG, or WebP file.';
	return null;
}
