import {profile,shapePlan} from '../../../lib/organization/core';
import {workspace} from '../../../lib/access/store';
import {guard} from '../../../lib/access/guard';
import {isSameOrigin} from '../../../lib/http/origin';
import {env} from '../../../lib/runtime/env';
import {read,write,validProject} from '../../../lib/agent/store';
import {plan,current,audit,log,preflight,consumeResult,scopes,Run,MAX_TASK_RETRIES} from '../../../lib/agent/core';
import {capabilities,runner} from '../../../lib/agent/runner';
import {defaults as architectureDefaults,normalize as normalizeArchitecture} from '../../../lib/architecture/core';
const json=(body:any,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
async function identity(req:Request,project:any){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)throw Error('AUTH');if(!await validProject(env.DB,uid,project))throw Error('PROJECT');return uid;}
const clean=(v:any,n=3000)=>typeof v==='string'?v.trim().slice(0,n):'';
async function publishWorkBranches(uid:string,project:string,run:Run){
 const required=['develop','review','test','preview'];const delivery=required.map(id=>run.tasks.find(t=>t.id===id));
 if(delivery.some(t=>!t))throw Error('运行缺少自动推送所需的交付步骤，请按最新配置重建计划');
 const incomplete=delivery.filter(t=>t!.status!=='completed'||t!.result?.metrics?.skipped===true);
 if(incomplete.length)return {summary:'自动推送已跳过。',evidence:'以下步骤不是执行器自动成功状态：'+incomplete.map(t=>`${t!.name}（${t!.status}）`).join('、')+'。人工完成、失败或状态不明的运行不得自动推送。',cost:0,artifacts:[],metrics:{skipped:true,reason:'delivery_not_automatically_verified'}};
 const row=await env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(uid+':architecture:'+project).first<any>();
 const architecture=normalizeArchitecture(row?JSON.parse(row.payload):architectureDefaults());
 const configured=architecture.repositories.filter((repo:any)=>repo.enabled!==false&&repo.access==='edit'&&repo.autoPublish===true);
 if(!configured.length)return {summary:'自动推送已跳过。',evidence:'项目没有为任何可编辑仓库开启“执行器验证全部通过后自动推送工作分支”。',cost:0,artifacts:[],metrics:{skipped:true,reason:'auto_publish_disabled'}};
 const status=await runner(env,'/v1/repositories?project='+encodeURIComponent(project));const liveRows=Array.isArray(status?.repositories)?status.repositories:[];
 const publishable:any[]=[];const skipped:string[]=[];
 for(const repo of configured){const live=liveRows.find((item:any)=>item.id===repo.id);if(!live)throw Error(`仓库 ${repo.id} 尚未同步到执行器`);if(live.autoPublish!==true)throw Error(`仓库 ${repo.id} 的自动推送授权尚未同步，请在技术配置中执行“拉取 / 同步到执行器”`);const unchangedPublished=live.remotePublished&&!live.dirty&&(!live.publishedCommit||String(live.publishedCommit).startsWith(String(live.head||'')));if(unchangedPublished){skipped.push(`${repo.id} 已推送且没有新修改`);continue}if(!live.dirty&&!(Number(live.ahead)>0)){skipped.push(`${repo.id} 无待推送修改`);continue}publishable.push(repo);}
 const published:any[]=[];const message=('XLLoop 自动交付：'+run.command.replace(/[\r\n]+/g,' ').trim()).slice(0,190)+' '+run.id.slice(0,8);
 for(const repo of publishable){const result=await runner(env,'/v1/repositories/publish',{project,repositoryId:repo.id,message,approved:true,approvalSource:'saved_project_auto_publish'});published.push(result);}
 return {summary:published.length?`已自动提交并推送 ${published.length} 个工作分支。`:'没有需要自动推送的仓库。',evidence:[...published.map(item=>`${item.repositoryId}: ${item.branch} @ ${String(item.commit).slice(0,12)}`),...skipped].join('\n')||'所有已授权仓库均无待推送修改。',cost:0,artifacts:[],metrics:{published:published.map(item=>({repositoryId:item.repositoryId,branch:item.branch,commit:item.commit})),skipped}};
}
async function manuallyPublishWorkBranches(uid:string,project:string,message:string){
 if(message.length<2||message.length>200||/[\r\n]/.test(message)||!/[\u4e00-\u9fff]/.test(message))throw Error('请填写 2 至 200 个字符的单行中文提交说明');
 const row=await env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(uid+':architecture:'+project).first<any>();
 const architecture=normalizeArchitecture(row?JSON.parse(row.payload):architectureDefaults());
 const configured=architecture.repositories.filter((repo:any)=>repo.enabled!==false&&repo.access==='edit');
 if(!configured.length)throw Error('项目没有可手动推送的可编辑仓库');
 const status=await runner(env,'/v1/repositories?project='+encodeURIComponent(project));const liveRows=Array.isArray(status?.repositories)?status.repositories:[];
 const publishable:any[]=[];const skipped:string[]=[];
 for(const repo of configured){const live=liveRows.find((item:any)=>item.id===repo.id);if(!live)throw Error(`仓库 ${repo.id} 尚未同步到执行器`);const unchangedPublished=live.remotePublished&&!live.dirty&&(!live.publishedCommit||String(live.publishedCommit).startsWith(String(live.head||'')));if(unchangedPublished){skipped.push(`${repo.id} 已推送且没有新修改`);continue}if(!live.dirty&&!(Number(live.ahead)>0)){skipped.push(`${repo.id} 无待推送修改`);continue}publishable.push(repo);}
 if(!publishable.length)throw Error('没有待提交或待推送的工作分支');
 const published=[] as any[];for(const repo of publishable)published.push(await runner(env,'/v1/repositories/publish',{project,repositoryId:repo.id,message,approved:true,approvalSource:'manual_run_publish'}));
 return {published,skipped};
}
async function handleGET(req:Request){try{const p=new URL(req.url).searchParams.get('project');const uid=await identity(req,p);const saved=await read(env.DB,uid,p!);return json(saved);}catch(e:any){return json({error:e.message==='AUTH'?'请登录后使用执行系统':'项目不可用'},e.message==='AUTH'?401:400)}}
async function handlePOST(req:Request){
 try{
 if(!isSameOrigin(req))return json({error:'跨站请求被拒绝'},403);
 if(Number(req.headers.get('content-length'))>100000)return json({error:'请求过大'},413);
 const b:any=await req.json();if(JSON.stringify(b).length>100000)return json({error:'请求过大'},413);const uid=await identity(req,b.project);const state=await read(env.DB,uid,b.project);if(b.revision!==state.revision)return json({error:'数据已更新，请刷新后重试'},409);let data=state.data;
 if(b.action==='settings'){
 const s=b.settings||{};data.settings={objective:clean(s.objective),repo:clean(s.repo,500),environment:clean(s.environment,500),analytics:clean(s.analytics,1000),cdn:clean(s.cdn,500),channels:clean(s.channels,1000),owner:clean(s.owner,80)||'待分配',deadline:clean(s.deadline,20),currency:'USD',maxRetries:Math.min(MAX_TASK_RETRIES,Math.max(0,Number(s.maxRetries)||0)),maxIterations:Math.min(100,Math.max(5,Number(s.maxIterations)||30))};
 }else if(b.action==='memory'){
 if(!clean(b.text))throw Error('请填写记忆内容');if(!['已验证事实','待验证','假设','风险'].includes(b.type))throw Error('记忆类型无效');if(b.type==='已验证事实'&&!clean(b.source))throw Error('事实记忆需要来源');data.memory=[{id:crypto.randomUUID(),text:clean(b.text),type:b.type,source:clean(b.source,1000),at:new Date().toISOString()},...data.memory].slice(0,100);
 }else if(b.action==='create'){
 if(!clean(b.command)||!scopes[b.scope]||!Number.isFinite(b.budget)||b.budget<=0||b.budget>10000||typeof b.requestId!=='string'||b.requestId.length>100)throw Error('请填写指令、执行范围与有效预算');
 const old=data.runs.find((r:Run)=>r.requestId===b.requestId);if(old)return json({...state,runId:old.id});if(data.runs.length>=50)throw Error('单项目最多保留 50 次运行，请先导出归档');const w=await workspace(env.DB);const run=shapePlan(plan(clean(b.command),b.scope,b.budget,data.settings,data.memory,b.requestId),profile(w?.data||{},b.project));data.runs.unshift(run);
 }else if(b.action==='check'){
 const caps=await capabilities(env,b.project);data.connection=caps;
 }else{
 const run:Run=data.runs.find((r:Run)=>r.id===b.runId);if(!run)throw Error('运行不存在');let task=current(run);
 if(b.action==='manualPublish'){
 if(run.status!=='completed')throw Error('只有已完成运行才能手动推送');const publishTask=run.tasks.find(t=>t.id==='publish');const manualPublishReasons=['delivery_not_automatically_verified','auto_publish_disabled'];if(!publishTask||!manualPublishReasons.includes(publishTask.result?.metrics?.reason))throw Error('当前运行没有可手动接管的已跳过推送步骤');const message=clean(b.message,200);const result=await manuallyPublishWorkBranches(uid,b.project,message);publishTask.status='manual';publishTask.error='';publishTask.result={summary:`已人工确认并推送 ${result.published.length} 个工作分支。`,evidence:[...result.published.map((item:any)=>`${item.repositoryId}: ${item.branch} @ ${String(item.commit).slice(0,12)}`),...result.skipped].join('\n'),cost:0,artifacts:[],metrics:{manualPublish:true,published:result.published.map((item:any)=>({repositoryId:item.repositoryId,branch:item.branch,commit:item.commit})),skipped:result.skipped}};log(run,'用户人工确认并推送工作分支；未合并 master/main，也未部署。','用户');
 }else if(b.action==='start'||b.action==='resume'){
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
 if(!task||task.status!=='failed'||task.attempt>MAX_TASK_RETRIES)throw Error('当前任务不可重试或已达到 10 次重试上限');if(task.attempt>run.maxRetries){run.maxRetries=MAX_TASK_RETRIES;log(run,'用户明确重试，将本轮单步骤重试上限扩展为 10 次。','用户');}task.status='pending';task.jobId=undefined;task.error='';run.status='running';log(run,'用户请求重试已确认失败的任务','用户');
 }else if(b.action==='manual'){
 if(!task||['running','unknown'].includes(task.status)||['completed','cancelled'].includes(run.status))throw Error('外部任务状态未确认或运行已结束，不能人工覆盖');if(task.gate&&!task.approved)throw Error('此步骤需要先审批');if(!clean(b.summary)||!clean(b.evidence))throw Error('人工接管必须提供结果和证据');task.status='manual';task.error='';task.result={summary:clean(b.summary),evidence:clean(b.evidence),source:'人工接管',cost:0};log(run,task.name+'由用户接管完成；不是 Agent 自动执行结果','用户');run.status=current(run)?'paused':'completed';
 }else if(b.action==='advance'||b.action==='reconcile'){
 if(!task){run.status='completed';}else{
 if(b.action==='advance'&&run.status!=='running')throw Error('运行未启动');if(b.action==='reconcile'&&!['unknown','running'].includes(task.status))throw Error('没有待核对的任务');
 if(task.status==='running'&&!task.jobId)throw Error('内置步骤正在处理，请稍后刷新');
 if(run.iterations>=run.maxIterations){run.status='paused';log(run,'达到最大执行步数，已暂停。');}
 else if(run.spent>=run.budget){run.status='paused';log(run,'预算已用完，已暂停。');}
 else if(task.gate&&!task.approved){task.status='awaiting_approval';run.status='awaiting_approval';log(run,'等待用户审批：'+task.name);}
 else if(task.id==='readiness'){
 const row=await env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(uid+':'+b.project).first<any>();const saved=row?JSON.parse(row.payload):{records:[]};task.status='completed';task.result=audit(saved.records||[],run.settings,run.memory);run.iterations++;log(run,'已完成项目记录盘点；未把示例记录当作英鸟真实运营数据。');
 }else if(task.id==='analysis'&&!String(run.settings.analytics||'').trim()){
 task.status='completed';task.error='';task.result={summary:'未配置业务数据，本步骤已跳过。',evidence:'运行快照中的“分析数据源与指标口径”为空；未调用外部执行器或大模型。',cost:0,artifacts:[],metrics:{skipped:true,reason:'missing_business_data'}};run.iterations++;log(run,'未配置业务数据，已跳过业务数据分析步骤；未产生模型费用。');if(!current(run)){run.status='completed';log(run,'本次授权范围内的步骤已完成。');}
 }else if(task.id==='publish'){
 task.attempt++;run.iterations++;try{task.result=await publishWorkBranches(uid,b.project,run);task.status='completed';task.error='';log(run,task.result.metrics?.skipped?'自动推送步骤已安全跳过：'+task.result.evidence:'工作分支已自动提交并推送；未合并 master/main，也未部署。','系统');if(!current(run)){run.status='completed';log(run,'本次授权范围内的步骤已完成。');}}catch(e:any){task.status='failed';task.error=String(e.message||'自动推送失败').slice(0,1000);run.status='failed';log(run,'自动推送失败：'+task.error,'系统');}
 }else{
 const poll=!!task.jobId&&['running','unknown'].includes(task.status);
 if(!poll){const caps=await capabilities(env,b.project);data.connection=caps;const issue=!caps.connected?caps.message:preflight(run,task,caps.capabilities);if(issue){task.status='blocked';task.error=issue;run.status='blocked';log(run,'执行阻塞：'+issue);const revision=await write(env.DB,uid,b.project,data,state.revision);return json({data,revision});}}
 if(!poll){task.attempt++;task.jobId=run.id+'-'+task.id+'-'+task.attempt;task.status='running';run.iterations++;log(run,'派发 '+task.name+'，幂等编号 '+task.jobId);}
 const jobId=task.jobId!;const taskId=task.id;const snapshot=structuredClone(run);const lockedRevision=await write(env.DB,uid,b.project,data,state.revision);
 let result:any;let error='';let budgetDenied=false;try{result=await runner(env,poll?'/v1/jobs/'+encodeURIComponent(jobId):'/v1/jobs',poll?undefined:{id:jobId,project:b.project,runId:run.id,task:task.id,role:task.role,command:run.command,scope:run.scope,settings:run.settings,memory:run.memory.slice(0,20).map((m:any)=>({type:m.type,text:String(m.text).slice(0,1000),source:String(m.source||'').slice(0,500)})),previous:run.tasks.filter(t=>t.result).map(t=>({task:t.id,result:{summary:String(t.result.summary||'').slice(0,1500),evidence:String(t.result.evidence||'').slice(0,1000),artifacts:t.result.artifacts?.slice(0,5)}})),budget:{currency:'USD',maxAdditionalCost:Math.max(0,run.budget-run.spent)},approval:task.approved?{approved:true,at:run.updated}:null});}catch(e:any){error=e.message;budgetDenied=e.budgetDenied===true;}
 const latest=await read(env.DB,uid,b.project);const liveRun:Run=latest.data.runs.find((r:Run)=>r.id===snapshot.id);const live=liveRun?.tasks.find(t=>t.id===taskId);if(!liveRun||!live||live.jobId!==jobId||['completed','manual','failed'].includes(live.status))return json(latest);
 if(budgetDenied){live.status='blocked';live.jobId=undefined;live.error=error;liveRun.status='blocked';log(liveRun,'预算未批准，未派发：'+error);}else if(error){live.status='unknown';live.error='执行状态未确认：'+error; if(!['cancelled','paused'].includes(liveRun.status))liveRun.status='blocked';log(liveRun,live.error+'；请核对同一任务，禁止盲目重新派发。');}
 else{const oldStatus=liveRun.status;try{consumeResult(liveRun,live,result);if(live.id==='analysis'&&live.status==='completed'){const verdict=live.result?.metrics?.diagnosis;if(verdict==='not_exists'){for(const remaining of liveRun.tasks.slice(liveRun.tasks.indexOf(live)+1)){remaining.status='completed';remaining.error='';remaining.result={summary:'问题诊断未发现问题，后续步骤已跳过。',evidence:'问题诊断结论为 not_exists；未修改代码、未推送分支、未部署。',cost:0,artifacts:[],metrics:{skipped:true,reason:'diagnosis_not_exists'}};}liveRun.status='completed';log(liveRun,'问题诊断结论：问题不存在；本轮流程通过并结束，未执行代码修改或发布。','执行器');}else if(verdict==='unknown'){liveRun.status='paused';log(liveRun,'问题诊断证据不足，已暂停后续步骤；补充复现条件或证据后请重建计划。','执行器');}else if(verdict==='exists'){log(liveRun,'问题诊断结论：问题存在；继续产品、开发与验证流程。','执行器');}}}catch(e:any){live.status='unknown';live.error=e.message;liveRun.status='blocked';log(liveRun,e.message);}if(['cancelled','paused'].includes(oldStatus))liveRun.status=oldStatus;}
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
