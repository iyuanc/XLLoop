import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';import * as nodeCrypto from 'node:crypto';import {Buffer} from 'node:buffer';const {webcrypto}=nodeCrypto;
const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));
const DB={prepare(sql){const bound=(...args)=>{const st=sqlite.prepare(sql);return {first:async()=>st.get(...args)||null,all:async()=>({results:st.all(...args)}),run:async()=>({meta:{changes:Number(st.run(...args).changes)}})}};return {bind:bound,...bound()};}};
const env={DB,XLLOOP_OWNER_EMAIL:'owner@example.test',XLLOOP_SERVICE_KEY:'fixture-service-key',XLLOOP_TEST_TRUST_IDENTITY_HEADERS:true};
let external=async()=>{throw Error('unexpected external dispatch')};const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exp={};cache.set(file,exp);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(code,{exports:exp,require(id){if(id==='cloudflare:workers'||id.endsWith('/runtime/env'))return {env};if(id==='node:crypto')return nodeCrypto;return load(path.resolve(path.dirname(file),id+'.ts'))},Request,Response,Headers,URL,Set,Map,Buffer,TextEncoder,crypto:webcrypto,structuredClone,fetch:(...args)=>external(...args),AbortSignal,console},{filename:file});return exp;}
const access=load('app/api/access/route.ts'),state=load('app/api/state/route.ts'),agent=load('app/api/agent/route.ts'),auto=load('app/api/autonomy/route.ts'),service=load('app/api/autonomy/service/route.ts'),projects=load('app/api/projects/route.ts');
const req=(endpoint,uid,method='GET',body,extra={})=>new Request('https://xlloop.test/api/'+endpoint,{method,headers:{...(uid?{'oai-authenticated-user-id':uid,'oai-authenticated-user-email':uid+'@example.test'}:{}),'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
const opp=load('app/api/opportunities/route.ts'),budget=load('lib/governance/store.ts'),runner=load('lib/agent/runner.ts');
let res=await access.GET(req('access','owner'));assert.equal(res.status,200);
let a=await (await access.GET(req('access','owner'))).json();await access.POST(req('access','owner','POST',{action:'member',revision:a.revision,member:{email:'staff@example.test',enabled:true,grants:[{project:'ybirds',role:'product',budgetLimit:10}]}}));
const post=async(uid,action,extra={})=>{const r=await opp.GET(req('opportunities',uid));const info=await r.json();return opp.POST(req('opportunities',uid,'POST',{revision:info.revision,action,...extra}));};
const proposal={title:'CRM opportunity',problem:'Leads lose follow-up',customer:'UKEC advisers',evidence:'Fixture customer report',value:'Improve measured contact rate',plan:'Isolated prototype, then reviewed delivery',validation:'Compare baseline and pilot',risks:'Do not modify production without release approval',owner:'QA',deadline:'2099-01-01',budget:10};
assert.equal((await opp.GET(req('opportunities',''))).status,401);
assert.equal((await post('staff','submit',{proposal:{title:'Incomplete',problem:'Fixture',budget:1}})).status,400);
res=await post('staff','submit',{proposal});assert.equal(res.status,200);const id=(await res.json()).id;
assert.equal((await post('staff','approve',{id,cap:10,note:'self approve'})).status,403);
assert.equal((await post('owner','approve',{id,cap:11,note:'too much'})).status,400);
res=await post('owner','approve',{id,cap:10,note:'Approve pilot only'});assert.equal(res.status,200);const projectId=(await res.json()).projectId;
assert.equal((await post('owner','approve',{id,cap:10,note:'duplicate'})).status,409);
assert.equal((await post('staff','save',{id,proposal:{...proposal,budget:100}})).status,403);
let ownerData=await (await opp.GET(req('opportunities','owner'))).json();const o=ownerData.opportunities.find(x=>x.id===id);assert.equal(o.status,'approved');assert.equal(o.cap,10);
let projectsResponse=await projects.GET(req('projects','owner'));assert((await projectsResponse.json()).projects.some(p=>p.id===projectId));
assert.equal((await state.GET(req('state?project='+projectId,'owner'))).status,200);
assert.equal((await state.GET(req('state?project='+projectId,'staff'))).status,403);
assert.equal((await opp.POST(req('opportunities','owner','POST',{revision:0,action:'reject',id,note:'stale'}))).status,409);
assert.equal((await opp.POST(req('opportunities','owner','POST',{revision:ownerData.revision,action:'research',research:{}},{origin:'https://evil.test'}))).status,403);
const base={project:projectId,task:'spec',scope:'plan',budget:{maxAdditionalCost:7}};
await budget.reserve(env,{...base,id:'one'});
await assert.rejects(()=>budget.reserve(env,{...base,id:'one'}));
await assert.rejects(()=>budget.reserve(env,{...base,id:'two'}));
await budget.settle(env,'one',{status:'failed'}); // unknown costs retain reservations
await assert.rejects(()=>budget.reserve(env,{...base,id:'two'}));
await budget.settle(env,'one',{status:'succeeded',cost:2,evidence:'fixture'});
await budget.settle(env,'one',{status:'succeeded',cost:0}); // repeated settlement cannot reduce spent
await budget.reserve(env,{...base,id:'two'});
await assert.rejects(()=>budget.reserve(env,{...base,id:'three'}));
assert.equal((await post('owner','budget',{id,cap:8,note:'Below committed costs'})).status,400);
assert.equal((await post('owner','budget',{id,cap:20,note:'Explicit owner top-up'})).status,200);
await budget.settle(env,'two',{status:'succeeded',cost:21,evidence:'supplier overspend'});
await assert.rejects(()=>budget.reserve(env,{...base,id:'three'}));
assert.equal((await post('owner','expense',{id,cost:1,expenseId:'inv-1',note:'Receipt fixture'})).status,200);
assert.equal((await post('owner','expense',{id,cost:1,expenseId:'inv-1',note:'Receipt fixture'})).status,409);
assert.equal((await post('staff','research',{research:{}})).status,403);
assert.equal((await post('owner','research',{research:{enabled:true,cap:5,perJob:1,goal:'Find service ideas',sources:'https://example.com'}})).status,200);
assert.equal((await post('owner','discover')).status,200); // not connected, no fabricated proposals
ownerData=await (await opp.GET(req('opportunities','owner'))).json();assert.equal(ownerData.opportunities.length,1);assert(ownerData.research.message.includes('待接入'));
// Exercise actual discovery runner protocol, budget reservation and automatic application.
env.XLLOOP_RUNNER_URL='https://runner.example.test';env.XLLOOP_RUNNER_TOKEN='fixture-only';let dispatched;
external=async(url,options)=>{const p=new URL(url).pathname;if(p==='/v1/capabilities')return Response.json({capabilities:['opportunities']});if(p==='/v1/jobs'){dispatched=JSON.parse(options.body);return Response.json({status:'queued'});}return Response.json({status:'succeeded',cost:.2,summary:'Fixture research',evidence:'Fixture only',opportunities:[{...proposal,title:'Agent fixture',budget:3}]});};
assert.equal((await post('owner','discover')).status,200);assert.equal(dispatched.scope,'research-only');assert.equal(dispatched.approval,null);
assert.equal((await post('owner','discover')).status,200);
ownerData=await (await opp.GET(req('opportunities','owner'))).json();const agentProposal=ownerData.opportunities.find(o=>o.source==='agent');assert.equal(agentProposal.status,'pending');assert.equal(agentProposal.projectId,undefined);assert.equal(ownerData.researchBalance.spent,.2);
console.log('PASS: staff submission; owner-only frozen approval; returned/incomplete validation; virtual project validity; project isolation; revision/CSRF; cumulative concurrent reservations; unknown-cost holds; idempotent settlement; overspend stop; audited budget amendments; expense dedupe; research-only executor; agent applications never self-approve. All business inputs and external calls are fixtures.');
