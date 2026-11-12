import {assertInternalDispatch} from '../organization/delivery';
import {reserve,settle} from '../governance/store';
function repositoryError(message:string){
 if(message==='Remote working branch already exists; configure a new xlloop/* branch before publishing again')return 'GitLab 已存在当前工作分支。系统为避免覆盖或重复推送已停止操作；请先确认该远程分支，后续交付需配置新的 xlloop/* 工作分支并重新同步仓库。';
 if(message==='Remote working branch has changes that are not in the local checkout; synchronize or use a new xlloop/* branch')return 'GitLab 工作分支包含本地没有的提交，不能安全推送。请先同步并核对远程改动，或配置新的 xlloop/* 工作分支。';
 if(message==='Working branch is neither based on the configured remote base nor a safe continuation of the remote working branch')return '当前工作分支既不基于最新的 master/main，也不能确认是远程工作分支的安全延续。请同步并核对分支，或配置新的 xlloop/* 工作分支。';
 if(message==='Working branch is not based on the configured remote base branch')return '当前工作分支不是从配置的最新 master/main 创建，不能安全推送。请同步并核对基准分支。';
 return message;
}
export async function runner(env:any,path:string,body?:any){
 if(!env.XLLOOP_RUNNER_URL||!env.XLLOOP_RUNNER_TOKEN)throw Error('尚未连接 Agent 执行器；请配置服务端 XLLOOP_RUNNER_URL 与 XLLOOP_RUNNER_TOKEN');
 const base=new URL(env.XLLOOP_RUNNER_URL),loopback=['127.0.0.1','[::1]','localhost'].includes(base.hostname),secure=base.protocol==='https:'||(base.protocol==='http:'&&loopback);if(!secure||base.username||base.password||base.search||base.hash)throw Error('执行器必须使用无查询参数的 HTTPS 地址；仅本机回环地址允许 HTTP');
 const url=new URL(base.toString().replace(/\/$/,'')+path);
 if(body&&path==='/v1/jobs'){try{await assertInternalDispatch(env,body);await reserve(env,body);}catch(e:any){e.budgetDenied=true;throw e;}}
 const timeout=path.startsWith('/v1/repositories')?300000:12000;
 const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.XLLOOP_RUNNER_TOKEN,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(timeout),redirect:'error'});
 const raw=await r.text();if(raw.length>30000)throw Error('执行器响应超过大小限制');let result:any;try{result=JSON.parse(raw)}catch{throw Error('执行器返回了无效响应')}if(!r.ok)throw Error(path.startsWith('/v1/repositories')&&typeof result?.error==='string'?repositoryError(result.error):'执行器 HTTP '+r.status+'；不要在状态不明时重复派发');const jobId=body?.id||(path.startsWith('/v1/jobs/')?decodeURIComponent(path.slice('/v1/jobs/'.length)):null);if(jobId)await settle(env,jobId,result);return result;
}
export async function capabilities(env:any,project:string){if(!env.XLLOOP_RUNNER_URL||!env.XLLOOP_RUNNER_TOKEN)return {connected:false,capabilities:[],message:'未配置执行器服务端连接',checkedAt:new Date().toISOString()};try{const r=await runner(env,'/v1/capabilities?project='+encodeURIComponent(project));if(!Array.isArray(r.capabilities)||r.capabilities.some((x:any)=>typeof x!=='string'))throw Error('能力声明格式不正确');return {connected:true,capabilities:r.capabilities,message:'已验证执行器连通性；具体业务授权由每次任务校验',checkedAt:new Date().toISOString()};}catch(e:any){return {connected:false,capabilities:[],message:e.message,checkedAt:new Date().toISOString()}}}
