// Real Node HTTP cancellation through the built proxy, SDK and native CLI.
// Invoked by e2e-priority-cancellation.mjs. Default upstream is scripted;
// --live additionally requires explicit, private owned-account admission.
// Only public SDK history APIs are used. Original children and pipes join
// before the disposable home/config/session tree is removed.
import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports,createRequire} from 'node:module';import {StringDecoder} from 'node:string_decoder';import {createServer} from 'node:http';import {once} from 'node:events';import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,statSync,realpathSync,existsSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';import {pathToFileURL,fileURLToPath} from 'node:url';
const sourceRoot=fileURLToPath(new URL('../..',import.meta.url));
const repo=resolve(process.env.E2E_MERIDIAN_ROOT??sourceRoot),native=process.env.E2E_NATIVE_BIN,live=process.argv.includes('--live'),diagnose=false,model='claude-sonnet-5-5';
const output=process.env.E2E_OUTPUT_FILE,root=realpathSync(mkdtempSync('/tmp/meridian-priority-live-')),work=join(root,'project'),nonce=randomBytes(12).toString('hex'),history='OWNED_PRIORITY_'+randomUUID(),primarySystem=history;
assert(output&&native?.startsWith('/'));assert(!resolve(output).startsWith(root+'/'),'Keep evidence outside the disposable fixture');for(const dir of ['home','project','config','sessions'])mkdirSync(join(root,dir),{mode:0o700});
const harnessRoot=resolve(process.env.E2E_HARNESS_ROOT??sourceRoot);const {validateProfileHistoryAdmission}=await import(pathToFileURL(join(harnessRoot,'scripts/lib/profileHistoryAdmission.mjs')));
const report={scope:live?'actual native frontend/backend and real model':'credentialless native frontend/backend loopback',model,provider:[],nativeModels:[],actors:[],upstreamRequests:[],refusal:false};let stopped=false,profiles,admission;const persist=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(live){
 assert.equal(process.env.E2E_ALLOW_LIVE_MODEL,'1');const grant=process.env.E2E_LIVE_PROFILE_FILE;assert.equal(statSync(grant).mode&0o077,0);profiles=JSON.parse(readFileSync(grant));assert(profiles.length===2&&profiles.every(p=>p.type==='oauth-token'&&p.oauthToken&&!p.refreshToken));assert.notEqual(profiles[0].oauthToken,profiles[1].oauthToken);
 admission=JSON.parse(readFileSync(process.env.E2E_USAGE_GUARD_FILE));report.admission=validateProfileHistoryAdmission(admission);assert.equal(admission.distinctAccounts,2);assert.deepEqual(admission.permittedInferenceProfileIds,['pool-a']);assert.equal(admission.knownSpentSpareProfileId,'pool-b');report.pool={distinctRealAccounts:2,permittedInferenceProfileIds:admission.permittedInferenceProfileIds,knownSpentSpareProfileId:'pool-b',scope:'OnlyTeamactualinference; exhaustedpersonalsparecannotforward. No twohealthyaccount/failover/quota-recovery claim.'};
}

const watchdog=process.env.E2E_WATCHDOG_MS;
const routing=process.env.E2E_ROUTING??'active+priority';for(const k of Object.keys(process.env))if(/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_)/.test(k))delete process.env[k];Object.assign(process.env,{HOME:join(root,'home'),MERIDIAN_CONFIG_DIR:join(root,'config'),MERIDIAN_SESSION_DIR:join(root,'sessions'),MERIDIAN_WORKDIR:work,MERIDIAN_ROUTING:routing,MERIDIAN_PROFILE_ORDER:'pool-a,pool-b',MERIDIAN_TELEMETRY_PERSIST:'0',MERIDIAN_CREDENTIALS_READONLY:'1',MERIDIAN_NO_UPDATE_CHECK:'1',MERIDIAN_SHUTDOWN_GRACE_MS:'3000',MERIDIAN_SONNET_MODEL:'sonnet',MERIDIAN_PASSTHROUGH:'1'});if(watchdog){process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS=watchdog;report.watchdogMs=Number(watchdog)}process.chdir(work);
const {observeChildClosure,stopAndJoinChild}=await import(pathToFileURL(join(harnessRoot,'scripts/lib/e2eProcessCustody.mjs')));
const ownedChildren=[],custody=new Map();
for(const method of ['spawn','execFile']){const original=cp[method];cp[method]=function(...args){
 const child=original.apply(this,args);ownedChildren.push(child);custody.set(child,observeChildClosure(child));const options=Array.isArray(args[1])?args[2]:args[1];const row={pid:child.pid,closed:false,stdoutClosed:!child.stdout,stderrClosed:!child.stderr,nativeNamespace:options?.env?.CLAUDE_CONFIG_DIR??null};report.actors.push(row);persist()
 child.once('close',(code,signal)=>Object.assign(row,{closed:true,code,signal}));child.stdout?.once('close',()=>row.stdoutClosed=true);child.stderr?.once('close',()=>row.stderrClosed=true)
 // Observe each emitted chunk in place without adding a data listener or
 // changing flowing mode. The native transport can emit directly from its
 // pipe, bypassing Readable.read; forwarding emit preserves its consumer.
 if(child.stdout){const emit=child.stdout.emit,decoder=new StringDecoder('utf8');let pending=''
  child.stdout.emit=function(event,...eventArgs){
   if(event==='data'){const bytes=eventArgs[0];pending+=typeof bytes==='string'?bytes:decoder.write(bytes)
    if(pending.length>1048576){report.nativeObservationFailure='Native observation line exceeded bound';stopped=true;pending=''}
    let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);let value;try{value=JSON.parse(line)}catch{continue}
     let entry
     if(value.type==='system'&&value.subtype==='init')entry={type:'init',model:value.model}
     if(value.type==='assistant')entry={type:'assistant',id:value.message?.id,model:value.message?.model}
     if(value.type==='stream_event'&&value.event?.type==='message_start')entry={type:'message_start',id:value.event.message?.id,model:value.event.message?.model}
     if(entry){entry.synthetic=entry.model==='<synthetic>';report.nativeModels.push({...entry,pid:child.pid,session:value.session_id});if(typeof entry.model==='string'&&!entry.synthetic&&entry.model.replace(/\[1m\]$/,'')!==model){report.nativeModelMismatch=true;stopped=true;for(const c of upstreamControllers)c.abort()}persist()}
     if(value.type==='rate_limit_event'){const info=value.rate_limit_info??{};(report.rateLimitEvents??=[]).push({status:info.status,isUsingOverage:info.isUsingOverage??null,overageStatus:info.overageStatus??null,overageDisabledReason:info.overageDisabledReason??null});if(info.isUsingOverage===true||info.status==='rejected'){stopped=true;report.overageObserved=info.isUsingOverage===true;report.includedCapacityRejected=info.status==='rejected';for(const controller of upstreamControllers)controller.abort()}persist()}
     if(value.type==='result')for(const actualModel of Object.keys(value.modelUsage??{})){report.nativeModels.push({type:'result_usage',model:actualModel,pid:child.pid,session:value.session_id});if(actualModel.replace(/\[1m\]$/,'')!==model){report.nativeModelMismatch=true;stopped=true}}
    }
   }return emit.call(this,event,...eventArgs)
  }
 }
 return child
}}
syncBuiltinESMExports()
let proxy,server
const upstreamControllers=new Set()
const upstream=createServer(async(req,res)=>{
 const controller=new AbortController();upstreamControllers.add(controller)
 res.once('close',()=>{if(!res.writableFinished)controller.abort()})
 let transport,body,row
 try{
  transport={method:req.method,localPath:req.url,receivedAt:Date.now()};report.upstreamRequests.push(transport);persist();const chunks=[];for await(const chunk of req)chunks.push(chunk)
  const payload=Buffer.concat(chunks),url=new URL(req.url,'https://api.anthropic.com')
  assert.equal(url.origin,'https://api.anthropic.com');const channel=url.pathname.match(/^\/native\/(\d+)(\/.*)$/);if(channel){transport.nativePID=Number(channel[1]);url.pathname=channel[2]}transport.path=url.pathname;persist()
  let json
  if(req.method==='POST'&&payload.length){try{json=JSON.parse(payload)}catch{transport.nonJsonBody=true}}
  const generation=req.method==='POST'&&(url.pathname==='/v1/messages'||(typeof json?.model==='string'&&Array.isArray(json?.messages)))
  res.once('close',()=>{if(row){row.closedAt=Date.now();row.cancelled=!res.writableFinished;persist()}})
  if(generation){
   body=json??JSON.parse(payload)
   const text=JSON.stringify(body.messages),turns=[...text.matchAll(/OWNED_AGENT_SWITCH_TURN_(\d)/g)].map(m=>Number(m[1]))
   row={nativePID:transport.nativePID,turn:turns.length?Math.max(...turns):null,role:text.includes('Write the title in')?'title':text.includes('OWNED_CHILD_')?'child':text.includes('OWNED_PARENT_')?'parent':'foreground',primary:!text.includes('Write the title in'),model:body.model,systemHasCanary:JSON.stringify(body.system).includes(nonce),historyPresent:text.includes(history),startedAt:Date.now(),closedAt:null}
   if(diagnose||stopped||url.pathname!='/v1/messages'||body.model.replace(/\[1m\]$/,'')!==model||report.provider.length>=(report.admission?.maximumGenerations??4)){
    transport.deniedBeforeForward=true;stopped=true;report.diagnosticStop=diagnose
    res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Owned probe model/attempt boundary reached'}}))
    setTimeout(()=>server?.kill('SIGTERM'),0).unref();return
   }
   const bearer=String(req.headers.authorization??'').replace(/^Bearer\s+/i,''),key=String(req.headers['x-api-key']??'')
   row.profileId=profiles?.find(p=>p.oauthToken===bearer||p.apiKey===key)?.id
   if(live&&!row.profileId){stopped=true;report.credentialMismatch=true;res.writeHead(400);res.end('Owned credential boundary');return}
   assert(report.actors.some(actor=>actor.pid===row.nativePID),'Generation did not come from an original observed native process');if(live&&!admission.permittedInferenceProfileIds.includes(row.profileId)){stopped=true;report.spentSpareSelectionDenied=true;transport.deniedBeforeOfficialForward=true;persist();res.writeHead(400);res.end('Owned known-spent-spare inference boundary');return}report.provider.push(row);persist()
  }
  if(!live){
   if(!generation){res.setHeader('content-type','application/json');res.end('{}');return}
   const message={id:'msg_'+randomUUID(),type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:100,output_tokens:0}};
   Object.assign(row,{status:200,responseId:message.id,responseModel:message.model,thinkingAt:Date.now(),scripted:true});persist();
   res.setHeader('content-type','text/event-stream');
   for(const event of [{type:'message_start',message},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Owned loopback reasoning'}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
   return // Hold this owned fixture until the original client/SDK socket closes.
  }
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value&&!['host','connection','content-length','transfer-encoding','accept-encoding'].includes(name))headers.set(name,Array.isArray(value)?value.join(','):value)
  if(row){row.forwardedAt=Date.now();report.officialForwards=(report.officialForwards??0)+1;persist()}const response=await fetch(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:payload,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(90000)])})
  transport.status=response.status
  row&&(Object.assign(row,{status:response.status,providerRequestId:response.headers.get('request-id')??response.headers.get('x-request-id')}));persist()
  const responseHeaders={};for(const [name,value]of response.headers)if(!['content-length','content-encoding','transfer-encoding','connection'].includes(name))responseHeaders[name]=value
  res.writeHead(response.status,responseHeaders)
  if(!response.ok){if(row)stopped=true;else (report.auxiliaryHttpFailures??=[]).push({path:url.pathname,status:response.status});res.end(Buffer.from(await response.arrayBuffer()));return}
  if(!response.body){res.end();return} // The OAuth native CLI begins with HEAD /api/hello.
  let buffer='',answer=''
  for await(const chunk of response.body){
   if(generation){buffer+=Buffer.from(chunk).toString().replaceAll('\r','');assert(buffer.length<1048576);let end
    while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of frame.split('\n'))if(line.startsWith('data: ')){let event;try{event=JSON.parse(line.slice(6))}catch{continue}
     if(event.type==='message_start'){row.responseModel=event.message?.model;row.responseId=event.message?.id;assert.equal(row.responseModel,model);persist()}
     if(event.type==='content_block_start'&&event.content_block?.type==='thinking')row.thinkingAt??=Date.now()
     if(event.type==='content_block_delta'&&event.delta?.type==='thinking_delta')row.thinkingAt??=Date.now()
     if(event.type==='content_block_delta'&&event.delta?.type==='text_delta'){answer+=event.delta.text;assert(answer.length<1048576);row.textBytes=(row.textBytes??0)+Buffer.byteLength(event.delta.text);row.lastTextAt=Date.now();persist()}
     persist();if(event.type==='error'){stopped=true;report.providerInBandError=event.error?.type??'unknown'}if(event.type==='message_delta'&&event.delta?.stop_reason){row.stopReason=event.delta.stop_reason;if(row.stopReason==='refusal'){report.refusal=true;stopped=true}}
    }}
   }res.write(Buffer.from(chunk))
  }if(row)row.answerHasCanary=answer.includes(nonce);persist();res.end()
 }catch(error){
  if(controller.signal.aborted&&row&&(report.cancelSentAt||report.watchdogMs)){row.expectedOwnedAbort=true;persist();return}
  // Native startup may cancel its optional HEAD health probe. Cancellation
  // must abort that fetch without turning it into a model-access diagnosis.
  if(req.method==='HEAD'&&controller.signal.aborted){if(transport)transport.clientCancelled=true;persist();return}
  stopped=true;report.upstreamFailure={name:error.name,code:error.code,causeCode:error.cause?.code,causeName:error.cause?.name};if(transport)transport.failed=true;persist();if(!res.headersSent)res.writeHead(400);res.end();setTimeout(()=>server?.kill('SIGTERM'),0).unref()
 }
 finally{upstreamControllers.delete(controller)}
})
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
const trampoline=join(root,'native-relay.cjs')
const preExecPath=join(root,'native-pre-exec.jsonl');
const relayCode="#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');fs.appendFileSync(__JOURNAL__,JSON.stringify({pid:process.pid,configDir:process.env.CLAUDE_CONFIG_DIR??path.join(process.env.HOME,'.claude'),explicitConfigDir:!!process.env.CLAUDE_CONFIG_DIR})+'\\n');process.execve(__NATIVE__,[__NATIVE__,...process.argv.slice(2)],{...process.env,ANTHROPIC_BASE_URL:__RELAY__+'/native/'+process.pid});\n";
writeFileSync(trampoline,relayCode.replaceAll('__JOURNAL__',JSON.stringify(preExecPath)).replaceAll('__NATIVE__',JSON.stringify(native)).replaceAll('__RELAY__',JSON.stringify(`http://127.0.0.1:${upstream.address().port}`)),{mode:0o700});
process.env.MERIDIAN_CLAUDE_PATH=trampoline

profiles??=['pool-a','pool-b'].map(id=>({id,type:'api',apiKey:'owned-loopback',baseUrl:`http://127.0.0.1:${upstream.address().port}`}));
const {startProxyServer}=await import(pathToFileURL(join(repo,'dist/server.js')));
proxy=await startProxyServer({port:0,host:'127.0.0.1',silent:true,profiles,defaultProfile:profiles[0].id,maxConcurrent:Number(process.env.E2E_MAX_CONCURRENT??4)});if(!proxy.server.listening)await once(proxy.server,'listening');
const proxyURL=`http://127.0.0.1:${proxy.server.address().port}`;
const control=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/cancel'){report.cancelSentAt=Date.now();res.end('{}');return}if(req.url==='/close'){res.end('{}');await close();return}if(req.url==='/inflight'){res.end(JSON.stringify(await(await fetch(proxyURL+'/inflight',{signal:AbortSignal.timeout(3000)})).json()));return}res.end(JSON.stringify({calls:report.provider,refusal:report.refusal,stopped,nativeModelMismatch:report.nativeModelMismatch??false,haltReason:report.upstreamFailure??null,includedCapacityRejected:report.includedCapacityRejected??false}));});await new Promise(r=>control.listen(0,'127.0.0.1',r));
console.log(JSON.stringify({ready:true,proxy:proxyURL,control:`http://127.0.0.1:${control.address().port}`,root,work}));
let closing=false;async function close(){if(closing)return;closing=true;stopped=true;report.teardownStartedAt=Date.now();const cleanupTimer=setTimeout(()=>{for(const child of ownedChildren)if(child.exitCode===null&&child.signalCode===null){report.cleanupForcedSDKStopAt=Date.now();child.kill('SIGTERM')}},7000);
 try{const rows=await(await fetch(proxyURL+'/telemetry/requests?limit=100')).json();report.telemetry=rows.map(r=>({requestId:r.requestId,status:r.status,profile:r.profile,sdkSessionId:r.sdkSessionId}));await proxy.close()}catch(e){report.closeFailure=String(e)}
 report.originalCustody=[];for(const child of ownedChildren)report.originalCustody.push({pid:child.pid,...await stopAndJoinChild(child,custody.get(child),{graceMs:3000,forceMs:3000})});clearTimeout(cleanupTimer);for(const c of upstreamControllers)c.abort();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
 report.nativeNamespaces=existsSync(preExecPath)?readFileSync(preExecPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];for(const actor of report.actors){actor.nativeNamespace=report.nativeNamespaces.find(row=>row.pid===actor.pid)?.configDir??actor.nativeNamespace}report.publicSdkHistory=[];
 try{
  const require=createRequire(join(repo,'package.json')),sdk=await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')));const previous=process.env.CLAUDE_CONFIG_DIR;
  try{for(const nativeRow of report.nativeModels.filter(row=>row.type==='init'&&row.session)){
   const actor=report.actors.find(row=>row.pid===nativeRow.pid);if(!actor?.nativeNamespace)continue;assert(resolve(actor.nativeNamespace).startsWith(root+'/'));process.env.CLAUDE_CONFIG_DIR=actor.nativeNamespace;
   const info=await sdk.getSessionInfo(nativeRow.session);const metadata={nativePID:nativeRow.pid,session:nativeRow.session,exists:!!info,rows:[]};
   if(info?.cwd){assert(resolve(info.cwd).startsWith(root+'/'));metadata.rows=(await sdk.getSessionMessages(nativeRow.session,{dir:info.cwd})).map(row=>({type:row.type,id:row.message?.id,model:row.message?.model,synthetic:row.message?.model==='<synthetic>'}))}report.publicSdkHistory.push(metadata)
  }}finally{if(previous===undefined)delete process.env.CLAUDE_CONFIG_DIR;else process.env.CLAUDE_CONFIG_DIR=previous}
 }catch(error){report.publicSdkHistoryFailure={name:error.name,message:String(error.message).slice(0,300)}}
 report.providerOriginalNativeCorrelated=report.provider.every(row=>row.status===200&&row.responseModel===model&&typeof row.responseId==='string'&&report.nativeModels.some(nativeRow=>nativeRow.pid===row.nativePID&&nativeRow.type==='init'&&nativeRow.model?.replace(/\[1m\]$/,'')===model)&&report.nativeModels.some(nativeRow=>nativeRow.pid===row.nativePID&&nativeRow.type==='message_start'&&nativeRow.id===row.responseId&&nativeRow.model===model));
 report.cancelledMessageLimit='Interrupted SDK sessions may have no completed public assistant record. Provider response/model and exact original nativePID/init are required; public SDK history is retained where available. No synthetic assistant is model evidence.';
 report.joined=report.actors.every(r=>r.closed&&r.stdoutClosed&&r.stderrClosed)&&report.originalCustody.every(row=>row.joined);report.result=report.joined&&!report.closeFailure&&!report.nativeModelMismatch&&!report.refusal&&!report.overageObserved&&!report.credentialMismatch&&!report.upstreamFailure&&!report.includedCapacityRejected&&!report.spentSpareSelectionDenied&&!report.providerInBandError&&(!live||report.providerOriginalNativeCorrelated)?'CLOSED':'FAIL';writeFileSync(output,JSON.stringify(report,null,2)+'\n');control.closeAllConnections();await new Promise(r=>control.close(r));
 // Reports retain only metadata. Native homes may contain credentials and
 // SDK files; joined actors no longer need this disposable state.
 if(report.joined){try{rmSync(root,{recursive:true,force:true});report.fixtureRemoved=true}catch(error){report.fixtureCleanupFailure={name:error.name,code:error.code};report.result='FAIL'}}else{report.fixtureCleanupDeferred='Original actor or pipe has not joined; preserve its active fixture'}
 persist();process.exit(report.result==='CLOSED'?0:1);
}process.on('SIGTERM',()=>void close());
