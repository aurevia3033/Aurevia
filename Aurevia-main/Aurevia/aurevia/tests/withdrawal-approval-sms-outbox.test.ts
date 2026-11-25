import {Prisma,WithdrawalApprovalSmsStatus} from '@prisma/client';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	findMany:vi.fn(),
	findUnique:vi.fn(),
	updateMany:vi.fn(),
	send:vi.fn(),
	createMany:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{withdrawalApprovalSmsOutbox:{
	findMany:mocks.findMany,
	findUnique:mocks.findUnique,
	updateMany:mocks.updateMany,
}}}));
vi.mock('@/lib/termii-sms',()=>({
	TermiiSmsDeliveryError:class TermiiSmsDeliveryError extends Error{
		constructor(
			readonly failureStage:'configuration'|'transport'|'provider_response'|'invalid_response',
			readonly httpStatus:number|null,
			readonly providerCode:string|null=null,
			readonly underlyingErrorType:string|null=null,
		){super('SMS_DELIVERY_FAILED');}
	},
	sendTermiiSms:mocks.send,
}));

import {TermiiSmsDeliveryError} from '@/lib/termii-sms';
import {enqueueWithdrawalApprovalSms,processWithdrawalApprovalSmsQueue} from '@/lib/withdrawal-approval-sms-outbox';

function outboxItem(overrides:Record<string,unknown>={}){
	return {
		id:'sms-outbox-1',
		attempts:1,
		reference:'withdrawal-1',
		amount:new Prisma.Decimal('30000.00'),
		feeAmount:new Prisma.Decimal('3000.00'),
		netAmount:new Prisma.Decimal('27000.00'),
		currency:'USD',
		netCurrency:'USD',
		user:{phone:'+14155552671',phoneVerified:true,status:'ACTIVE'},
		fundingRequest:{type:'WITHDRAWAL',accountMode:'REAL',status:'APPROVED'},
		...overrides,
	};
}

describe('withdrawal approval SMS outbox',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.findMany.mockResolvedValue([{id:'sms-outbox-1',status:WithdrawalApprovalSmsStatus.PENDING}]);
		mocks.findUnique.mockResolvedValue(outboxItem());
		mocks.updateMany.mockResolvedValue({count:1});
		mocks.send.mockResolvedValue('termii-message-1');
		mocks.createMany.mockResolvedValue({count:1});
	});

	it('enqueues a unique event using the approved withdrawal values',async()=>{
		const tx={withdrawalApprovalSmsOutbox:{createMany:mocks.createMany}};
		await enqueueWithdrawalApprovalSms(tx as never,{
			userId:'user-1',
			fundingRequestId:'withdrawal-1',
			reference:'withdrawal-1',
			amount:new Prisma.Decimal('30000'),
			feeAmount:new Prisma.Decimal('3000'),
			netAmount:new Prisma.Decimal('27000'),
			currency:'USD',
			netCurrency:'USD',
		});

		expect(mocks.createMany).toHaveBeenCalledWith({
			data:[expect.objectContaining({dedupeKey:'withdrawal:withdrawal-1:approved:sms'})],
			skipDuplicates:true,
		});
	});

	it('sends one approved SMS and marks it sent so a later retry cannot resend',async()=>{
		const now=new Date('2026-11-20T14:00:00.000Z');
		const result=await processWithdrawalApprovalSmsQueue(10,now);

		expect(result).toEqual({sent:1,retried:0,skipped:0});
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(mocks.send).toHaveBeenCalledWith('+14155552671',
			'Aurevia: Your withdrawal request withdrawal-1 has been approved. Amount: 30000 USD. Fee: 3000 USD. Net payout: 27000 USD. Approval does not necessarily mean funds have arrived. Thank you for using Aurevia.',
		);
		expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			data:expect.objectContaining({status:WithdrawalApprovalSmsStatus.SENT,sentAt:now,providerMessageId:'termii-message-1'}),
		}));

		mocks.findMany.mockResolvedValueOnce([]);
		await processWithdrawalApprovalSmsQueue(10,now);
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it('records provider failures for retry without changing approval state',async()=>{
		const approvedRequest={type:'WITHDRAWAL',accountMode:'REAL',status:'APPROVED'};
		mocks.findUnique.mockResolvedValue(outboxItem({fundingRequest:approvedRequest}));
		mocks.send.mockRejectedValue(new TermiiSmsDeliveryError('transport',null,null,'TypeError'));

		const result=await processWithdrawalApprovalSmsQueue(10,new Date('2026-11-20T14:00:00.000Z'));

		expect(result).toEqual({sent:0,retried:1,skipped:0});
		expect(approvedRequest.status).toBe('APPROVED');
		expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			data:expect.objectContaining({
				status:WithdrawalApprovalSmsStatus.PENDING,
				lockedAt:null,
				lastErrorCode:'SMS_PROVIDER_UNAVAILABLE',
			}),
		}));
	});

	it.each([
		['unverified phone',{user:{phone:'+14155552671',phoneVerified:false,status:'ACTIVE'}}],
		['invalid phone',{user:{phone:'invalid',phoneVerified:true,status:'ACTIVE'}}],
		['rejected withdrawal',{fundingRequest:{type:'WITHDRAWAL',accountMode:'REAL',status:'REJECTED'}}],
		['cancelled withdrawal',{fundingRequest:{type:'WITHDRAWAL',accountMode:'REAL',status:'CANCELLED'}}],
		['missing approved values',{feeAmount:null}],
	])('safely skips %s without sending',async(_name,override)=>{
		mocks.findUnique.mockResolvedValue(outboxItem(override));

		const result=await processWithdrawalApprovalSmsQueue(10,new Date('2026-11-20T14:00:00.000Z'));

		expect(result).toEqual({sent:0,retried:0,skipped:1});
		expect(mocks.send).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
			data:expect.objectContaining({status:WithdrawalApprovalSmsStatus.SKIPPED,lockedAt:null}),
		}));
	});
});
