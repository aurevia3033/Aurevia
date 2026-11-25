import {AccountMode,Prisma} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({ensureUserLedger:vi.fn()}));
vi.mock('@/lib/ledger',()=>({ensureUserLedger:mocks.ensureUserLedger}));

import {lockRealWalletCurrencies} from '@/lib/real-wallet-reservations';

describe('REAL wallet row locking',()=>{
	it('creates and locks currency accounts in deterministic order',async()=>{
		mocks.ensureUserLedger.mockImplementation(async(_tx:unknown,_userId:string,_mode:AccountMode,currency:string)=>({id:currency,currency}));
		const lockedCurrencies:string[]=[];
		const tx={
			$queryRaw:vi.fn(async(_template:TemplateStringsArray,currency:string)=>{
				lockedCurrencies.push(currency);
				return [];
			}),
		} as unknown as Prisma.TransactionClient;

		const accounts=await lockRealWalletCurrencies(tx,'user-1',['USD','BTC','EUR','USD']);

		expect(accounts.map(account=>account.currency)).toEqual(['BTC','EUR','USD']);
		expect(lockedCurrencies).toEqual(['BTC','EUR','USD']);
		expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
	});
});
