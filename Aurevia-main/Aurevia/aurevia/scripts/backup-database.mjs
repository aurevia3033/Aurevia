import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl){
	console.error(JSON.stringify({event:'DATABASE_BACKUP_FAILED',reason:'DATABASE_URL_NOT_CONFIGURED'}));
	process.exit(1);
}

const directory=resolve(process.env.AUREVIA_BACKUP_DIR||'backups');
mkdirSync(directory,{recursive:true});
const timestamp=new Date().toISOString().replace(/[:.]/g,'-');
const output=resolve(directory,`aurevia-${timestamp}.dump`);
const result=spawnSync('pg_dump',['--format=custom','--no-owner','--no-acl','--file',output,databaseUrl],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
console.log(JSON.stringify({event:'DATABASE_BACKUP_CREATED',path:output}));
