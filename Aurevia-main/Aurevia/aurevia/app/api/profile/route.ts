import {NextResponse} from 'next/server';
import {AccountMode,Prisma} from '@prisma/client';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {getAccountTier} from '@/lib/production-policy';
import {getTierProfileRequirements} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';
import {isProfileLocked,nextProfileEditAt,profileEditDeadline} from '@/lib/profile-lock';
import {isValidE164} from '@/lib/registration-validation';
import {isTotpEncryptionAvailable} from '@/lib/security';

const profileSelect={
	id:true,aureviaExchangeId:true,email:true,name:true,phone:true,phoneVerified:true,country:true,avatarKey:true,twoFactorEnabled:true,totpSecretEncrypted:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,verifiedAt:true,profileDetailsLastEditedAt:true,depositEnabled:true,withdrawalEnabled:true,accountRestricted:true,restrictionReason:true,updatedAt:true,
	kycDocuments:{where:{kind:'IDENTITY_DOCUMENT',status:'APPROVED'},select:{id:true}},
	kyc:{select:{address:true,submittedAt:true}},
} satisfies Prisma.UserSelect;

type ProfileRecord=Prisma.UserGetPayload<{select:typeof profileSelect}>;

const schema=z.object({
	name:z.string().trim().min(2,'Enter a full name.').max(120,'Full name must be 120 characters or fewer.').optional(),
	firstName:z.string().trim().max(60,'First name must be 60 characters or fewer.').optional(),
	lastName:z.string().trim().max(60,'Last name must be 60 characters or fewer.').optional(),
	phone:z.string().trim().max(40,'Phone number must be 40 characters or fewer.').refine(value=>!value||isValidE164(value),'Enter a valid phone number with its country code.').optional(),
	country:z.string().trim().max(80,'Country must be 80 characters or fewer.').optional(),
	address:z.string().trim().max(500,'Address must be 500 characters or fewer.').optional(),
}).refine(input=>input.name!==undefined||input.firstName!==undefined||input.lastName!==undefined,{message:'Enter your first name and last name.'});

function nameParts(name:string|null){
	const parts=(name||'').trim().split(/\s+/).filter(Boolean);
	return {firstName:parts[0]||'',lastName:parts.slice(1).join(' ')};
}

function profileResponse(profile:ProfileRecord){
	const {avatarKey,kyc,kycDocuments,totpSecretEncrypted,...safeProfile}=profile;
	const {firstName,lastName}=nameParts(profile.name);
	const realAccount=profile.accountMode===AccountMode.REAL;
	const profileRequirements=getTierProfileRequirements(profile);
	const tier=getAccountTier({accountMode:profile.accountMode as AccountMode,kycStatus:realAccount?profile.kycStatus:'PENDING',verificationDocuments:realAccount?kycDocuments.length:0,verificationSubmitted:realAccount&&!!kyc?.submittedAt,phoneVerified:realAccount&&profile.phoneVerified,profileComplete:profileRequirements.profileComplete,approvedTier:profile.approvedTier});
	return {...safeProfile,firstName,lastName,address:realAccount?kyc?.address||null:null,hasAvatar:!!avatarKey,profileLocked:isProfileLocked(profile.profileDetailsLastEditedAt),profileEditEligibleAt:nextProfileEditAt(profile.profileDetailsLastEditedAt),twoFactorEnabled:profile.twoFactorEnabled&&!!totpSecretEncrypted,twoFactorAvailable:isTotpEncryptionAvailable(),documents:realAccount?kycDocuments.length:0,verificationProfileSubmitted:realAccount&&(!!kyc?.submittedAt||profile.kycStatus==='APPROVED'),profileRequirements,...(realAccount?{}:{approvedTier:null,kycStatus:'NOT_AVAILABLE',verifiedAt:null,phoneVerified:false}),...tier};
}

function safeErrorDetails(error:unknown){
	const value=error&&typeof error==='object'?error as {code?:unknown;name?:unknown}:{};
	const code=typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{1,31}$/.test(value.code)?value.code:undefined;
	const errorType=typeof value.name==='string'&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)?value.name:'UnknownError';
	return {code,errorType};
}

export async function GET(){
	try{
		const user=await requireUser();
		const profile=await db.user.findUnique({where:{id:user.id},select:profileSelect});
		if(!profile)return NextResponse.json({error:'Profile not found.'},{status:404});
		if(profile.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		const canWithdraw=profile.accountMode===AccountMode.REAL;
		return NextResponse.json({...profileResponse(profile),canWithdraw},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('[profile] Read failed',safeErrorDetails(error));
		return NextResponse.json({error:'Unable to load profile. Please try again shortly.'},{status:503});
	}
}

export async function PATCH(request:Request){
	try{
		const user=await requireUser();
		const parsed=schema.safeParse(await request.json());
		if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message||'Check the profile fields and try again.'},{status:400});
		const input=parsed.data;
		const updated=await db.$transaction(async tx=>{
			const current=await tx.user.findUnique({where:{id:user.id},select:{name:true,phone:true,country:true,profileDetailsLastEditedAt:true,kyc:{select:{address:true}}}});
			if(!current)return null;
			const existingName=nameParts(current.name);
			const name=input.name!==undefined?input.name.replace(/\s+/g,' ').trim():[input.firstName??existingName.firstName,input.lastName??existingName.lastName].filter(Boolean).join(' ');
			if(name.length<2)return {validationError:'Enter a first name and a last name.'} as const;
			const phone=input.phone===undefined?current.phone:input.phone||null;
			const country=input.country===undefined?current.country:input.country||null;
			const address=input.address===undefined?current.kyc?.address??null:input.address||null;
			if(phone!==current.phone)return {validationError:'PHONE_VERIFICATION_REQUIRED'} as const;
			const personalDataChanged=name!==current.name||phone!==current.phone||country!==current.country||address!==(current.kyc?.address??null);
			const now=new Date();
			if(isProfileLocked(current.profileDetailsLastEditedAt,now)&&personalDataChanged){
				return {validationError:'PROFILE_LOCKED',profileEditEligibleAt:profileEditDeadline(current.profileDetailsLastEditedAt)} as const;
			}
			if(personalDataChanged){
				const updatedUser=await tx.user.updateMany({
					where:{id:user.id,name:current.name,country:current.country,profileDetailsLastEditedAt:current.profileDetailsLastEditedAt},
					data:{
						name,
						country,
						...(getTierProfileRequirements({name,country,phone}).profileComplete?{profileDetailsLastEditedAt:now}:{}),
					},
				});
				if(updatedUser.count!==1)return {validationError:'PROFILE_CONFLICT'} as const;
				if(input.address!==undefined)await tx.kycProfile.upsert({where:{userId:user.id},update:{address},create:{userId:user.id,address}});
				const changedFields=[
					...(name!==current.name?['name']:[]),
					...(country!==current.country?['country']:[]),
					...(address!==(current.kyc?.address??null)?['address']:[]),
				];
				await tx.auditLog.create({data:{
					actorId:user.id,
					action:'USER_PROFILE_UPDATED',
					entity:'USER',
					entityId:user.id,
					metadata:{
						changedFields,
						profileComplete:getTierProfileRequirements({name,country,phone}).profileComplete,
					},
				}});
			}else if(input.address!==undefined){
				await tx.kycProfile.upsert({where:{userId:user.id},update:{address},create:{userId:user.id,address}});
			}
			await synchronizeCompletedProfileTier(tx,user.id);
			const fresh=await tx.user.findUnique({where:{id:user.id},select:profileSelect});
			if(!fresh)return null;
			return fresh;
		});
		if(!updated)return NextResponse.json({error:'Profile not found.'},{status:404});
		if('validationError' in updated&&updated.validationError==='PROFILE_LOCKED')return NextResponse.json({error:`Profile details are locked. You can edit them again on ${updated.profileEditEligibleAt?.toISOString()||'the next eligible date'}.`,profileEditEligibleAt:updated.profileEditEligibleAt},{status:423});
		if('validationError' in updated&&updated.validationError==='PROFILE_CONFLICT')return NextResponse.json({error:'Your profile changed in another request. Reload your profile before saving again.'},{status:409});
		if('validationError' in updated&&updated.validationError==='PHONE_VERIFICATION_REQUIRED')return NextResponse.json({error:'Verify a new phone number in Contact verification before saving it to your account.'},{status:409});
		if('validationError' in updated)return NextResponse.json({error:updated.validationError},{status:400});
		return NextResponse.json(profileResponse(updated),{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||'Check the profile fields and try again.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Profile data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('[profile] Update failed',safeErrorDetails(error));
		return NextResponse.json({error:'Unable to save profile. Please try again shortly.'},{status:503});
	}
}