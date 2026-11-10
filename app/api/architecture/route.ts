import {guard} from '../../../lib/access/guard';
import {env} from 'cloudflare:workers';
import {validProject} from '../../../lib/agent/store';
import {defaults,normalize} from '../../../lib/architecture/core';
const reply=(b:any,status=200)=>Response.json(b,{status,headers:{'Cache-Control':'private, no-store'}});
async function identity(req:Request,project:any){const uid=req.headers.get('oai-authenticated-user-id');if(!uid)throw Error('AUTH');if(!await validProject(env.DB,uid,project))throw Error('项目不存在');return uid;}
async function read(uid:string,project:string){const row=await env.DB!.prepare('SELECT payload,revision FROM project_state WHERE id=?').bind(uid+':architecture:'+project).first<any>();return row?{data:JSON.parse(row.payload),revision:row.revision}:{data:defaults(),revision:0};}
function fail(e:any){return reply({error:e.message==='AUTH'?'请先登录':e.message},e.message==='AUTH'?401:400);}
async function handleGET(req:Request){try{const p=new URL(req.url).searchParams.get('project');const uid=await identity(req,p);return reply(await read(uid,p!));}catch(e){return fail(e);}}
async function handlePUT(req:Request){try{
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return reply({error:'跨站请求被拒绝'},403);
 if(Number(req.headers.get('content-length'))>20000)return reply({error:'配置过大'},413);
 const raw=await req.text();if(raw.length>20000)return reply({error:'配置过大'},413);const b=JSON.parse(raw);const uid=await identity(req,b.project);
 if(!Number.isInteger(b.revision)||b.revision<0)throw Error('版本无效');const next=normalize(b.data);const saved=await read(uid,b.project);if(saved.revision!==b.revision)return reply({error:'配置已更新，请刷新后重试'},409);
 const data={...next,history:[{at:new Date().toISOString(),message:'保存节点与模型路由规划；未改变执行器授权或运行策略'},...(saved.data.history||[])].slice(0,100)};const id=uid+':architecture:'+b.project;
 const result=b.revision===0?await env.DB!.prepare('INSERT OR IGNORE INTO project_state (id,payload,revision) VALUES (?,?,1)').bind(id,JSON.stringify(data)).run():await env.DB!.prepare('UPDATE project_state SET payload=?,revision=revision+1 WHERE id=? AND revision=?').bind(JSON.stringify(data),id,b.revision).run();
 if(!result.meta.changes)return reply({error:'配置已更新，请刷新后重试'},409);return reply({data,revision:b.revision+1});
 }catch(e){return fail(e);}}

export async function GET(req:Request){return guard(req,env,handleGET);}

export async function PUT(req:Request){return guard(req,env,handlePUT);}
