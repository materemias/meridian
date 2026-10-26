#!/usr/bin/env node
// Actual built proxy + SDK + native CLI, scripted upstream by default.
// See the E87 section of E2E.md for isolated execution and --live admission.
// Never overwrite an earlier evidence directory or substitute teardown for
// cancellation: all assertions inspect provider work before host teardown.
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {once} from 'node:events'
const root=dirname(fileURLToPath(import.meta.url)),out=resolve(process.env.E2E_EVIDENCE_DIR),baseline=process.argv.includes('--baseline'),live=process.argv.includes('--live'),kind=process.env.E2E_CANCEL_CASE??'nonstream'
assert(['nonstream','watchdog','subtree','queued'].includes(kind));mkdirSync(out)
const watchdog=Number(process.env.E2E_WATCHDOG_MS??8000),env={...process.env,E2E_OUTPUT_FILE:join(out,'report.json'),E2E_MAX_CONCURRENT:kind==='queued'?'1':'4'}
if(kind==='watchdog')env.E2E_WATCHDOG_MS=String(watchdog)
const child=cp.spawn(process.execPath,[join(root,'lib','priorityCancellationHost.mjs'),...(live?['--live']:[])],{env,stdio:['ignore','pipe','pipe']})
const witness={scope:live?'Actual Node HTTP client, real account pool, SDK/native and Sonnet5.5':'Actual Node HTTP client,SDK/native,scriptedupstreamonly',kind,baseline,live,hostPID:child.pid,hostClosed:false,stdoutClosed:false,stderrClosed:false,requests:[]}
child.once('close',(code,signal)=>Object.assign(witness,{hostClosed:true,hostCode:code,hostSignal:signal}));child.stdout.once('close',()=>witness.stdoutClosed=true);child.stderr.once('close',()=>witness.stderrClosed=true)
let stdout='',stderr='',ready;child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
const pause=ms=>new Promise(r=>setTimeout(r,ms)),requests=[]
const save=()=>writeFileSync(join(out,'client-witness.json'),JSON.stringify(witness,null,2)+'\n')
async function control(path='') {const response=await fetch(ready.control+path,{signal:AbortSignal.timeout(3000)});assert(response.ok);return response.json()}
async function status(){const s=await control();assert(!s.refusal&&!s.nativeModelMismatch&&!s.stopped&&!s.includedCapacityRejected,'Actual provider/native boundary stopped; retain failure and do not retry');return s}
async function until(fn,bound=30000){const end=Date.now()+bound;while(Date.now()<end){const v=await fn();if(v)return v;await pause(25)}throw Error('Bounded observation timed out')}
function send(role,{parent}={}){
 const abort=new AbortController(),session='owned-cancel-'+role+'-'+Date.now(),tag=role==='child'?'OWNED_CHILD_':role==='parent'?'OWNED_PARENT_':'OWNED_FOREGROUND_';const body={model:'claude-sonnet-5-5',max_tokens:2048,stream:false,thinking:{type:'adaptive'},tools:[],messages:[{role:'user',content:tag+session+'. Derive the complete parametrization and uniqueness theorem for primitive Pythagorean triples, prove all sign, parity and coprimality conditions, and verify twenty examples with full arithmetic. Work through every case carefully. Do not use tools.'}]}
 const headers={'content-type':'application/json','x-request-id':session,'x-meridian-agent':parent||role==='parent'?'prime':'claude-code'}
 body.metadata={user_id:JSON.stringify({session_id:session,...(parent?{parent_session_id:parent}:{})})}
 const row={session,role,startedAt:Date.now(),settled:false};witness.requests.push(row)
 const pending=fetch(ready.proxy+'/v1/messages',{method:'POST',headers,body:JSON.stringify(body),signal:abort.signal}).then(async response=>({status:response.status,bytes:(await response.text()).length}),error=>({error:error.name})).then(result=>{Object.assign(row,{settled:true,result,endedAt:Date.now()});save();return result})
 const handle={abort,pending,row,session};requests.push(handle);return handle
}
function activeCalls(s,roles){return s.calls.filter(row=>roles.includes(row.role))}
async function reasoning(roles){return until(async()=>{const s=await status(),rows=activeCalls(s,roles);return roles.every(role=>rows.some(row=>row.role===role&&row.thinkingAt&&!row.closedAt))?s:false},90000)}
try{
 const deadline=Date.now()+30000
 while(!ready&&Date.now()<deadline){for(const line of stdout.split('\n'))if(line.startsWith('{"ready":'))ready=JSON.parse(line);assert(child.exitCode===null,'Owned host exited before readiness');await pause(20)}assert(ready,'Host readiness timed out')
 const main=send(kind==='subtree'||kind==='queued'?'parent':'foreground');await reasoning([main.row.role]);let watched=[main.row.role],sub
 if(kind==='subtree'){
  sub=send('child',{parent:main.session});await reasoning(['parent','child']);watched=['child']
 }else if(kind==='queued'){
  sub=send('child',{parent:main.session});const queue=await until(async()=>{const s=await control('/inflight');return s.upstreams?.claude?.queued===1?s:false});witness.queueBefore=queue;assert.equal((await status()).calls.length,1,'Queued child reached provider before cancellation')
 }
 if(kind==='watchdog'){
  const current=await status(),started=Math.min(...current.calls.filter(row=>row.role==='foreground').map(row=>row.startedAt));witness.expectedWatchdogAt=started+watchdog
  const end=witness.expectedWatchdogAt+5000;let s
  while(Date.now()<end){s=await status();if(activeCalls(s,['foreground']).every(row=>row.closedAt))break;await pause(25)}
  witness.observationBeforeTeardown=Date.now();witness.watchdogClosedBeforeTeardown=activeCalls(s,['foreground']).every(row=>row.closedAt&&row.closedAt<=end);witness.providerBeforeTeardown=s.calls
  assert.equal(witness.watchdogClosedBeforeTeardown,!baseline,'Watchdog must end original active native/provider work before teardown')
 }else{
  await control('/cancel');witness.cancelAt=Date.now();(kind==='queued'?sub:main).abort.abort();await(kind==='queued'?sub:main).pending
  if(kind==='queued'){
   const end=Date.now()+5000;let state
   while(Date.now()<end){state=await control('/inflight');if(state.upstreams?.claude?.queued===0)break;await pause(25)}
   witness.queueAfter=state;witness.queueCancelledBeforeTeardown=state.upstreams?.claude?.queued===0;const s=await status();witness.providerBeforeTeardown=s.calls;assert.equal(s.calls.length,1,'Cancelled queued request started a native model generation');assert(s.calls.some(row=>row.role==='parent'&&!row.closedAt),'Cancelling queued child stopped unrelated active parent');assert.equal(witness.queueCancelledBeforeTeardown,true,'Queued wire requests already stop on baseline and must remain stopped')
  }else{
   const end=witness.cancelAt+5000;let s
   while(Date.now()<end){s=await status();if(activeCalls(s,watched).every(row=>row.closedAt))break;await pause(25)}
   const rows=activeCalls(s,watched);assert(rows.length);witness.foregroundClosedBeforeTeardown=rows.every(row=>row.closedAt&&row.closedAt-witness.cancelAt<=5000);witness.providerBeforeTeardown=s.calls;assert.equal(witness.foregroundClosedBeforeTeardown,!baseline,'Original native/provider work must close because of cancellation, before teardown')
  }
  witness.observationBeforeTeardown=Date.now()
 }
 witness.result=baseline&&kind!=='queued'?'EXPECTED_BASELINE_FAILURE':'PASS';save()
}catch(error){witness.result='FAIL';witness.failure=String(error);save()}finally{
 for(const request of requests)request.abort.abort();await Promise.all(requests.map(request=>request.pending))
 if(ready)try{await control('/close')}catch(error){witness.closeRequestError=String(error)}
 if(child.exitCode===null){const closed=once(child,'close');const timer=setTimeout(()=>child.kill('SIGTERM'),25000);await closed;clearTimeout(timer)}
 witness.joined=witness.hostClosed&&witness.stdoutClosed&&witness.stderrClosed
 if(!witness.joined||witness.hostCode!==0)witness.result='FAIL'
 writeFileSync(join(out,'host.log'),stdout+'\n'+stderr)
 if(existsSync(join(out,'report.json'))){const data=JSON.parse(readFileSync(join(out,'report.json'),'utf8'));if(!data.joined||data.result!=='CLOSED'||(live&&!data.providerOriginalNativeCorrelated)){witness.result='FAIL';witness.finalHostFailure=data}}else{witness.result='FAIL';witness.finalHostFailure={missingReport:true,hostExit:witness.hostCode}}
 save();console.log(JSON.stringify(witness))
}
process.exitCode=witness.result==='FAIL'?1:0
