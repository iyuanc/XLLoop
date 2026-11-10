import {workspace} from '../access/store';
import {governance,totals} from '../governance/store';
import {profile} from '../organization/core';
import {read,write} from '../agent/store';
import {readAuto,saveAuto} from '../autonomy/store';
import {event,ingest} from '../autonomy/core';
import {capabilities} from '../agent/runner';
import {readiness} from './core';
export async function reconcileLaunch(env:any,project:string){const w=await workspace(env.DB);if(!w)return null;const o=governance(w).opportunities.find((o:any)=>o.projectId===project&&o.status==='approved'&&!o.fundingOnly);if(!o?.launch?.enabled)return null;
 const a=await read(env.DB,w.data.ownerId,project);const old=await readAuto(env.DB,project),s=old.data;const fresh=!s.launch;const oldMissing=JSON.stringify(s.launch?.missing);
 const connection=await capabilities(env,project),missing=readiness(w,o,a.data.settings,connection,!!s.activeRun||!!s.pending||!!s.uncertain?.length);
 s.ownerId=w.data.ownerId;s.budgetLimit=o.cap;s.config.goal=o.value+'；批准范围：'+o.plan+'；风险及停止条件：'+o.risks+'；截止日期：'+o.deadline;s.config.perJob=o.launch.perJob;s.config.autoDeploy=false;s.config.autoPublish=false;s.config.autoRollback=false;if(o.launch.scope==='analysis')s.config.threshold=60;
 s.launch={...s.launch,opportunityId:o.id,scope:o.launch.scope,growth:profile(w.data,project).type==='internal'?'disabled':o.launch.growth,approvedBy:o.approvedBy,approvedAt:o.approvedAt,missing,checkedAt:new Date().toISOString()};
 if(fresh){s.enabled=false;s.launch.startedAt=null;s.launch.stopped=false;s.launch.halted=false;}
 if(s.launch.stopped){s.enabled=false;s.launch.status='stopped';}
 else if(s.launch.halted){s.enabled=false;s.launch.status='needs_decision';}
 else if(missing.length){s.enabled=false;s.launch.status='preparing';}
 else {s.enabled=true;s.launch.status=s.launch.startedAt?'running':'ready';if(!s.launch.startedAt){s.launch.startedAt=new Date().toISOString();s.launch.status='running';ingest(s,[{title:'执行获批项目首轮：'+o.title,source:'XLLoop:opportunity:'+o.id,evidence:'来源为已批准的立项申请，不代表需求和收益已被验证。待验证事项：'+o.evidence+'；验收标准：'+o.validation,relevance:5,impact:5,confidence:4,novelty:3,effort:1}],'internal');event(s,'立项批准的条件已齐备，首轮进入自主队列；发布与推广保留审批。');}}
 if(fresh||oldMissing!==JSON.stringify(missing))event(s,missing.length?'启动准备缺项：'+missing.map((m:any)=>m.title).join('；'):'启动检查通过');
 s.connection=connection;await saveAuto(env.DB,project,s,old.revision);return {project,status:s.launch.status,missing};}
export async function reconcileLaunches(env:any){const w=await workspace(env.DB);if(!w)return [];const result=[];const rows=(await env.DB.prepare('SELECT id,payload FROM autonomy_state').all()).results;const checked=new Map(rows.map((r:any)=>[r.id,JSON.parse(r.payload).launch?.checkedAt||'']));for(const o of governance(w).opportunities.filter((o:any)=>o.status==='approved'&&o.launch?.enabled&&!o.fundingOnly).sort((a:any,b:any)=>String(checked.get(a.projectId)||'').localeCompare(String(checked.get(b.projectId)||''))).slice(0,5)){try{result.push(await reconcileLaunch(env,o.projectId))}catch(e:any){result.push({project:o.projectId,status:'retry_next_heartbeat',error:e.message})}}return result;}
