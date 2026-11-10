import {guard} from '../../../lib/access/guard';
import {isSameOrigin} from '../../../lib/http/origin';
import {addExperiment,evaluate,ruleAction,intervention} from '../../../lib/autonomy/evolution';
import {env} from '../../../lib/runtime/env';
import {readAuto,saveAuto} from '../../../lib/autonomy/store';
import {normalizeConfig,event} from '../../../lib/autonomy/core';
import {validProject} from '../../../lib/agent/store';
const reply=(b:any,s=200)=>Response.json(b,{status:s,headers:{'Cache-Control':'private,no-store'}});
async function auth(req:Request,project:string){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)throw Error('AUTH');if(!await validProject(env.DB,uid,project))throw Error('项目不可用');return uid;}
async function handleGET(req:Request){try{const p=new URL(req.url).searchParams.get('project')||'ybirds';const uid=await auth(req,p);const s=await readAuto(env.DB,p);if(s.data.ownerId&&s.data.ownerId!==uid)return reply({error:'仅项目所有者可访问'},403);return reply(s);}catch(e:any){return reply({error:e.message==='AUTH'?'请先登录':e.message},e.message==='AUTH'?401:400)}}
async function handlePOST(req:Request){try{if(!isSameOrigin(req))return reply({error:'跨站请求被拒绝'},403);const b:any=await req.json();if(JSON.stringify(b).length>40000)throw Error('请求过大');const uid=await auth(req,b.project);const s=await readAuto(env.DB,b.project);if(s.data.ownerId&&s.data.ownerId!==uid)return reply({error:'仅项目所有者可操作'},403);if(b.revision!==s.revision)throw Error('CONFLICT');s.data.ownerId=uid;
 if(b.action==='config'){if(s.data.launch&&(b.config?.autoDeploy||b.config?.autoPublish||b.config?.autoRollback))throw Error('立项自动循环的发布与推广须逐项审批，不能改为免审批');if(!Number.isFinite(b.budgetLimit)||b.budgetLimit<0||b.budgetLimit>100000)throw Error('请填写有效的累计预算（USD）');s.data.config=normalizeConfig(b.config||{});s.data.budgetLimit=b.budgetLimit;event(s.data,'所有者保存自主策略；不变更已派发任务的冻结范围。');}
 else if(b.action==='stop'){s.data.enabled=false;if(s.data.launch)s.data.launch.stopped=true;event(s.data,'用户发出停止指令；停止后续派发，外部已运行任务仍需核对。');}
 else if(b.action==='start'){if(s.data.budgetLimit>0&&s.data.spent>=s.data.budgetLimit)throw Error('预算已用完，补充预算后才能恢复');s.data.enabled=true;if(s.data.launch){s.data.launch.stopped=false;s.data.launch.halted=false;}event(s.data,'用户恢复持续巡检。');}
 else if(b.action==='experiment'){addExperiment(s.data,b.experiment||{});event(s.data,'已登记实验及观察期，锁定经营目标与人工时间目标。');}
 else if(b.action==='evaluate'){const x=evaluate(s.data,b.evaluation||{});event(s.data,'实验复核：'+x.title+' → '+x.evaluation.verdict+'；证据为所有者提交，不代表自动独立验证。');}
 else if(b.action==='rule'){const r=ruleAction(s.data,b.rule||{});event(s.data,'经验版本更新：'+r.status+'；未改变工具授权。');}
 else if(b.action==='intervention'){intervention(s.data,b.intervention||{});event(s.data,'已记录人工纠正，作为待验证建议供后续任务参考。');}
 else throw Error('未知操作');return reply({data:s.data,revision:await saveAuto(env.DB,b.project,s.data,s.revision)});
 }catch(e:any){return reply({error:e.message==='AUTH'?'请先登录':e.message==='CONFLICT'?'数据已更新，请刷新后重试':e.message},e.message==='AUTH'?401:e.message==='CONFLICT'?409:400)}}

export async function GET(req:Request){return guard(req,env,handleGET);}

export async function POST(req:Request){return guard(req,env,handlePOST);}
