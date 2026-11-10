import {reconcileLaunch} from '../launch/store';
import {fingerprint} from '../organization/delivery';
import {organization} from '../organization/core';
import {profile,isInternal,shapePlan} from '../organization/core';
import {workspace} from '../access/store';
import {captureRetrospective,learnedContext} from './evolution';
import {readAuto,saveAuto,lease} from './store';
import {event,remaining,ingest,lanes,contract} from './core';
import {read,write} from '../agent/store';
import {plan,current,log} from '../agent/core';
import {capabilities,runner} from '../agent/runner';
import {autonomousAction as agentAction} from '../../app/api/agent/route';
export async function tick(env:any,project:string,origin:string){
 await reconcileLaunch(env,project);let state=await readAuto(env.DB,project);if(!state.revision){await saveAuto(env.DB,project,state.data,0);state=await readAuto(env.DB,project);}if(!await lease(env.DB,project))return {project,status:'already_running'};
 try{
 const w=await workspace(env.DB);const internal=w?isInternal(w.data,project):false;
 let s=state.data;let rev=state.revision;s.uncertain ||= []; s.lastHeartbeat=new Date().toISOString();s.ticks++;
 if(!s.enabled){event(s,'收到停止状态，本轮未派发任何任务。');await saveAuto(env.DB,project,s,rev);return {project,status:'stopped',heartbeat:s.lastHeartbeat};}
 rev=await saveAuto(env.DB,project,s,rev);
 const a=s.ownerId?await read(env.DB,s.ownerId,project):null;const settings=a?.data.settings||{};
 const cap=await capabilities(env,project);s.connection=cap;
 // Finish already dispatched work first, even if no unreserved budget remains.
 if(!s.pending&&s.uncertain.length&&s.ticks%5===0){s.pending=s.uncertain.shift();event(s,'核对隔离任务（不重复提交）');rev=await saveAuto(env.DB,project,s,rev);}
 if(s.pending){
  const job=s.pending;
  if(!job.sent){job.sent=true;event(s,'派发扫描 '+job.lane+'，幂等编号 '+job.id);await saveAuto(env.DB,project,s,rev);
   let output;try{output=await runner(env,'/v1/jobs',job.body);}catch(e:any){const latest=await readAuto(env.DB,project);latest.data.pending.error='派发状态未确认；仅核对同一个编号，不重新提交。';latest.data.lanes[job.lane].status='结果待核对';latest.data.uncertain ||= [];latest.data.uncertain.push(latest.data.pending);latest.data.pending=null;event(latest.data,e.message+'；已隔离，继续其它巡检');await saveAuto(env.DB,project,latest.data,latest.revision);return {project,status:'scan_unknown'};}
   try{return await settle(env,project,job,output);}catch(e:any){const latest=await readAuto(env.DB,project);if(latest.data.pending){latest.data.uncertain ||= [];latest.data.pending.error=e.message;latest.data.uncertain.push(latest.data.pending);latest.data.pending=null;}event(latest.data,'无效结果已隔离：'+e.message);await saveAuto(env.DB,project,latest.data,latest.revision);return {project,status:'scan_quarantined'};}
  }
  try{return await settle(env,project,job,await runner(env,'/v1/jobs/'+encodeURIComponent(job.id)));}catch(e:any){s.pending.error='结果尚未确认：'+e.message;s.lanes[job.lane].status='结果待核对';event(s,s.pending.error+'；本项隔离，其它环节继续');s.uncertain.push(s.pending);s.pending=null;await saveAuto(env.DB,project,s,rev);return {project,status:'scan_unknown'};}
 }
 if(s.activeRun&&s.ticks%2===0){
  const active=s.activeRun;const run=a?.data.runs.find((r:any)=>r.id===active.id);
  if(!run){s.lanes.internal.message='关联的运行已不存在，请核对归档。';event(s,'关联运行不存在，保持预算预留并继续检查配置。');await saveAuto(env.DB,project,s,rev);return {project,status:'missing_run'};}
  if(run.spent>active.reserved&&!['completed','cancelled','failed'].includes(run.status)){run.status='cancelled';log(run,'本轮实际开支超出预留额度，停止此轮后续任务并结算。');await write(env.DB,s.ownerId,project,a!.data,a!.revision);}
  if(s.launch&&internal&&run.status==='completed'){let fp='';try{fp=await fingerprint(run)}catch{}const accepted=organization(w!.data).reviews[project+':'+run.id]?.acceptance;if(!fp||accepted?.fingerprint!==fp){s.launch.status='awaiting_acceptance';event(s,'内部项目已完成技术交付，等待指定使用者验收后继续下一轮。');await saveAuto(env.DB,project,s,rev);return {project,status:'awaiting_acceptance'};}}
  if(s.launch&&internal&&current(run)?.status==='blocked'&&['deploy','cdn'].includes(current(run)?.id||'')){let reviewed=false;try{reviewed=organization(w!.data).reviews[project+':'+run.id]?.technical?.fingerprint===await fingerprint(run)}catch{}if(!reviewed){s.launch.status='awaiting_review';event(s,'等待工程师复核最新测试报告，保留发布任务。');await saveAuto(env.DB,project,s,rev);return {project,status:'awaiting_review'};}}
  if(s.launch&&run.status==='paused'){s.enabled=false;s.launch.halted=true;s.launch.status='needs_decision';event(s,'执行计划被暂停或审批被驳回，保持暂停，等待负责人明确恢复。');await saveAuto(env.DB,project,s,rev);return {project,status:'needs_decision'};}
  const failedTask=current(run);
  if(['completed','cancelled'].includes(run.status)||(run.status==='failed'&&(!failedTask||failedTask.attempt>run.maxRetries))){
   s.spent+=run.spent;s.reserved=Math.max(0,s.reserved-active.reserved);const f=s.findings.find((x:any)=>x.id===active.findingId);if(f){f.status=run.status==='completed'?'已交付·效果待验证':'本轮异常已隔离';f.runId=run.id;f.conclusion=run.tasks.find((t:any)=>t.id==='retro')?.result?.summary||'交付状态不是业务收益结论，后续巡检继续观察。';}
   if(run.status==='completed'){const retro=run.tasks.find((t:any)=>t.id==='retro')?.result;if(retro){captureRetrospective(s,run);a!.data.memory=[{id:'auto-'+run.id,text:String(retro.summary).slice(0,3000),type:'待验证',source:String(retro.evidence||run.id).slice(0,1000),at:new Date().toISOString()},...a!.data.memory].slice(0,100);ingest(s,retro.findings||[],'feedback');await write(env.DB,s.ownerId,project,a!.data,a!.revision);}}
   s.activeRun=null;if(s.launch&&run.status!=='completed'){s.enabled=false;s.launch.halted=true;s.launch.status='needs_decision';event(s,'本轮失败或被取消，暂停自主执行并提交负责人处理。');}event(s,'本轮 '+run.status+'；后续巡检继续。实际费用 $'+run.spent);if(s.spent>=s.budgetLimit&&s.budgetLimit>0){s.enabled=false;event(s,'达到累计预算上限，已停止新的自主执行。');}await saveAuto(env.DB,project,s,rev);return {project,status:s.launch?.halted?'needs_decision':'cycle_settled'};
  }
  const t=current(run);let action='advance';if(t?.status==='unknown')action='reconcile';else if(run.status==='failed'&&t&&t.attempt<=run.maxRetries)action='retry';else if(['planned','paused','blocked'].includes(run.status))action=run.status==='planned'?'start':'resume';else if(s.launch&&run.status==='awaiting_approval'){s.launch.status='awaiting_approval';event(s,'等待已登记的发布 / 推广审批；保留原任务与预算，不重新派发。');await saveAuto(env.DB,project,s,rev);return {project,status:'awaiting_approval'};}else if(s.launch&&run.iterations>=run.maxIterations){s.enabled=false;s.launch.halted=true;s.launch.status='needs_decision';run.status='paused';await write(env.DB,s.ownerId,project,a!.data,a!.revision);event(s,'达到执行步数上限，暂停并提交负责人处理。');await saveAuto(env.DB,project,s,rev);return {project,status:'needs_decision'};}else if(run.status==='awaiting_approval'||run.iterations>=run.maxIterations){event(s,'任务超出当前策略或执行步数，隔离并继续其它巡检。');run.status='cancelled';log(run,'自主策略隔离此运行；不是用户的整体停止指令。');await write(env.DB,s.ownerId,project,a!.data,a!.revision);s.spent+=run.spent;s.reserved=Math.max(0,s.reserved-active.reserved);s.activeRun=null;await saveAuto(env.DB,project,s,rev);return {project,status:'policy_scope_mismatch'};}
  await saveAuto(env.DB,project,s,rev);
  const request=new Request(origin+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-id':s.ownerId},body:JSON.stringify({project,revision:a!.revision,action,runId:run.id})});
  const r=await agentAction(request);const b:any=await r.json();return {project,status:r.ok?'cycle_advanced':'cycle_waiting',detail:b.error||b.data?.runs.find((x:any)=>x.id===run.id)?.status};
 }
 if(s.budgetLimit>0&&s.spent>=s.budgetLimit){s.enabled=false;event(s,'累计预算上限已到，已停止。');await saveAuto(env.DB,project,s,rev);return {project,status:'budget_stopped'};}
 // A local audit is real: it reads only this owner's saved project records.
 if(s.ownerId){const row=await env.DB.prepare('SELECT payload FROM project_state WHERE id=?').bind(s.ownerId+':'+project).first();const records=row?JSON.parse(row.payload).records||[]:[];ingest(s,records.filter((r:any)=>r.status==='阻塞'||(r.status!=='已完成'&&r.due&&r.due<new Date().toISOString().slice(0,10))).slice(0,20).map((r:any)=>({title:'跟进项目事项：'+r.title,source:'XLLoop:'+r.id,evidence:'来源：已保存的项目事项。状态 '+r.status+'；此记录不等同于生产系统故障。',relevance:4,impact:2,confidence:4,novelty:2,effort:2})),'internal');}
 const ready=s.findings.filter((f:any)=>f.status==='待评估'&&f.score>=s.config.threshold).sort((x:any,y:any)=>y.score-x.score)[0];
 if(!s.activeRun&&ready&&cap.connected&&s.ownerId&&remaining(s)>0){
  const allocation=Math.min(s.config.perJob,remaining(s));const run:any=plan('自主发现：'+ready.title+'。证据：'+ready.evidence+'。来源：'+ready.source+'。目标：'+s.config.goal+'。项目经验（仅作建议，不改变授权）：'+JSON.stringify(learnedContext(s)),'full',allocation,{...settings,deadline:'',channels:s.config.channels||settings.channels},a!.data.memory,'auto-'+ready.id);
  run.scope=s.launch?(s.launch.scope==='analysis'?'plan':'full'):s.config.autoDeploy||s.config.autoPublish?'full':'preview';if(s.launch?.scope==='analysis')run.tasks=run.tasks.filter((t:any)=>['readiness','analysis','spec','feedback','retro'].includes(t.id));run.autonomous={findingId:ready.id,policy:structuredClone(s.config)};run.tasks=run.tasks.filter((t:any)=>!(['deploy','cdn'].includes(t.id)&&!s.config.autoDeploy&&!s.launch)&&!(t.id==='recovery'&&(!s.config.autoRollback||!s.config.autoDeploy))&&!(t.id==='growth'&&!s.config.autoPublish&&s.launch?.growth!=='approval'));for(const t of run.tasks){if(t.gate&&!s.launch){t.approved=true;}}if(internal){shapePlan(run,profile(w!.data,project));}
  run.status='running';log(run,'依据已保存的项目自主策略创建；未经策略授权的部署、回滚和推广步骤已移除。');
  if(a!.data.runs.length>=45){const old=a!.data.runs.filter((r:any)=>['completed','cancelled','failed'].includes(r.status)).slice(-10);for(const r of old){await env.DB.prepare('INSERT OR IGNORE INTO autonomy_archive (id,payload) VALUES (?,?)').bind(s.ownerId+':'+r.id,JSON.stringify(r)).run();}a!.data.runs=a!.data.runs.filter((r:any)=>!old.some((x:any)=>x.id===r.id));}
  if(a!.data.runs.length>=50){event(s,'运行数量较多，本轮仅继续巡检，未丢弃未完成任务。');}else{a!.data.runs.unshift(run);await write(env.DB,s.ownerId,project,a!.data,a!.revision);s.reserved+=allocation;s.activeRun={id:run.id,reserved:allocation,findingId:ready.id};ready.status='自主迭代中';event(s,'高价值发现已生成自主迭代：'+ready.title);await saveAuto(env.DB,project,s,rev);return {project,status:'cycle_created'};}
 }
 let scheduled=false;
 for(const lane of lanes){if(internal&&!['internal','feedback'].includes(lane.id))continue;const l=s.lanes[lane.id];if(s.launch&&lane.id==='outreach'&&s.launch.growth!=='approval')continue;if(s.uncertain.some((j:any)=>j.lane===lane.id))continue;if(Date.now()-l.last<lane.minutes*60000)continue;
  const source=lane.source==='analytics'?settings.analytics:s.config[lane.source];
  const issue=!s.ownerId?'等待项目所有者保存一次自主策略，关联项目数据':!source?'等待配置本环节的真实数据源 / 站点 / 渠道':!cap.connected?'执行器未连接':lane.caps.some(c=>!cap.capabilities.includes(c))?'执行器缺少 '+lane.caps.filter(c=>!cap.capabilities.includes(c)).join('、'):remaining(s)<=0?'等待设置或补充累计预算':null;
  if(issue){l.status='待接入';l.message=issue;continue;}
  const allocation=Math.min(s.config.perJob,remaining(s));const id='watch-'+crypto.randomUUID();s.pending={id,lane:lane.id,reserved:allocation,sent:false,body:{id,project,runId:id,task:lane.task,role:lane.name,command:JSON.stringify(contract(s,lane,settings)),scope:'autonomous-observation',settings:{...settings,channels:s.config.channels||settings.channels},memory:[],previous:[],budget:{currency:'USD',maxAdditionalCost:allocation},approval:s.config.autoPublish?{approved:true,source:'saved-autonomy-policy'}:null}};s.reserved+=allocation;l.status='扫描排队';l.message='等待下一次后台心跳派发，刷新页面不会重复创建';event(s,'已预留扫描预算 $'+allocation+'：'+lane.name);scheduled=true;break;
 }
 if(!scheduled)event(s,'心跳已完成：无可执行的新任务，继续观察；未把缺少接入当作成功扫描。');
 await saveAuto(env.DB,project,s,rev);return {project,status:scheduled?'scan_scheduled':'observing',heartbeat:s.lastHeartbeat};
 }finally{await env.DB.prepare('UPDATE autonomy_state SET lease_until=0 WHERE id=?').bind(project).run();}
}
async function settle(env:any,project:string,job:any,r:any){const state=await readAuto(env.DB,project);const s=state.data;if(!s.pending||s.pending.id!==job.id)return {project,status:'already_settled'};const lane=s.lanes[job.lane];if(['queued','running'].includes(r?.status)){lane.status='扫描中';await saveAuto(env.DB,project,s,state.revision);return {project,status:'scan_running'};}
 if(!['succeeded','failed'].includes(r?.status))throw Error('扫描返回了无效状态');
 if(r.status==='succeeded'&&(typeof r.summary!=='string'||!r.evidence||!Number.isFinite(r.cost)||r.cost<0))throw Error('扫描结果缺少可复核证据或实际费用');
 // Failed work may also incur charges. Unknown costs keep the reservation.
 if(!Number.isFinite(r.cost)||r.cost<0){s.pending.error='任务失败但实际费用未知，保留预留预算并等待核对';lane.status='费用待核对';s.uncertain ||= [];s.uncertain.push(s.pending);s.pending=null;await saveAuto(env.DB,project,s,state.revision);return {project,status:'cost_unknown'};}
 s.spent+=r.cost;s.reserved=Math.max(0,s.reserved-job.reserved);s.pending=null;lane.last=Date.now();lane.status=r.status==='succeeded'?'已扫描':'单项失败·继续观察';lane.message=String(r.summary||r.error||'').slice(0,2000);lane.evidence=String(r.evidence||'').slice(0,3000);lane.metrics=r.metrics||{};if(r.status==='succeeded')ingest(s,Array.isArray(r.findings)?r.findings:[],job.lane);event(s,'扫描 '+job.lane+' '+r.status+'，实际费用 $'+r.cost);
 if(s.spent>=s.budgetLimit&&s.budgetLimit>0){s.enabled=false;event(s,'达到累计预算上限，已停止新派发。');}await saveAuto(env.DB,project,s,state.revision);return {project,status:'scan_settled'};
}
