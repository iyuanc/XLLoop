import {guard} from '../../../lib/access/guard';
import { env } from 'cloudflare:workers';
import {validProject as validProjectId} from '../../../lib/agent/store';
const validProject=(uid:string,id:any)=>validProjectId(env.DB,uid,id);
function invalid(data:any):string|null{
 if(!Array.isArray(data?.records)||data.records.length>1000||JSON.stringify(data).length>500000)return '数据无效或过大';
 const map=new Map<string,any>();
 for(const r of data.records){if(!r||typeof r.id!=='string'||!r.id||map.has(r.id)||typeof r.title!=='string'||!r.title.trim()||typeof r.owner!=='string'||!r.owner.trim()||!['待处理','进行中','阻塞','已完成'].includes(r.status)||!['已验证事实','待验证','假设','风险'].includes(r.signal))return '事项字段无效';map.set(r.id,r);if(r.signal==='已验证事实'&&!r.evidence?.trim())return '已验证事实必须附证据';if(r.kind==='发布记录'&&r.status==='已完成'&&!r.evidence?.trim())return '完成发布必须附证据';}
 for(const r of data.records){let id=r.dependency;const visited=new Set([r.id]);while(id){if(visited.has(id))return '任务依赖不能形成循环';visited.add(id);const dep=map.get(id);if(!dep)return '依赖事项不存在';id=dep.dependency;}if(r.status==='已完成'&&r.dependency&&map.get(r.dependency)?.status!=='已完成')return '前置任务尚未完成';}
 return null;
}
async function handleGET(req:Request){
 const uid=req.headers.get('oai-authenticated-user-id');if(!uid)return Response.json({error:'请先登录'},{status:401});
 const project=new URL(req.url).searchParams.get('project');if(!project||!await validProject(uid,project))return Response.json({error:'项目不存在'},{status:400});
 const row=await env.DB!.prepare('SELECT payload, revision FROM project_state WHERE id = ?').bind(uid+':'+project).first<any>();
 return Response.json(row?{data:JSON.parse(row.payload),revision:row.revision}:{data:null,revision:0});
}
async function handlePUT(req:Request){
 const uid=req.headers.get('oai-authenticated-user-id');if(!uid)return Response.json({error:'请先登录'},{status:401});
 let b:any;try{b=await req.json();}catch{return Response.json({error:'JSON 无效'},{status:400});}
 if(!await validProject(uid,b?.project)||!Number.isInteger(b.revision)||b.revision<0)return Response.json({error:'项目或版本无效'},{status:400});
 const error=invalid(b.data);if(error)return Response.json({error},{status:400});
 const id=uid+':'+b.project;
 const r=b.revision===0?await env.DB!.prepare('INSERT OR IGNORE INTO project_state (id,payload,revision) VALUES (?,?,1)').bind(id,JSON.stringify(b.data)).run():await env.DB!.prepare('UPDATE project_state SET payload=?, revision=revision+1 WHERE id=? AND revision=?').bind(JSON.stringify(b.data),id,b.revision).run();
 if(!r.meta.changes)return Response.json({error:'数据已在其它窗口更新，请刷新后重试'},{status:409});
 return Response.json({revision:b.revision+1});
}

export async function GET(req:Request){return guard(req,env,handleGET);}

export async function PUT(req:Request){return guard(req,env,handlePUT);}
