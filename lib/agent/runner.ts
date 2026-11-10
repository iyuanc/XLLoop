import {assertInternalDispatch} from '../organization/delivery';
import {reserve,settle} from '../governance/store';
export async function runner(env:any,path:string,body?:any){
 if(!env.XLLOOP_RUNNER_URL||!env.XLLOOP_RUNNER_TOKEN)throw Error('尚未连接 Agent 执行器；请配置服务端 XLLOOP_RUNNER_URL 与 XLLOOP_RUNNER_TOKEN');
 const base=new URL(env.XLLOOP_RUNNER_URL),loopback=['127.0.0.1','[::1]','localhost'].includes(base.hostname),secure=base.protocol==='https:'||(base.protocol==='http:'&&loopback);if(!secure||base.username||base.password||base.search||base.hash)throw Error('执行器必须使用无查询参数的 HTTPS 地址；仅本机回环地址允许 HTTP');
 const url=new URL(base.toString().replace(/\/$/,'')+path);
 if(body&&path==='/v1/jobs'){try{await assertInternalDispatch(env,body);await reserve(env,body);}catch(e:any){e.budgetDenied=true;throw e;}}
 const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.XLLOOP_RUNNER_TOKEN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000),redirect:'error'});
 if(!r.ok)throw Error('执行器 HTTP '+r.status+'；不要在状态不明时重复派发');const raw=await r.text();if(raw.length>30000)throw Error('执行器响应超过大小限制');const result=JSON.parse(raw);const jobId=body?.id||(path.startsWith('/v1/jobs/')?decodeURIComponent(path.slice('/v1/jobs/'.length)):null);if(jobId)await settle(env,jobId,result);return result;
}
export async function capabilities(env:any,project:string){if(!env.XLLOOP_RUNNER_URL||!env.XLLOOP_RUNNER_TOKEN)return {connected:false,capabilities:[],message:'未配置执行器服务端连接',checkedAt:new Date().toISOString()};try{const r=await runner(env,'/v1/capabilities?project='+encodeURIComponent(project));if(!Array.isArray(r.capabilities)||r.capabilities.some((x:any)=>typeof x!=='string'))throw Error('能力声明格式不正确');return {connected:true,capabilities:r.capabilities,message:'已验证执行器连通性；具体业务授权由每次任务校验',checkedAt:new Date().toISOString()};}catch(e:any){return {connected:false,capabilities:[],message:e.message,checkedAt:new Date().toISOString()}}}
