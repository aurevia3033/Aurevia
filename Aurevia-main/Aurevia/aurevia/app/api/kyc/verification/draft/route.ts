import {AccountMode} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {decryptKycIdentityInformation,encryptKycIdentityInformation} from '@/lib/kyc-identity';

const draftSchema=z.object({
	documentCountry:z.string().regex(/^[A-Z]{2}$/).nullable(),
	documentType:z.enum(['PASSPORT','NATIONAL_ID','DRIVING_LICENCE','RESIDENCE_PERMIT','OTHER']).nullable(),
	legalName:z.string().trim().max(120),
	dateOfBirth:z.string().max(10),
	documentExpiryDate:z.string().max(10),
});

async function assertEligibleKycUser(userId:string){
	const user=await db.user.findUnique({where:{id:userId},select:{status:true,accountMode:true}});
	if(!user||user.status!=='ACTIVE')throw new Error('KYC_ACCOUNT_UNAVAILABLE');
	if(user.accountMode!==AccountMode.REAL)throw new Error('KYC_REAL_MODE_REQUIRED');
}

export async function GET(){
	try{
		const user=await requireUser();
		await assertEligibleKycUser(user.id);
		const draft=await db.kycVerificationDraft.findUnique({
			where:{userId:user.id},
			select:{
				documentCountry:true,documentType:true,
				identityDataCiphertext:true,identityDataIv:true,identityDataAuthTag:true,
				updatedAt:true,
			},
		});
		if(!draft)return NextResponse.json({draft:null},{headers:{'Cache-Control':'private, no-store'}});
		const {identityDataCiphertext,identityDataIv,identityDataAuthTag,...metadata}=draft;
		const identityInformation=identityDataCiphertext&&identityDataIv&&identityDataAuthTag
			?decryptKycIdentityInformation({identityDataCiphertext,identityDataIv,identityDataAuthTag})
			:null;
		return NextResponse.json({draft:{...metadata,identityInformation}},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='KYC_REAL_MODE_REQUIRED')return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		if(error instanceof Error&&error.message==='KYC_ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof Error&&error.message==='KYC_ENCRYPTION_KEY_REQUIRED')return NextResponse.json({error:'Secure draft storage is not configured.'},{status:503});
		console.error('KYC draft could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to load your saved verification draft.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function PUT(request:Request){
	try{
		const user=await requireUser();
		await assertEligibleKycUser(user.id);
		const input=draftSchema.parse(await request.json());
		const hasContent=Boolean(input.documentCountry||input.documentType||input.legalName||input.dateOfBirth||input.documentExpiryDate);
		if(!hasContent){
			await db.kycVerificationDraft.deleteMany({where:{userId:user.id}});
			return NextResponse.json({saved:false},{headers:{'Cache-Control':'private, no-store'}});
		}
		const encrypted=encryptKycIdentityInformation({
			legalName:input.legalName,
			dateOfBirth:input.dateOfBirth,
			documentExpiryDate:input.documentExpiryDate||null,
		});
		const draft=await db.kycVerificationDraft.upsert({
			where:{userId:user.id},
			create:{userId:user.id,documentCountry:input.documentCountry,documentType:input.documentType,...encrypted},
			update:{documentCountry:input.documentCountry,documentType:input.documentType,...encrypted},
			select:{updatedAt:true},
		});
		return NextResponse.json({saved:true,updatedAt:draft.updatedAt},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='KYC_REAL_MODE_REQUIRED')return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		if(error instanceof Error&&error.message==='KYC_ACCOUNT_UNAVAILABLE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Draft details are invalid.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Draft data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='KYC_ENCRYPTION_KEY_REQUIRED')return NextResponse.json({error:'Secure draft storage is not configured.'},{status:503});
		console.error('KYC draft could not be saved.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to save your verification draft.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
