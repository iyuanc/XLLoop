import {profile} from '../../../lib/organization/core';
import {workspace} from '../../../lib/access/store';
import {projects as approvedProjects} from '../../../lib/governance/store';
import {guard} from '../../../lib/access/guard';
import {env} from '../../../lib/runtime/env';
async function handleGET(req:Request){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)return Response.json({error:'请先登录'},{status:401});const prefix=uid+':project:';const rows=await env.DB!.prepare('SELECT payload FROM project_state WHERE substr(id,1,?) = ?').bind(prefix.length,prefix).all<any>();const w=await workspace(env.DB);return Response.json({projects:[...rows.results.map(r=>JSON.parse(r.payload)),...await approvedProjects(env.DB,uid)].map((v:any)=>({...v,profile:profile(w?.data||{},v.id)}))});}
async function handlePOST(req:Request){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)return Response.json({error:'请先登录'},{status:401});let b:any;try{b=await req.json();}catch{return Response.json({error:'数据无效'},{status:400});}if(typeof b.name!=='string'||!b.name.trim()||b.name.length>60||typeof b.desc!=='string'||b.desc.length>500)return Response.json({error:'请填写项目名称（60 字以内）和简介（500 字以内）'},{status:400});const p={id:'p-'+crypto.randomUUID(),name:b.name.trim(),desc:b.desc,en:'PROJECT',color:'#5470c6'};await env.DB!.prepare('INSERT INTO project_state (id,payload,revision) VALUES (?,?,1)').bind(uid+':project:'+p.id,JSON.stringify(p)).run();return Response.json({project:p});}

export async function GET(req:Request){return guard(req,env,handleGET);}

export async function internalGET(req:Request,ownerId:string){return guard(req,env,handleGET,{actor:'service:health',ownerId});}

export async function POST(req:Request){return guard(req,env,handlePOST);}
