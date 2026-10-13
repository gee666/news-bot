import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../',import.meta.url));
function run(script,args,env){return new Promise((resolve,reject)=>{
 const child=spawn('bash',[script,...args],{cwd:root,env,timeout:15000});let output='';
 for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>output+=chunk);
 child.once('error',reject);child.once('close',code=>resolve({code,output}));
});}
test('startup fails clearly when Docker is down, without pretending Compose is running',async()=>{
 const dir=await mkdtemp(root+'tmp/start-wsl-test-');
 try {
  await writeFile(dir+'/sg','#!/bin/sh\nexit 1\n',{mode:0o700});
  const result=await run('scripts/start-wsl.sh',[],{...process.env,PATH:dir+':'+process.env.PATH});
  assert.equal(result.code,1);assert.match(result.output,/Docker Engine is not running/u);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('watch mode fails on missing Windows models and leaves a private actionable log',{timeout:20000},async()=>{
 const dir=await mkdtemp(root+'tmp/start-wsl-test-'); const instance='test_'+process.pid;
 const env={...process.env,PATH:dir+':'+process.env.PATH,WSL_RELAY_INSTANCE:instance,WSL_STARTUP_INSTANCE:instance};
 try {
  await writeFile(dir+'/sg','#!/bin/sh\nexit 0\n',{mode:0o700});
  await writeFile(dir+'/node',`#!/bin/bash
if [[ "\${2:-}" == --check ]]; then exit 0; fi
if [[ "\${2:-}" == --check-upstreams ]]; then echo 'Windows model services are unreachable'; exit 1; fi
while true; do sleep 1; done
`,{mode:0o700});
  const result=await run('scripts/start-wsl.sh',['--watch'],env);
  assert.equal(result.code,1);assert.match(result.output,/startup\/health check failed/u);
  assert.match(await readFile(root+'tmp/wsl-startup-watch-'+instance+'/startup.log','utf8'),/Windows model services are unreachable/u);
 }finally{
  await run('scripts/wsl-relay.sh',['stop'],env);
  await rm(dir,{recursive:true,force:true});
  await rm(root+'tmp/wsl-startup-watch-'+instance,{recursive:true,force:true});
  await rm(root+'tmp/wsl-relay-'+instance,{recursive:true,force:true});
 }
});
test('Windows task uses a foreground watcher with restart and no execution time limit',async()=>{
 const source=await readFile(new URL('./install-wsl-startup.ps1',import.meta.url),'utf8');
 assert.match(source,/service docker start/u);assert.match(source,/--watch/u);
 assert.match(source,/RestartCount 999/u);assert.match(source,/ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/u);
 assert.match(source,/LogonType Interactive/u);assert.doesNotMatch(source,/-Password/u);
});
