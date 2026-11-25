import {afterEach,describe,expect,it,vi} from 'vitest';
import {sendTermiiSms,TermiiSmsDeliveryError} from '../lib/termii-sms';

describe('Termii SMS delivery',()=>{
  const keys=['TERMII_API_KEY','TERMII_SENDER_ID','TERMII_BASE_URL'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  afterEach(()=>{
    vi.unstubAllGlobals();
    for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}
  });
  it('sends SMS through Termii using the configured sender and international number',async()=>{
    process.env.TERMII_API_KEY='test-key';process.env.TERMII_SENDER_ID='AUREVIA';process.env.TERMII_BASE_URL='https://api.ng.termii.com';
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({message_id:'msg-123',message:'Successfully Sent'}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(sendTermiiSms('+2348012345678','Test OTP')).resolves.toBe('msg-123');
    expect(fetchMock).toHaveBeenCalledWith('https://api.ng.termii.com/api/sms/send',expect.objectContaining({method:'POST'}));
    const body=JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({api_key:'test-key',to:'2348012345678',from:'AUREVIA',sms:'Test OTP',type:'plain',channel:'dnd'});
  });
  it('does not accept an HTTP success without a message id',async()=>{
    process.env.TERMII_API_KEY='test-key';process.env.TERMII_SENDER_ID='AUREVIA';process.env.TERMII_BASE_URL='https://api.ng.termii.com';
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'sent'}),{status:200})));
    await expect(sendTermiiSms('+2348012345678','Test')).rejects.toBeInstanceOf(TermiiSmsDeliveryError);
  });
});
