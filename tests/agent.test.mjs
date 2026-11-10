import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';import * as nodeCrypto from 'node:crypto';import {Buffer} from 'node:buffer';const {webcrypto}=nodeCrypto;
const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));
const DB={prepare(sql){const bound=(...args)=>{const st=sqlite.prepare(sql);return {first:async()=>st.get(...args)||null,all:async()=>({results:st.all(...args)}),run:async()=>({meta:{changes:Number(st.run(...args).changes)}})}};return {bind:bound,...bound()};}};
DB.prepare('INSERT INTO workspace_access(id,payload,revision) VALUES (?,?,1)').bind('main',JSON.stringify({ownerId:'owner',ownerEmail:'owner@example.test',members:[],emergencyStop:false})).run();
const env={DB,XLLOOP_TEST_TRUST_IDENTITY_HEADERS:true};let jobCalls=0;let runnerMode='success';let resolver;
const allCaps=['model','analytics','repository','ci','preview','deploy','cdn','rollback','marketing'];
const mockFetch=async(url,opt)=>{if(String(url).includes('/capabilities'))return Response.json({capabilities:allCaps});if(opt.method==='POST')jobCalls++;if(runnerMode==='uncertain')throw Error('Network timeout');if(runnerMode==='deferred')await new Promise(r=>resolver=r);return Response.json({status:'succeeded',summary:'Fixture result: not real external execution',evidence:'Fixture evidence',cost:runnerMode==='overbudget'?200:0.25,artifacts:['https://example.test/preview']});};
const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exp={};cache.set(file,exp);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const context={exports:exp,require(id){if(id==='cloudflare:workers'||id.endsWith('/runtime/env'))return {env};if(id==='node:crypto')return nodeCrypto;return load(path.resolve(path.dirname(file),id+'.ts'))},Request,Response,Headers,URL,Buffer,crypto:webcrypto,structuredClone,fetch:mockFetch,AbortSignal,console};vm.runInNewContext(code,context,{filename:file});return exp;}
const route=load('app/api/agent/route.ts');
const request=(uid,method='GET',body,origin)=>new Request('https://xlloop.test/api/agent?project=ybirds',{method,headers:{...(uid?{'oai-authenticated-user-id':uid}:{}),'Content-Type':'application/json',...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
assert.equal((await route.GET(request(''))).status,401);
assert.equal((await route.POST(request('owner','POST',{project:'ybirds',revision:0,action:'check'},'https://evil.test'))).status,403);
async function get(uid='owner',project='ybirds'){const r=await route.GET(new Request('https://xlloop.test/api/agent?project='+project,{headers:{'oai-authenticated-user-id':uid}}));return r.json()}
async function act(action,extra={},expected=200){const state=await get();const run=state.data.runs[0];const r=await route.POST(request('owner','POST',{project:'ybirds',revision:state.revision,runId:run?.id,action,...extra}));const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));return b;}
let b=await act('settings',{settings:{objective:'test',repo:'https://example.test/repo',environment:'staging then production',analytics:'fixture dataset',cdn:'fixture zone',channels:'fixture channel',owner:'QA',maxRetries:1,maxIterations:30}});
await act('memory',{type:'已验证事实',text:'test'},400);await act('memory',{type:'已验证事实',text:'test',source:'fixture'});
b=await act('create',{command:'Test run',scope:'full',budget:20,requestId:'same-command'});const id=b.data.runs[0].id;await act('create',{command:'Test run',scope:'full',budget:20,requestId:'same-command'});assert.equal((await get()).data.runs.length,1);
await act('start');b=await act('advance');assert.equal(b.data.runs[0].tasks[0].status,'completed');
b=await act('advance');assert.equal(b.data.runs[0].status,'blocked');assert.equal(jobCalls,0);
assert.ok((await get('different')).error);assert.equal((await get('owner','ukec')).data.runs.length,0);
env.XLLOOP_RUNNER_URL='https://runner.test';env.XLLOOP_RUNNER_TOKEN='test-secret';await act('resume');
for(let i=0;i<6;i++)await act('advance');b=await get();assert.equal(b.data.runs[0].tasks[6].status,'completed');
const beforeGate=jobCalls;b=await act('advance');assert.equal(b.data.runs[0].status,'awaiting_approval');assert.equal(jobCalls,beforeGate);
await act('reject');b=await act('resume');b=await act('advance');assert.equal(b.data.runs[0].status,'awaiting_approval');await act('approve');await act('advance');assert.equal(jobCalls,beforeGate+1);
// Same revision request cannot dispatch twice.
const stale=await get();await act('pause');let r=await route.POST(request('owner','POST',{project:'ybirds',revision:stale.revision,runId:id,action:'advance'}));assert.equal(r.status,409);
await act('create',{command:'Uncertain run',scope:'analysis',budget:20,requestId:'uncertain'});await act('start');await act('advance');runnerMode='uncertain';b=await act('advance');assert.equal(b.data.runs[0].tasks[1].status,'unknown');const afterUnknown=jobCalls;await act('retry',{},400);runnerMode='success';b=await act('reconcile');assert.equal(jobCalls,afterUnknown);assert.equal(b.data.runs[0].status,'completed');
// Exceeded reported costs pause subsequent work.
await act('create',{command:'Budget run',scope:'preview',budget:1,requestId:'budget'});await act('start');await act('advance');runnerMode='overbudget';b=await act('advance');assert.equal(b.data.runs[0].status,'paused');assert.equal(b.data.runs[0].spent,200);
// Pause while an external job is in flight preserves the pause and result.
runnerMode='deferred';await act('create',{command:'Race run',scope:'preview',budget:20,requestId:'race'});await act('start');await act('advance');const pending=act('advance');for(let i=0;i<30&&!resolver;i++)await new Promise(r=>setTimeout(r,5));assert.ok(resolver);await act('pause');resolver();b=await pending;assert.equal(b.data.runs[0].status,'paused');assert.equal(b.data.runs[0].tasks[1].status,'completed');
// Project authorization and gate records remain isolated.
r=await route.GET(new Request('https://xlloop.test/api/agent?project=p-00000000-0000-0000-0000-000000000000',{headers:{'oai-authenticated-user-id':'owner'}}));assert.equal(r.status,400);
console.log('PASS: durable workflow, isolation, authentication, CSRF, command idempotency, missing-tool block, approval gate, optimistic concurrency, unknown-job reconciliation, budget stop, in-flight pause. All external calls are fixtures.');
