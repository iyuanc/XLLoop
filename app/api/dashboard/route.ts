import {organization,profile,canSee,canReview,assertFunding} from '../../../lib/organization/core';
import {summary as feedbackSummary} from '../../../lib/feedback/store';
import {env} from 'cloudflare:workers';
import {principal} from '../../../lib/access/store';
import {allowed,grantFor} from '../../../lib/access/core';
import {denied} from '../../../lib/access/guard';
import {governance,projects as approvedProjects,totals} from '../../../lib/governance/store';
const builtins=[{id:'ybirds',name:'英鸟网',desc:'分类信息与智能分发',color:'#087f6d'},{id:'ukec',name:'UKEC',desc:'留学与招生服务',color:'#5470c6'},{id:'sandbox',name:'试验场',desc:'隔离测试项目',color:'#9b66b1'}];
export async function GET(req:Request){try{
 const p=await principal(req,env),g=governance(p.workspace),prefix=p.ownerId+':project:';
 const custom=(await env.DB!.prepare('SELECT payload FROM project_state WHERE substr(id,1,?) = ?').bind(prefix.length,prefix).all<any>()).results.map(r=>JSON.parse(r.payload));
 const list=[...builtins,...custom,...await approvedProjects(env.DB,p.ownerId)].filter((x:any,i:number,a:any[])=>a.findIndex(v=>v.id===x.id)===i&&(p.isOwner||p.member.grants.some((v:any)=>v.project===x.id)));
 const approvals:any[]=[];
 const summaries=await Promise.all(list.map(async(meta:any)=>{
 const [records,agent,auto]=await Promise.all([env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(p.ownerId+':'+meta.id).first<any>(),env.DB!.prepare('SELECT payload FROM agent_state WHERE id=?').bind(p.ownerId+':'+meta.id).first<any>(),env.DB!.prepare('SELECT payload FROM autonomy_state WHERE id=?').bind(meta.id).first<any>()]);
 const r=records?JSON.parse(records.payload):null,a=agent?JSON.parse(agent.payload):null,s=auto?JSON.parse(auto.payload):null;
 const items=r?.records||[],runs=a?.runs||[];const grant=grantFor(p,meta.id);
 for(const run of runs.filter((v:any)=>v.status==='awaiting_approval')){const task=run.tasks.find((v:any)=>!['completed','manual'].includes(v.status));const permission=task?.capabilities?.includes('marketing')?'growth.approve':task?.capabilities?.some((c:string)=>['deploy','cdn','rollback'].includes(c))?'release.approve':'agent.execute';if(allowed(grant,permission))approvals.push({id:run.id,project:meta.id,projectName:meta.name,title:task?.name||'执行审批',command:run.command,budget:run.budget,spent:run.spent,kind:'execution'});}
 const blocked=items.filter((v:any)=>v.status==='阻塞').length+ runs.filter((v:any)=>['blocked','failed'].includes(v.status)).length;
 const overdue=items.filter((v:any)=>v.status!=='已完成'&&v.due&&v.due<new Date().toISOString().slice(0,10)).length;
 const funded=g.opportunities.some((o:any)=>o.projectId===meta.id&&o.status==='approved');
 const cfg=profile(p.workspace.data,meta.id);if(s?.launch?.status==='preparing'&&(p.isOwner||allowed(grant,'architecture')||allowed(grant,'agent.settings')))approvals.push({id:'prepare-'+meta.id,project:meta.id,projectName:meta.name,title:meta.name+'：补齐自动启动条件',kind:'setup',budget:0});if(s?.launch?.status==='awaiting_acceptance'&&(p.isOwner||(cfg.acceptor||cfg.businessOwner)===p.uid))approvals.push({id:'accept-'+meta.id,project:meta.id,projectName:meta.name,title:meta.name+'：上线后使用者验收',kind:'review',budget:0});if(cfg.type==='internal'&&s?.activeRun&&allowed(grant,'execution.tech')){const run=runs.find((v:any)=>v.id===s.activeRun.id);if(run?.tasks.some((t:any)=>t.id==='test'&&t.status==='completed'&&t.result?.evidence)&&!organization(p.workspace.data).reviews[meta.id+':'+run.id]?.technical)approvals.push({id:'technical-'+run.id,project:meta.id,projectName:meta.name,title:meta.name+'：工程师复核测试报告',kind:'review',budget:0});}return {...meta,profile:cfg,launch:s?.launch||null,total:items.length,done:items.filter((v:any)=>v.status==='已完成').length,active:items.filter((v:any)=>v.status==='进行中').length,blocked,overdue,running:runs.filter((v:any)=>v.status==='running').length,connected:(s?.connection||a?.connection)?.connected===true,goal:r?.config?.goal||a?.settings?.objective||'',hasData:!!records||!!agent||!!auto,budget:funded?totals(g,meta.id):null,lastHeartbeat:s?.lastHeartbeat||null};
 }));
 const opportunities=g.opportunities.filter((o:any)=>canSee(p,o));
 const pending=g.opportunities.filter((o:any)=>o.status==='pending'&&canReview(p,o)).map((o:any)=>({id:o.id,title:o.title,budget:o.budget,owner:o.owner,source:o.source,kind:'proposal'}));
 const org=organization(p.workspace.data);const requests=org.budgetRequests.filter((r:any)=>r.status==='pending'&&canReview(p,{projectId:r.project,region:r.region})).map((r:any)=>({id:r.id,title:r.title,budget:r.requestedCap,kind:'budget',project:r.project}));
 return Response.json({regions:org.regions,teams:org.teams,feedback:feedbackSummary(p.workspace,p.uid),projects:summaries,approvals:[...pending,...requests,...approvals],opportunityCount:opportunities.filter((o:any)=>['idea','returned','pending'].includes(o.status)).length,emergencyStop:p.workspace.data.emergencyStop,isOwner:p.isOwner,at:new Date().toISOString()},{headers:{'Cache-Control':'private,no-store'}});
 }catch(e){return denied(e);}}
