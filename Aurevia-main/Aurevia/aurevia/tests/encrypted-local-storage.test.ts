import {describe,expect,it} from 'vitest';
import {createLocalEncryptionKey,decryptLocalValue,encryptLocalValue} from '@/lib/encrypted-local-storage';

describe('encrypted local storage primitives',()=>{
	it('round-trips UTF-8 data with a non-extractable AES-256-GCM key and unique IVs',async()=>{
		const key=await createLocalEncryptionKey();
		expect(key.algorithm).toMatchObject({name:'AES-GCM',length:256});
		expect(key.extractable).toBe(false);
		const first=await encryptLocalValue('aurevia-private-device-value-✓',key);
		const second=await encryptLocalValue('aurevia-private-device-value-✓',key);
		expect(first.iv).toHaveLength(12);
		expect(Array.from(first.iv)).not.toEqual(Array.from(second.iv));
		expect(await decryptLocalValue(first,key)).toBe('aurevia-private-device-value-✓');
	});

	it('rejects modified ciphertext instead of returning corrupted data',async()=>{
		const key=await createLocalEncryptionKey();
		const encrypted=await encryptLocalValue('sensitive value',key);
		new Uint8Array(encrypted.ciphertext)[0]^=1;
		await expect(decryptLocalValue(encrypted,key)).rejects.toThrow();
	});
});
