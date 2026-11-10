import {profile,shapePlan} from '../../../lib/organization/core';
import {workspace} from '../../../lib/access/store';
import {guard} from '../../../lib/access/guard';
import {isSameOrigin} from '../../../lib/http/origin';
import {env} from '../../../lib/runtime/env';
import {read,write,validProject} from '../../../lib/agent/store';
import {plan,current,audit,log,preflight,consumeResult,scopes,Run} from '../../../lib/agent/core';
import {capabilities,runner} from '../../../lib/agent/runner';
const json=(body:any,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
async function identity(req:Request,project:any){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)throw Error('AUTH');if(!await validProject(env.DB,uid,project))throw Error('PROJECT');return uid;}
const clean=(v:any,n=3000)=>typeof v==='string'?v.trim().slice(0,n):'';
async function handleGET(req:Request){try{const p=new URL(req.url).searchParams.get('project');const uid=await identity(req,p);const saved=await read(env.DB,uid,p!);return json(saved);}catch(e:any){return json({error:e.message==='AUTH'?'请登录后使用执行系统':'项目不可用'},e.message==='AUTH'?401:400)}}
async function handlePOST(req:Request){
 try{
 if(!isSameOrigin(req))return json({error:'跨站请求被拒绝'},403);
 if(Number(req.headers.get('content-length'))>100000)return json({error:'请求过大'},413);
 const b:any=await req.json();if(JSON.stringify(b).length>100000)return json({error:'请求过大'},413);const uid=await identity(req,b.project);const state=await read(env.DB,uid,b.project);if(b.revision!==state.revision)return json({error:'数据已更新，请刷新后重试'},409);let data=state.data;
 if(b.action==='settings'){
 const s=b.settings||{};data.settings={objective:clean(s.objective),repo:clean(s.repo,500),environment:clean(s.environment,500),analytics:clean(s.analytics,1000),cdn:clean(s.cdn,500),channels:clean(s.channels,1000),owner:clean(s.owner,80)||'待分配',deadline:clean(s.deadline,20),currency:'USD',maxRetries:Math.min(3,Math.max(0,Number(s.maxRetries)||0)),maxIterations:Math.min(100,Math.max(5,Number(s.maxIterations)||30))};
 }else if(b.action==='memory'){
 if(!clean(b.text))throw Error('请填写记忆内容');if(!['已验证事实','待验证','假设','风险'].includes(b.type))throw Error('记忆类型无效');if(b.type==='已验证事实'&&!clean(b.source))throw Error('事实记忆需要来源');data.memory=[{id:crypto.randomUUID(),text:clean(b.text),type:b.type,source:clean(b.source,1000),at:new Date().toISOString()},...data.memory].slice(0,100);
 }else if(b.action==='create'){
 if(!clean(b.command)||!scopes[b.scope]||!Number.isFinite(b.budget)||b.budget<=0||b.budget>10000||typeof b.requestId!=='string'||b.requestId.length>100)throw Error('请填写指令、执行范围与有效预算');
 const old=data.runs.find((r:Run)=>r.requestId===b.requestId);if(old)return json({...state,runId:old.id});if(data.runs.length>=50)throw Error('单项目最多保留 50 次运行，请先导出归档');const w=await workspace(env.DB);const run=shapePlan(plan(clean(b.command),b.scope,b.budget,data.settings,data.memory,b.requestId),profile(w?.data||{},b.project));data.runs.unshift(run);
 }else if(b.action==='check'){
 const caps=await capabilities(env,b.project);data.connection=caps;
 }else{
 const run:Run=data.runs.find((r:Run)=>r.id===b.runId);if(!run)throw Error('运行不存在');let task=current(run);
 if(b.action==='start'||b.action==='resume'){
 if(!['planned','paused','blocked'].includes(run.status))throw Error('当前状态不能启动');if(task?.status==='unknown')throw Error('有状态不明的外部任务，请先核对执行结果');run.status='running';if(task?.status==='blocked')task.status='pending';log(run,'用户启动 / 恢复执行','用户');
 }else if(b.action==='pause'){
 if(['completed','cancelled'].includes(run.status))throw Error('运行已经结束');run.status='paused';log(run,'已暂停后续派发；已派发的外部任务仍可能运行，需要到执行器终止。','用户');
 }else if(b.action==='cancel'){
 if(run.status==='completed')throw Error('已完成的运行不能取消');run.status='cancelled';log(run,'已取消后续步骤；外部在途任务需到执行器终止，历史证据保留。','用户');
 }else if(b.action==='approve'){
 if(run.status!=='awaiting_approval'||!task?.gate)throw Error('没有待审批步骤');task.approved=true;task.status='pending';run.status='running';log(run,'用户批准：'+task.name+'；仅限本次冻结计划与目标环境','用户');
 }else if(b.action==='reject'){
 if(run.status!=='awaiting_approval')throw Error('没有待审批步骤');run.status='paused';log(run,'用户驳回审批，执行暂停：'+clean(b.note,500),'用户');
 }else if(b.action==='retry'){
 if(!task||task.status!=='failed'||task.attempt>run.maxRetries)throw Error('当前任务不可重试或已达到重试上限');task.status='pending';task.jobId=undefined;task.error='';run.status='running';log(run,'用户请求重试已确认失败的任务','用户');
 }else if(b.action==='manual'){
 if(!task||['running','unknown'].includes(task.status)||['completed','cancelled'].includes(run.status))throw Error('外部任务状态未确认或运行已结束，不能人工覆盖');if(task.gate&&!task.approved)throw Error('此步骤需要先审批');if(!clean(b.summary)||!clean(b.evidence))throw Error('人工接管必须提供结果和证据');task.status='manual';task.result={summary:clean(b.summary),evidence:clean(b.evidence),source:'人工接管',cost:0};log(run,task.name+'由用户接管完成；不是 Agent 自动执行结果','用户');run.status=current(run)?'paused':'completed';
 }else if(b.action==='advance'||b.action==='reconcile'){
 if(!task){run.status='completed';}else{
 if(b.action==='advance'&&run.status!=='running')throw Error('运行未启动');if(b.action==='reconcile'&&!['unknown','running'].includes(task.status))throw Error('没有待核对的任务');
 if(task.status==='running'&&!task.jobId)throw Error('内置步骤正在处理，请稍后刷新');
 if(run.iterations>=run.maxIterations){run.status='paused';log(run,'达到最大执行步数，已暂停。');}
 else if(run.spent>=run.budget){run.status='paused';log(run,'预算已用完，已暂停。');}
 else if(task.gate&&!task.approved){task.status='awaiting_approval';run.status='awaiting_approval';log(run,'等待用户审批：'+task.name);}
 else if(task.id==='readiness'){
 const row=await env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(uid+':'+b.project).first<any>();const saved=row?JSON.parse(row.payload):{records:[]};task.status='completed';task.result=audit(saved.records||[],run.settings,run.memory);run.iterations++;log(run,'已完成项目记录盘点；未把示例记录当作英鸟真实运营数据。');
 }else{
 const poll=!!task.jobId&&['running','unknown'].includes(task.status);
 if(!poll){const caps=await capabilities(env,b.project);data.connection=caps;const issue=!caps.connected?caps.message:preflight(run,task,caps.capabilities);if(issue){task.status='blocked';task.error=issue;run.status='blocked';log(run,'执行阻塞：'+issue);const revision=await write(env.DB,uid,b.project,data,state.revision);return json({data,revision});}}
 if(!poll){task.attempt++;task.jobId=run.id+'-'+task.id+'-'+task.attempt;task.status='running';run.iterations++;log(run,'派发 '+task.name+'，幂等编号 '+task.jobId);}
 const jobId=task.jobId!;const taskId=task.id;const snapshot=structuredClone(run);const lockedRevision=await write(env.DB,uid,b.project,data,state.revision);
 let result:any;let error='';let budgetDenied=false;try{result=await runner(env,poll?'/v1/jobs/'+encodeURIComponent(jobId):'/v1/jobs',poll?undefined:{id:jobId,project:b.project,runId:run.id,task:task.id,role:task.role,command:run.command,scope:run.scope,settings:run.settings,memory:run.memory.slice(0,20).map((m:any)=>({type:m.type,text:String(m.text).slice(0,1000),source:String(m.source||'').slice(0,500)})),previous:run.tasks.filter(t=>t.result).map(t=>({task:t.id,result:{summary:String(t.result.summary||'').slice(0,1500),evidence:String(t.result.evidence||'').slice(0,1000),artifacts:t.result.artifacts?.slice(0,5)}})),budget:{currency:'USD',maxAdditionalCost:Math.max(0,run.budget-run.spent)},approval:task.approved?{approved:true,at:run.updated}:null});}catch(e:any){error=e.message;budgetDenied=e.budgetDenied===true;}
 const latest=await read(env.DB,uid,b.project);const liveRun:Run=latest.data.runs.find((r:Run)=>r.id===snapshot.id);const live=liveRun?.tasks.find(t=>t.id===taskId);if(!liveRun||!live||live.jobId!==jobId||['completed','manual','failed'].includes(live.status))return json(latest);
 if(budgetDenied){live.status='blocked';live.jobId=undefined;live.error=error;liveRun.status='blocked';log(liveRun,'预算未批准，未派发：'+error);}else if(error){live.status='unknown';live.error='执行状态未确认：'+error; if(!['cancelled','paused'].includes(liveRun.status))liveRun.status='blocked';log(liveRun,live.error+'；请核对同一任务，禁止盲目重新派发。');}
 else{const oldStatus=liveRun.status;try{consumeResult(liveRun,live,result);}catch(e:any){live.status='unknown';live.error=e.message;liveRun.status='blocked';log(liveRun,e.message);}if(['cancelled','paused'].includes(oldStatus))liveRun.status=oldStatus;}
 const revision=await write(env.DB,uid,b.project,latest.data,latest.revision);return json({data:latest.data,revision});
 }
 }
 }else throw Error('未知操作');
 }
 const revision=await write(env.DB,uid,b.project,data,state.revision);return json({data,revision});
 }catch(e:any){const code=e.message==='AUTH'?401:e.message==='CONFLICT'?409:400;return json({error:e.message==='AUTH'?'请登录后使用执行系统':e.message==='CONFLICT'?'数据正在更新，请刷新后重试':e.message},code);}
}

export async function GET(req:Request){return guard(req,env,handleGET);}

export async function POST(req:Request){return guard(req,env,handlePOST);}

// Internal module call only; no HTTP method exposes this trusted owner context.
export async function autonomousAction(req:Request,ownerId:string){return guard(req,env,handlePOST,{actor:'service:autonomy',ownerId});}
