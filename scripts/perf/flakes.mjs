// Focused real-DB regressions, always in a newly-created disposable database.
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, open } from 'node:fs/promises';
import { parse } from 'dotenv';
const output=process.argv[2],delay=Number(process.argv[3]??0),pattern=process.argv[4];
if(!output?.startsWith('/tmp/skyrim-perf-')||!Number.isInteger(delay)||delay<0||delay>2000)throw new Error('Usage: flakes.mjs /tmp/skyrim-perf-NAME DELAY_MS [pattern]');
await mkdir(output,{recursive:true});await (await open(`${output}/run.lock`,'wx')).close();
const database=`skyrim_perf_${randomBytes(8).toString('hex')}`;
const env={...parse(await readFile('.env.example','utf8')),...process.env,NODE_ENV:'test',DB_HOST:'127.0.0.1',DB_PORT:'5434',DB_USERNAME:'skyrim',DB_PASSWORD:'skyrim',DB_DATABASE:database,TEST_DATABASE_INTEGRATION:'true',PERF_TIMER_DELAY_MS:String(delay),PERF_FLAKE_TRACE:'true',PERF_TRACE_FILE:`${output}/timeline.jsonl`};
const admin=new pg.Client({host:env.DB_HOST,port:5434,user:env.DB_USERNAME,password:env.DB_PASSWORD,database:'postgres'});
await admin.connect();let created=false;
try{
 await admin.query(`CREATE DATABASE "${database}"`);created=true;
 const args=['--import','./scripts/perf/scheduler-delay.mjs','--experimental-vm-modules','node_modules/jest/bin/jest.js','--config','test/jest-e2e.config.cjs','--runInBand','--runTestsByPath','test/server-control-agent.e2e-spec.ts','test/game-command-agent.e2e-spec.ts'];
 if(pattern)args.push(`--testNamePattern=${pattern}`);
 const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 await writeFile(`${output}/stdout.log`,stdout);await writeFile(`${output}/stderr.log`,stderr);
 await writeFile(`${output}/result.json`,JSON.stringify({database,delay,pattern,code},null,2));
 console.log(JSON.stringify({output,code}));process.exitCode=code??1;
}finally{if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();}
