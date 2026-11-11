import {guard} from '../../../lib/access/guard';
import {isSameOrigin} from '../../../lib/http/origin';
import {env} from '../../../lib/runtime/env';
import {defaults,normalize} from '../../../lib/architecture/core';
import {read as readAgent,write as writeAgent} from '../../../lib/agent/store';
import {runner} from '../../../lib/agent/runner';

const reply=(body:any,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});

async function repositories(ownerId:string,project:string){
 const row=await env.DB!.prepare('SELECT payload FROM project_state WHERE id=?').bind(ownerId+':architecture:'+project).first<any>();
 const data=normalize(row?JSON.parse(row.payload):defaults());
 return data.repositories;
}

async function handleGET(req:Request){
 try{
  const project=new URL(req.url).searchParams.get('project')||'';
  const ownerId=req.headers.get('oai-authenticated-user-id')||'';
  const configured=await repositories(ownerId,project);
  try{return reply({configured,executor:await runner(env,'/v1/repositories?project='+encodeURIComponent(project))});}
  catch(e:any){return reply({configured,executor:null,message:e.message});}
 }catch(e:any){return reply({error:e.message},400);}
}

async function handlePOST(req:Request){
 try{
  if(!isSameOrigin(req))return reply({error:'跨站请求被拒绝'},403);
  const body=await req.json() as any;
  const project=String(body.project||'');
  const ownerId=req.headers.get('oai-authenticated-user-id')||'';
  if(body.action==='publish'){
   const result=await runner(env,'/v1/repositories/publish',{project,repositoryId:String(body.repositoryId||''),message:String(body.message||''),approved:body.approved===true});
   return reply(result);
  }
  const configured=await repositories(ownerId,project);
  if(!configured.length)throw Error('请先在技术配置中添加并保存至少一个代码仓库');
  const state=await readAgent(env.DB,ownerId,project);
  const settings=state.data.settings||{};
  const result=await runner(env,'/v1/repositories',{project,repositories:configured,settings:{environment:settings.environment||'',analytics:settings.analytics||'',cdn:settings.cdn||'',channels:settings.channels||''}});
  state.data.settings.repo=result.repo;
  await writeAgent(env.DB,ownerId,project,state.data,state.revision);
  return reply(result);
 }catch(e:any){return reply({error:e.message==='CONFLICT'?'项目配置正在更新，请刷新后重试':e.message},e.message==='CONFLICT'?409:400);}
}

export async function GET(req:Request){return guard(req,env,handleGET);}
export async function POST(req:Request){return guard(req,env,handlePOST);}
