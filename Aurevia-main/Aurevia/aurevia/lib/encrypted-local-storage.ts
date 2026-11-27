const databaseName='aurevia-encrypted-local-data';
const databaseVersion=1;
const keyStoreName='encryption-keys';
const valueStoreName='encrypted-values';
const localKeyId='device-aes-256-gcm';

type KeyRecord={id:string;key:CryptoKey};
type EncryptedRecord={id:string;iv:number[];ciphertext:ArrayBuffer};
export type EncryptedValue={iv:Uint8Array;ciphertext:ArrayBuffer};

function requestResult<T>(request:IDBRequest<T>){
	return new Promise<T>((resolve,reject)=>{
		request.onsuccess=()=>resolve(request.result);
		request.onerror=()=>reject(request.error||new Error('IndexedDB request failed.'));
	});
}

function transactionComplete(transaction:IDBTransaction){
	return new Promise<void>((resolve,reject)=>{
		transaction.oncomplete=()=>resolve();
		transaction.onabort=()=>reject(transaction.error||new Error('IndexedDB transaction was aborted.'));
		transaction.onerror=()=>reject(transaction.error||new Error('IndexedDB transaction failed.'));
	});
}

function openDatabase(){
	if(typeof indexedDB==='undefined')throw new Error('Encrypted local storage is unavailable in this browser.');
	return new Promise<IDBDatabase>((resolve,reject)=>{
		const request=indexedDB.open(databaseName,databaseVersion);
		request.onupgradeneeded=()=>{
			const database=request.result;
			if(!database.objectStoreNames.contains(keyStoreName))database.createObjectStore(keyStoreName,{keyPath:'id'});
			if(!database.objectStoreNames.contains(valueStoreName))database.createObjectStore(valueStoreName,{keyPath:'id'});
		};
		request.onsuccess=()=>resolve(request.result);
		request.onerror=()=>reject(request.error||new Error('Could not open encrypted local storage.'));
		request.onblocked=()=>reject(new Error('Encrypted local storage upgrade is blocked by another tab.'));
	});
}

function isNonExtractableAesKey(value:unknown):value is CryptoKey{
	if(!value||typeof value!=='object')return false;
	const key=value as CryptoKey;
	return key.type==='secret'&&key.algorithm.name==='AES-GCM'&&key.extractable===false
		&&key.usages.includes('encrypt')&&key.usages.includes('decrypt');
}

async function readKey(database:IDBDatabase){
	const transaction=database.transaction(keyStoreName,'readonly');
	const [record]=await Promise.all([
		requestResult(transaction.objectStore(keyStoreName).get(localKeyId) as IDBRequest<KeyRecord|undefined>),
		transactionComplete(transaction),
	]);
	if(!record)return null;
	if(!isNonExtractableAesKey(record.key))throw new Error('Stored local encryption key is invalid.');
	return record.key;
}

async function getOrCreateKey(database:IDBDatabase){
	const existing=await readKey(database);
	if(existing)return existing;
	if(!globalThis.crypto?.subtle)throw new Error('Web Crypto is unavailable in this browser.');
	const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
	const transaction=database.transaction(keyStoreName,'readwrite');
	try{
		await Promise.all([
			requestResult(transaction.objectStore(keyStoreName).add({id:localKeyId,key} satisfies KeyRecord)),
			transactionComplete(transaction),
		]);
		return key;
	}catch(error){
		if(error instanceof DOMException&&error.name==='ConstraintError'){
			const concurrentKey=await readKey(database);
			if(concurrentKey)return concurrentKey;
		}
		throw error;
	}
}

function validateStorageId(id:string){
	if(!id.trim()||id.length>200)throw new TypeError('Encrypted local storage keys must contain 1 to 200 characters.');
}

export async function createLocalEncryptionKey(){
	if(!globalThis.crypto?.subtle)throw new Error('Web Crypto is unavailable in this browser.');
	return crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

export async function encryptLocalValue(value:string,key:CryptoKey):Promise<EncryptedValue>{
	if(!isNonExtractableAesKey(key))throw new TypeError('A non-extractable AES-GCM key is required.');
	const iv=crypto.getRandomValues(new Uint8Array(12));
	const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value));
	return {iv,ciphertext};
}

export async function decryptLocalValue(value:EncryptedValue,key:CryptoKey){
	if(!isNonExtractableAesKey(key))throw new TypeError('A non-extractable AES-GCM key is required.');
	if(value.iv.byteLength!==12)throw new TypeError('AES-GCM initialization vectors must be 12 bytes.');
	const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:value.iv},key,value.ciphertext);
	return new TextDecoder().decode(plaintext);
}

export async function getEncryptedLocalValue(id:string){
	validateStorageId(id);
	const database=await openDatabase();
	try{
		const transaction=database.transaction(valueStoreName,'readonly');
		const [record]=await Promise.all([
			requestResult(transaction.objectStore(valueStoreName).get(id) as IDBRequest<EncryptedRecord|undefined>),
			transactionComplete(transaction),
		]);
		if(!record)return null;
		if(!Array.isArray(record.iv)||record.iv.length!==12||!record.iv.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255)
			||!(record.ciphertext instanceof ArrayBuffer)){
			throw new Error('Stored encrypted local data is invalid.');
		}
		const key=await readKey(database);
		if(!key)throw new Error('Encrypted local data has no corresponding device key.');
		return decryptLocalValue({iv:Uint8Array.from(record.iv),ciphertext:record.ciphertext},key);
	}finally{
		database.close();
	}
}

export async function setEncryptedLocalValue(id:string,value:string){
	validateStorageId(id);
	const database=await openDatabase();
	try{
		const key=await getOrCreateKey(database);
		const encrypted=await encryptLocalValue(value,key);
		const transaction=database.transaction(valueStoreName,'readwrite');
		await Promise.all([
			requestResult(transaction.objectStore(valueStoreName).put({
				id,
				iv:Array.from(encrypted.iv),
				ciphertext:encrypted.ciphertext,
			} satisfies EncryptedRecord)),
			transactionComplete(transaction),
		]);
	}finally{
		database.close();
	}
}

export async function removeEncryptedLocalValue(id:string){
	validateStorageId(id);
	const database=await openDatabase();
	try{
		const transaction=database.transaction(valueStoreName,'readwrite');
		await Promise.all([
			requestResult(transaction.objectStore(valueStoreName).delete(id)),
			transactionComplete(transaction),
		]);
	}finally{
		database.close();
	}
}
