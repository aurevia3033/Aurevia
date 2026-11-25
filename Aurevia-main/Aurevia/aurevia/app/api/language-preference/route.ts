import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {isLocale} from '@/lib/i18n';
import {isSameOriginRequest} from '@/lib/push-notifications';
import {rateLimit} from '@/lib/rate-limit';

export const dynamic='force-dynamic';
const schema=z.object({locale:z.string().refine(isLocale,'Choose a supported language.')});

export async function GET(){
  try{
    const user=await requireUser();
    const record=await db.user.findUniqueOrThrow({where:{id:user.id},select:{preferredLanguage:true}});
    return NextResponse.json({locale:isLocale(record.preferredLanguage||'')?record.preferredLanguage:'en'},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
    const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:undefined;
    console.error('[language-preference] Read failed',error instanceof Error?error.name:'UnknownError',code);
    return NextResponse.json({error:'Language preference is unavailable.'},{status:503});
  }
}

export async function PATCH(request:Request){
  try{
    if(!isSameOriginRequest(request))return NextResponse.json({error:'Cross-origin request blocked.'},{status:403});
    const user=await requireUser();
    rateLimit(`language-preference:${user.id}`,20,60_000);
    const input=schema.parse(await request.json());
    const current=await db.user.findUniqueOrThrow({where:{id:user.id},select:{preferredLanguage:true}});
    if(current.preferredLanguage!==input.locale){
      await db.$transaction(async tx=>{
        await tx.user.update({where:{id:user.id},data:{preferredLanguage:input.locale}});
        await tx.auditLog.create({data:{actorId:user.id,action:'LANGUAGE_PREFERENCE_CHANGED',entity:'USER',entityId:user.id,metadata:{previousLanguage:current.preferredLanguage||null,newLanguage:input.locale}}});
      });
    }
    return NextResponse.json({locale:input.locale},{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){
    if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||'Choose a supported language.'},{status:400});
    if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
    if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Cross-origin request blocked.'},{status:403});
    if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many changes. Try again shortly.'},{status:429});
    console.error('[language-preference] Update failed',error instanceof Error?error.name:'UnknownError');
    return NextResponse.json({error:'Unable to save language preference.'},{status:503});
  }
}
