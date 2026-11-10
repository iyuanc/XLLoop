import {isInternal,organization,profile} from '../organization/core';
import {AccessError,grantFor,assertPermission,withinBudget,assertRecords,allowed} from './core';
import {principal,internalOwnerPrincipal,auditStart,auditEnd,workspace} from './store';
import {isSameOrigin} from '../http/origin';
export function denied(e:any){if(!(e instanceof AccessError))console.error('ACCESS_GUARD_FAILURE',String(e?.name||'Error'),String(e?.message||'unknown').slice(0,500),String(e?.stack||'').slice(0,1500));return Response.json({error:e instanceof AccessError?e.message:'权限校验或审计失败，请重试'},{status:e instanceof AccessError?e.status:503,headers:{'Cache-Control':'private,no-store'}});}
export async function guard(req:Request,env:any,handler:(req:Request)=>Promise<Response>,trusted?:{actor:string;ownerId:string}){let auditId='',actor='',auditProject='*';try{
 const url=new URL(req.url),path=url.pathname;const mutate=!['GET','HEAD'].includes(req.method);
 if(mutate&&!isSameOrigin(req))throw new AccessError('跨站请求被拒绝');
 let b:any={};if(mutate){const raw=await req.clone().text();if(raw.length>600000)throw new AccessError('请求过大',413);try{b=JSON.parse(raw)}catch{throw new AccessError('JSON 无效',400);}}
 const p=trusted?await internalOwnerPrincipal(env,trusted.ownerId):await principal(req,env),project=mutate?b.project:url.searchParams.get('project');actor=trusted?.actor||p.uid;auditProject=typeof project==='string'?project:'*';
 if(path==='/api/projects'){
  if(mutate&&!p.isOwner)throw new AccessError('只有系统所有者可创建项目');
 }else{if(typeof project!=='string')throw new AccessError('缺少项目',400);const g=grantFor(p,project);assertPermission(g,'read');
 if(mutate){
  if(path==='/api/state'){const row=await env.DB.prepare('SELECT payload FROM project_state WHERE id=?').bind(p.ownerId+':'+project).first();const before=row?JSON.parse(row.payload):null;if(isInternal(p.workspace.data,project)&&b.data?.records?.some((r:any)=>r.kind==='推广计划'&&JSON.stringify(r)!==JSON.stringify(before?.records?.find((old:any)=>old.id===r.id))))throw new AccessError('内部项目不新增或修改推广计划');if(g.role!=='owner'&&!allowed(g,'record.all')&&b.data){b.data.history=before?.history;assertRecords(g,before,b.data);const changed=(b.data.records||[]).filter((r:any)=>JSON.stringify(r)!==JSON.stringify(before?.records?.find((old:any)=>old.id===r.id)));b.data.history=[...changed.map((r:any)=>({time:new Date().toISOString(),id:r.id,title:r.title,status:r.status,version:r.version,actor:p.uid})),...(b.data.history||[])].slice(0,200);}else assertRecords(g,before,b.data);}
  else if(path==='/api/architecture')assertPermission(g,'architecture');
  else if(path==='/api/autonomy'){
   const permissions:any={config:'autonomy.config',start:'autonomy.config',stop:'autonomy.stop',experiment:'experiment',evaluate:'review',rule:'rule',intervention:'experiment'};assertPermission(g,permissions[b.action]||'owner.only');
   if(b.action==='config'){withinBudget(g,b.budgetLimit);if(isInternal(p.workspace.data,project)&&b.config?.autoPublish)throw new AccessError('内部项目不启用推广发布');}
   if(p.workspace.data.emergencyStop&&b.action==='start')throw new AccessError('系统所有者已启动全局紧急停止');
  }else if(path==='/api/agent'){
   if(b.action==='settings')assertPermission(g,'agent.settings');
   else if(b.action==='memory')assertPermission(g,'experiment');
   else if(b.action==='check')assertPermission(g,'agent.execute');
   else if(b.action==='create'){assertPermission(g,'agent.plan');withinBudget(g,b.budget);if(!['analysis','plan'].includes(b.scope)){assertPermission(g,'agent.execute');assertPermission(g,'execution.tech');}}
   else {const row=await env.DB.prepare('SELECT payload FROM agent_state WHERE id=?').bind(p.ownerId+':'+project).first();const run=row?JSON.parse(row.payload).runs.find((r:any)=>r.id===b.runId):null;if(!run)throw new AccessError('运行不存在',400);const task=run.tasks.find((t:any)=>!['completed','manual'].includes(t.status));if(isInternal(p.workspace.data,project)&&task?.capabilities?.includes('marketing'))throw new AccessError('内部项目旧推广计划需重建为内部流程');
    if(['pause','cancel','reject'].includes(b.action)){if(!allowed(g,'agent.execute')&&!allowed(g,'agent.plan'))throw new AccessError('无权控制此运行');}
    else {assertPermission(g,['analysis','plan'].includes(run.scope)?'agent.plan':'agent.execute');withinBudget(g,run.budget);if(p.workspace.data.emergencyStop)throw new AccessError('系统所有者已启动全局紧急停止');
     if(task?.capabilities?.some((c:string)=>['repository','ci','preview'].includes(c)))assertPermission(g,'execution.tech');if(task?.capabilities?.some((c:string)=>['deploy','cdn','rollback'].includes(c)))assertPermission(g,'release.approve');if(task?.capabilities?.includes('marketing'))assertPermission(g,'growth.approve');}
   }
  }else throw new AccessError('不支持的受保护接口');
 }
 }
 if(mutate)auditId=await auditStart(env.DB,actor,project||'*',req.method+' '+path+' '+String(b.action||'save').slice(0,60));
 // Existing storage stays under the immutable owner namespace; actor identity remains in audit.
 const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id',p.ownerId);const next=new Request(req.url,{method:req.method,headers,...(mutate?{body:JSON.stringify(b)}:{})});let response=await handler(next);
 if(path==='/api/projects'&&!mutate&&!p.isOwner&&response.ok){const data:any=await response.json();const assigned=new Set(p.member.grants.map((g:any)=>g.project));response=Response.json({...data,projects:data.projects.filter((x:any)=>assigned.has(x.id))});}
 if(auditId)await auditEnd(env.DB,auditId,response.ok?'succeeded':'rejected:'+response.status);
 return new Response(response.body,{status:response.status,headers:new Headers({...Object.fromEntries(response.headers),'Cache-Control':'private,no-store'})});
 }catch(e:any){if(!auditId&&actor&&!['GET','HEAD'].includes(req.method))try{auditId=await auditStart(env.DB,actor,auditProject,req.method+' '+new URL(req.url).pathname+' denied')}catch{}if(auditId)try{await auditEnd(env.DB,auditId,e instanceof AccessError?'denied:'+e.status:'failed_or_unknown')}catch{}return denied(e);}}
export async function serviceAllowed(req:Request,env:any){const provided=req.headers.get('x-xlloop-service-key')||'';const expected=env.XLLOOP_SERVICE_KEY||'';if(!expected||provided.length!==expected.length)throw new AccessError('后台服务身份无效');let diff=0;for(let i=0;i<expected.length;i++)diff|=provided.charCodeAt(i)^expected.charCodeAt(i);if(diff)throw new AccessError('后台服务身份无效');const w=await workspace(env.DB);return {stopped:w?.data.emergencyStop===true};}
