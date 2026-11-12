import {AccessError,allowed} from '../access/core';
import {profile,personActive,scopedMembers} from '../organization/core';
import {totals} from '../governance/store';
export function policy(input:any,cap:number,internal=false){if(!input||input.enabled!==true)return {enabled:false};const perJob=Number(input.perJob);if(!['analysis','development'].includes(input.scope)||!Number.isFinite(perJob)||perJob<=0||perJob>100||perJob>cap)throw new AccessError('自动执行范围或单轮额度无效，需为0–100 USD且不超过批准预算',400);return {enabled:true,scope:input.scope,perJob,growth:!internal&&input.scope==='development'&&input.growth==='approval'?'approval':'disabled',release:'approval'};}
export function readiness(w:any,o:any,settings:any,connection:any,inFlight=false){const p=profile(w.data,o.projectId),members=scopedMembers(w.data,o.projectId),technical=o.launch?.scope==='development';const missing:any[]=[];const add=(id:string,title:string,who:string)=>missing.push({id,title,who});
 if(w.data.emergencyStop)add('global','解除集团全局停止','集团负责人');
 if(o.deadline&&o.deadline<new Date().toISOString().slice(0,10))add('deadline','立项期限已过，需重新审批','集团负责人');
 if(!p.businessOwner||!personActive(w.data,p.businessOwner))add('business','指定有效的业务负责人','集团负责人');
 if(!p.team)add('team','指定负责开发组','集团负责人');
 if(!members.some((m:any)=>m.grants.some((g:any)=>g.project===o.projectId&&allowed(g,'record.product'))))add('product','为开发组或项目指定产品人员','集团负责人');
 if(technical&&!members.some((m:any)=>m.grants.some((g:any)=>g.project===o.projectId&&allowed(g,'execution.tech'))))add('engineer','指定全栈工程师 / 测试复核人','集团负责人');
 if(technical&&!members.some((m:any)=>m.grants.some((g:any)=>g.project===o.projectId&&allowed(g,'release.approve'))))add('release','指定发布与运维人员','集团负责人');
 if(technical&&!members.some((m:any)=>m.grants.some((g:any)=>g.project===o.projectId&&allowed(g,'release.approve')&&g.budgetLimit>=Math.min(o.launch.perJob,o.cap))))add('releaseBudget','给发布审批人分配足够的单次执行额度','集团负责人');
 if(technical&&p.type==='internal'&&(!p.acceptor||!personActive(w.data,p.acceptor)))add('acceptor','指定内部系统使用者验收人','集团负责人');
 for(const [key,title] of [...(technical?[['repo','代码仓库'],['environment','隔离开发与目标部署环境'],['cdn','CDN验证范围']]:[]),...(o.launch?.growth==='approval'?[['channels','准确推广账号和允许范围']]:[])])if(!String(settings[key]||'').trim())add(key,'配置'+title,'产品 / 技术负责人');
 if(!connection.connected)add('runner','接通已授权的执行器','共享运维');else {const required=['model',...(String(settings.analytics||'').trim()?['analytics']:[]),...(technical?['repository','ci','preview','deploy','cdn']:[]),...(o.launch?.growth==='approval'?['marketing']:[])];const absent=required.filter(c=>!connection.capabilities.includes(c));if(absent.length)add('capabilities','执行器补齐能力：'+absent.join('、'),'共享运维');}
 if(totals(w.data.governance,o.projectId).available<=0&&!inFlight)add('budget','补充可用的项目累计预算','有权预算审批人');return missing;
}
