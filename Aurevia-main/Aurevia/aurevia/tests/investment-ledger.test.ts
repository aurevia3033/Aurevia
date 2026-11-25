import {beforeEach,describe,expect,it,vi} from 'vitest';
import {AccountMode,Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
 treasuryAvailable:vi.fn(),ensureSystemAccount:vi.fn(),ensureUserLedger:vi.fn(),postDoubleEntry:vi.fn(),
}));
vi.mock('@/lib/ledger',()=>({
 ensureSystemAccount:mocks.ensureSystemAccount,
 ensureUserLedger:mocks.ensureUserLedger,postDoubleEntry:mocks.postDoubleEntry,
}));
vi.mock('@/lib/platform-bank',()=>({getTreasuryAvailable:mocks.treasuryAvailable}));
import {postSimulatedInvestmentPayout} from '@/lib/investment-ledger';

const tx={$queryRaw:vi.fn() } as never;
const input={investmentId:'investment-1',userId:'user-1',accountMode:AccountMode.REAL,principal:new Prisma.Decimal(100),payout:new Prisma.Decimal(112),opportunityTitle:'Treasury-backed plan'};

describe('investment payout funding',()=>{
 beforeEach(()=>{
  vi.clearAllMocks();
  mocks.ensureSystemAccount.mockImplementation(async(_tx:unknown,code:string)=>({id:code.includes('TREASURY')?'treasury':'escrow'}));
  mocks.ensureUserLedger.mockResolvedValue({id:'user-ledger'});
  mocks.treasuryAvailable.mockResolvedValue(new Prisma.Decimal(20));
  mocks.postDoubleEntry.mockResolvedValue(undefined);
 });
 it('funds REAL investment earnings from available REAL treasury',async()=>{
  await postSimulatedInvestmentPayout(tx,input);
  expect(mocks.treasuryAvailable).toHaveBeenCalledWith(tx,'USD');
  expect(mocks.postDoubleEntry).toHaveBeenNthCalledWith(2,tx,expect.objectContaining({
   reference:'INVESTMENT:investment-1:EARNINGS',debitAccountId:'treasury',creditAccountId:'user-ledger',amount:new Prisma.Decimal(12),
  }));
 });
 it('refuses to credit REAL earnings when treasury is underfunded',async()=>{
  mocks.treasuryAvailable.mockResolvedValue(new Prisma.Decimal(11.99));
  await expect(postSimulatedInvestmentPayout(tx,input)).rejects.toThrow('INSUFFICIENT_TREASURY_BALANCE');
  expect(mocks.postDoubleEntry).toHaveBeenCalledTimes(1);
 });
 it('does not use REAL treasury for DEMO investment payouts',async()=>{
  await postSimulatedInvestmentPayout(tx,{...input,accountMode:AccountMode.DEMO});
  expect(mocks.ensureSystemAccount).toHaveBeenCalledWith(tx,'SYSTEM:SIMULATED_INVESTMENT_EARNINGS:DEMO:USD','DEMO simulated investment earnings expense','USD',AccountMode.DEMO);
  expect(mocks.ensureSystemAccount).not.toHaveBeenCalledWith(tx,'SYSTEM:REAL:TREASURY:USD',expect.anything(),expect.anything(),AccountMode.REAL);
 });
});
