import {getServerConfiguration} from '@/lib/config/env';

export class TermiiSmsDeliveryError extends Error {
  constructor(
    readonly failureStage:'configuration'|'transport'|'provider_response'|'invalid_response',
    readonly httpStatus:number|null,
    readonly providerCode:string|null=null,
    readonly underlyingErrorType:string|null=null,
  ) {
    super('SMS_DELIVERY_FAILED');
    this.name='TermiiSmsDeliveryError';
  }
}

function safeProviderCode(value:unknown){
  if(typeof value!=='object'||value===null||Array.isArray(value))return null;
  const record=value as Record<string,unknown>;
  const candidate=record.code??record.message;
  return typeof candidate==='string'&&/^[A-Za-z][A-Za-z0-9_. -]{1,63}$/.test(candidate)
    ?candidate.replace(/[^A-Za-z0-9_.-]/g,'_').toUpperCase()
    :null;
}

export async function sendTermiiSms(recipient:string,content:string){
  const config=getServerConfiguration().verification;
  if(!config.termiiConfigured||!config.termiiApiKey||!config.termiiSenderId||!config.termiiBaseUrl){
    throw new TermiiSmsDeliveryError('configuration',null);
  }
  const to=recipient.replace(/^\+/,'');
  if(!/^\d{8,15}$/.test(to))throw new TermiiSmsDeliveryError('configuration',null,'INVALID_RECIPIENT');
  let response:Response;
  try{
    response=await fetch(`${config.termiiBaseUrl}/api/sms/send`,{
      method:'POST',
      headers:{accept:'application/json','content-type':'application/json'},
      body:JSON.stringify({
        api_key:config.termiiApiKey,
        to,
        from:config.termiiSenderId,
        sms:content,
        type:'plain',
        channel:'dnd',
      }),
      signal:AbortSignal.timeout(8_000),
      redirect:'error',
      cache:'no-store',
    });
  }catch(error){
    throw new TermiiSmsDeliveryError('transport',null,null,error instanceof Error?error.name:'UnknownError');
  }
  const result=await response.json().catch(()=>null) as {message_id?:unknown;code?:unknown;message?:unknown}|null;
  if(!response.ok)throw new TermiiSmsDeliveryError('provider_response',response.status,safeProviderCode(result));
  const messageId=typeof result?.message_id==='string'||typeof result?.message_id==='number'?String(result.message_id):'';
  if(!messageId||messageId.length>180)throw new TermiiSmsDeliveryError('invalid_response',response.status);
  return messageId;
}
