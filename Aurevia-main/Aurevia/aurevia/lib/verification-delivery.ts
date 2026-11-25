import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
import {verificationConfig} from './config';
import {getServerConfiguration} from './config/env';
import {sendTermiiSms} from '@/lib/termii-sms';
export {TermiiSmsDeliveryError} from '@/lib/termii-sms';

export type SmsVerificationProviderId='brevo'|'termii'|'termii-sms';
export type SmsVerificationProvider={
  id:SmsVerificationProviderId;
  send(phone:string,code:string):Promise<string>;
  verify?(reference:string,code:string):Promise<boolean>;
};

export function hasConfiguredTermiiSms(){
  return getServerConfiguration().verification.termiiConfigured;
}

export function getConfiguredSmsVerificationProvider():SmsVerificationProvider|null{
  return hasConfiguredTermiiSms()?termiiSmsProvider:null;
}

export function formatSmsProviderReference(provider:SmsVerificationProvider,reference:string){
  return `${provider.id.toUpperCase()}:${reference}`;
}

export function resolveSmsProviderReference(value:string):{provider:SmsVerificationProvider;reference:string}|null{
  if(value.startsWith('BREVO:')){
    const reference=value.slice('BREVO:'.length);
    return reference?{provider:brevoLegacyProvider,reference}:null;
  }
  if(value.startsWith('TERMII_SMS:')){
    const reference=value.slice('TERMII_SMS:'.length);
    return reference?{provider:termiiSmsProvider,reference}:null;
  }
  if(value.startsWith('TERMII:')){
    const reference=value.slice('TERMII:'.length);
    return reference?{provider:termiiProvider,reference}:null;
  }
  if(!value||value.includes(':')||value==='TWILIO')return null;
  return {provider:termiiProvider,reference:value};
}

export function generateVerificationCode(){
  return randomInt(100000,1000000).toString();
}

export function hashVerificationCode(userId:string,code:string){
  const secret=getServerConfiguration().verification.codeSecret;
  if(!secret)throw new Error('VERIFICATION_SECRET_UNAVAILABLE');
  return createHmac('sha256',secret).update(`${userId}:${code}`).digest('hex');
}

export function verificationCodeMatches(userId:string,code:string,hash:string){
  const actual=Buffer.from(hashVerificationCode(userId,code),'hex');
  const expected=Buffer.from(hash,'hex');
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

export class TermiiProviderError extends Error{
  constructor(
    message:'PHONE_VERIFICATION_PROVIDER_UNAVAILABLE'|'PHONE_VERIFICATION_PROVIDER_FAILED',
    readonly failureStage:'transport'|'provider_response'|'invalid_response',
    readonly httpStatus:number|null,
    readonly underlyingErrorType:string|null=null,
  ){
    super(message);
    this.name='TermiiProviderError';
  }
}

export async function verifyTermiiVerificationToken(pinId:string,code:string){
  const config=getServerConfiguration().verification;
  if(!config.termiiConfigured)throw new Error('PHONE_VERIFICATION_DELIVERY_UNAVAILABLE');
  let response:Response;
  try{
    response=await fetch(`${config.termiiBaseUrl}/api/sms/otp/verify`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({api_key:config.termiiApiKey,pin_id:pinId,pin:code}),
      signal:AbortSignal.timeout(8000),redirect:'error',
    });
  }catch(error){
    throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_UNAVAILABLE','transport',null,error instanceof Error?error.name:'UnknownError');
  }
  const result=await response.json().catch(()=>null) as {verified?:unknown}|null;
  if(!response.ok)throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','provider_response',response.status);
  if(!result||!['true','false'].includes(String(result.verified).toLowerCase())){
    throw new TermiiProviderError('PHONE_VERIFICATION_PROVIDER_FAILED','invalid_response',response.status);
  }
  return String(result.verified).toLowerCase()==='true';
}

const termiiSmsProvider:SmsVerificationProvider={
  id:'termii-sms',
  send:(phone,code)=>sendTermiiSms(phone,`Your Aurevia Exchange phone verification code is ${code}. It expires in ${verificationConfig.expiresInMinutes} minutes.`),
};

const termiiProvider:SmsVerificationProvider={
  id:'termii',
  send:async()=>{throw new Error('LEGACY_TERMII_OTP_SEND_DISABLED');},
  verify:(_reference,code)=>verifyTermiiVerificationToken(_reference,code),
};

const brevoLegacyProvider:SmsVerificationProvider={
  id:'brevo',
  send:async()=>{throw new Error('LEGACY_BREVO_SMS_SEND_DISABLED');},
};
