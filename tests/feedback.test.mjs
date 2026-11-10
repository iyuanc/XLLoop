import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import ts from 'typescript';import {DatabaseSync} from 'node:sqlite';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const sqlite=new DatabaseSync(':memory:');for(const f of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+f,'utf8'));
const DB={prepare(sql){const bound=(...args)=>{const st=sqlite.prepare(sql);return {first:async()=>st.get(...args)||null,all:async()=>({results:st.all(...args)}),run:async()=>({meta:{changes:Number(st.run(...args).changes)}})}};return {bind:bound,...bound()};}};
const env={DB,XLLOOP_OWNER_EMAIL:'owner@example.test',XLLOOP_SERVICE_KEY:'fixture-service-key'};
let external=async()=>{throw Error('unexpected real request')};const cache=new Map();function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const exp={};cache.set(file,exp);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.runInNewContext(code,{exports:exp,require(id){if(id==='cloudflare:workers')return {env};return load(path.resolve(path.dirname(file),id+'.ts'))},Request,Response,Headers,URL,Set,Map,TextEncoder,crypto:webcrypto,structuredClone,fetch:(...args)=>external(...args),AbortSignal,console},{filename:file});return exp;}
const access=load('app/api/access/route.ts'),state=load('app/api/state/route.ts'),agent=load('app/api/agent/route.ts'),auto=load('app/api/autonomy/route.ts'),service=load('app/api/autonomy/service/route.ts'),projects=load('app/api/projects/route.ts');
const req=(endpoint,uid,method='GET',body,extra={})=>new Request('https://xlloop.test/api/'+endpoint,{method,headers:{...(uid?{'oai-authenticated-user-id':uid,'oai-authenticated-user-email':uid+'@example.test'}:{}),'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
const feedback=load('app/api/feedback/route.ts'),bridge=load('app/api/feedback/bridge/route.ts');
await access.GET(req('access','owner'));
async function add(uid,role,project){const a=await (await access.GET(req('access','owner'))).json();assert.equal((await access.POST(req('access','owner','POST',{revision:a.revision,action:'member',member:{email:uid+'@example.test',name:uid,enabled:true,grants:[{project,role,budgetLimit:5}]}}))).status,200);await access.GET(req('access',uid));}
await add('reporter','viewer','ybirds');await add('lead','manager','ybirds');await add('dev','developer','ybirds');await add('other','manager','ukec');await add('ops','release','ybirds');
async function view(uid){return (await feedback.GET(req('feedback',uid))).json();}
async function post(uid,action,extra={}){const d=await view(uid);const t=d.tickets?.find(t=>t.id===extra.id);return feedback.POST(req('feedback',uid,'POST',{action,ticketRevision:t?.revision,note:'Fixture evidence',...extra}));}
assert.equal((await feedback.GET(req('feedback',''))).status,401);
await post('owner','bootstrap');await post('owner','bootstrap');assert.equal((await view('owner')).tickets.filter(t=>t.systemKey==='wecom-integration').length,1);
let r=await post('reporter','create',{title:'Fixture issue',description:'Fixture bug details',project:'ybirds',category:'bug'});assert.equal(r.status,200);const {id,number}=await r.json();assert.match(number,/^FB-/);
let t=(await view('reporter')).tickets.find(t=>t.id===id);const leadUid=(await view('lead')).uid;assert.equal(t.assignee,leadUid);assert.equal((await view('other')).tickets.some(t=>t.id===id),false);assert.equal((await view('dev')).tickets.some(t=>t.id===id),false);
assert.equal((await post('reporter','assign',{id,assignee:'x',project:'ybirds',due:'2099-01-01'})).status,403);
const devUid=(await view('dev')).uid;
assert.equal((await post('lead','assign',{id,assignee:devUid,project:'ybirds',due:'2099-01-01T00:00:00Z'})).status,200);
assert.equal((await post('dev','start',{id})).status,200);assert.equal((await post('dev','verify',{id})).status,403);
assert.equal((await post('dev','resolve',{id,note:''})).status,400);assert.equal((await post('dev','resolve',{id})).status,200);
assert.equal((await post('lead','verify',{id})).status,403);assert.equal((await post('reporter','verify',{id})).status,200);assert.equal((await view('reporter')).tickets.find(t=>t.id===id).status,'closed');
assert.equal((await post('reporter','reopen',{id,note:'Still broken fixture'})).status,200);
assert.equal((await feedback.POST(req('feedback','lead','POST',{action:'comment',id,ticketRevision:0,note:'stale'}))).status,409);
assert.equal((await post('reporter','create',{title:'Cross-project',description:'Fixture',project:'ukec'})).status,403);
assert.equal((await post('reporter','create',{title:'Invalid link',description:'Fixture',links:'javascript:alert(1)'})).status,400);
r=await post('reporter','create',{title:'Unclassified fixture',description:'Unknown project'});const unknown=(await r.json()).id;assert.equal((await view('owner')).tickets.find(t=>t.id===unknown).assignee,(await view('owner')).uid);
assert.equal((await post('reporter','opportunity',{id})).status,200);const first=(await view('reporter')).tickets.find(t=>t.id===id).opportunityId;assert(first);await post('reporter','opportunity',{id});assert.equal((await view('reporter')).tickets.find(t=>t.id===id).opportunityId,first);
const opp=load('app/api/opportunities/route.ts');const g=(await (await opp.GET(req('opportunities','reporter'))).json()).opportunities.find(o=>o.id===first);assert.equal(g.status,'idea');assert.equal(g.projectId,undefined);
const owner=await view('owner');let policy={fallbackId:owner.uid,autoTriage:{ybirds:{enabled:false,cap:0,perJob:.5}},wecomMappings:[{wecomId:'fixture-worker',uid:(await view('reporter')).uid}]};
assert.equal((await post('reporter','policy',{policy})).status,403);assert.equal((await post('owner','policy',{policy})).status,200);
assert.equal((await post('owner','triage')).status,200);assert.equal((await view('reporter')).tickets.find(t=>t.id===id).suggestions,null);
assert.equal((await bridge.POST(req('feedback/bridge','','POST',{action:'submit'}))).status,503);
env.XLLOOP_FEEDBACK_BRIDGE_KEY='fixture-bridge-key-at-least-32-characters';
async function signed(body,valid=true){const raw=JSON.stringify(body),ts=String(Date.now());const key=await webcrypto.subtle.importKey('raw',new TextEncoder().encode(env.XLLOOP_FEEDBACK_BRIDGE_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=Buffer.from(await webcrypto.subtle.sign('HMAC',key,new TextEncoder().encode(ts+'.'+raw))).toString('hex');return bridge.POST(new Request('https://xlloop.test/api/feedback/bridge',{method:'POST',headers:{'x-xlloop-timestamp':ts,'x-xlloop-signature':valid?sig:'0'.repeat(64),'Content-Type':'application/json'},body:raw}));}
assert.equal((await signed({action:'submit'},false)).status,401);
const incoming={action:'submit',eventId:'wecom-fixture-1',senderId:'fixture-worker',title:'Bridge fixture',description:'Verified adapter fixture',project:'ybirds'};
assert.equal((await signed({...incoming,senderId:'unmapped'})).status,403);r=await signed(incoming);assert.equal(r.status,200);const receipt=await r.json();r=await signed(incoming);assert.equal((await r.json()).number,receipt.number);assert.equal((await view('reporter')).tickets.filter(t=>t.eventId==='wecom-fixture-1').length,1);
r=await signed({action:'notifications'});const n=(await r.json()).notifications[0];assert(n);assert.equal((await signed({action:'ack',id:n.id,deliveryToken:'wrong',status:'sent',receipt:'fake'})).status,403);assert.equal((await signed({action:'ack',id:n.id,deliveryToken:n.deliveryToken,status:'sent'})).status,400);assert.equal((await signed({action:'ack',id:n.id,deliveryToken:n.deliveryToken,status:'sent',receipt:'fixture-provider-id'})).status,200);
assert((await view('reporter')).notifications.some(n=>n.ticket===id));assert((await view('owner')).outbox.sent>=1);
assert.equal((await feedback.POST(req('feedback','owner','POST',{action:'read'},{origin:'https://evil.test'}))).status,403);

// Agent triage is opt-in and returns suggestions without deciding or assigning.
env.XLLOOP_RUNNER_URL='https://runner.fixture.test';env.XLLOOP_RUNNER_TOKEN='fixture-only';policy.autoTriage.ybirds={enabled:true,cap:4,perJob:1};assert.equal((await post('owner','policy',{policy})).status,200);
let dispatched;
external=async(url,options)=>{const path=new URL(url).pathname;if(path==='/v1/capabilities')return Response.json({capabilities:['feedback_triage']});if(path==='/v1/jobs'){dispatched=JSON.parse(options.body);return Response.json({status:'queued'});}return Response.json({status:'succeeded',cost:.2,summary:'Fixture classification',evidence:'Fixture only',suggestion:{category:'bug',priority:'urgent',questions:'Which browser?',duplicates:[]}});};
assert.equal((await post('owner','triage')).status,200);assert.equal(dispatched.scope,'analysis-only');assert.equal(dispatched.approval,null);assert.equal((await post('owner','triage')).status,200);
const after=await view('owner'),job=after.agentJobs.find(j=>j.id===dispatched.id);assert.equal(job.actual,.2);const triaged=after.tickets.find(t=>t.agentJob===dispatched.id);assert.equal(triaged.status,'new');assert.equal(triaged.suggestions.status,'succeeded');assert.equal(triaged.suggestions.questions,'Which browser?');
assert.equal((await post('owner','policy',{policy:{...policy,autoTriage:{ybirds:{enabled:false,cap:0,perJob:1}}}})).status,400);

assert.equal((await view('ops')).tickets.some(t=>t.id===id),false);
r=await post('reporter','create',{title:'Urgent fixture',description:'Business blocked',project:'ybirds',priority:'urgent'});const urgent=(await r.json()).id;assert((await view('ops')).tickets.some(t=>t.id===urgent));assert.equal((await view('other')).tickets.some(t=>t.id===urgent),false);
let app=await (await access.GET(req('access','owner'))).json();assert.equal((await access.POST(req('access','owner','POST',{revision:app.revision,action:'member',member:{email:'reporter@example.test',enabled:false,grants:[{project:'ybirds',role:'viewer',budgetLimit:0}]}}))).status,200);
assert.equal((await signed({...incoming,eventId:'revoked-event'})).status,403);
console.log('PASS: ticket numbering/durable history, manager routing and owner fallback, scoped visibility, assignment, submitter verification/reopen, stale revision, evidence gates, opportunity draft conversion, owner policy, disabled agent state, authenticated HMAC bridge, verified identity mapping, webhook dedupe, delivery lease/receipt, in-app notifications and CSRF. Fixtures only; no actual WeCom or model calls.');
