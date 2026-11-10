export const roles:any={
 regional_ceo:{name:'区域CEO',permissions:['read','audit','budget.request']},
 business:{name:'业务负责人',permissions:['budget.request','read','record.product','agent.plan','experiment','review','audit']},
 acceptor:{name:'使用者验收',permissions:['read','acceptance.approve']},
 manager:{name:'项目负责人',permissions:['budget.request','read','project.manage','record.all','agent.plan','agent.execute','execution.tech','agent.settings','release.approve','growth.approve','autonomy.config','autonomy.stop','experiment','review','rule','audit']},
 product:{name:'产品',permissions:['read','record.product','agent.plan','experiment','review']},
 developer:{name:'全栈开发 / 测试复核',permissions:['read','agent.plan','record.tech','agent.execute','execution.tech','architecture']},
 release:{name:'发布与运维',permissions:['read','record.tech','agent.execute','execution.tech','release.approve','architecture','autonomy.stop']},
 operations:{name:'运营与增长',permissions:['budget.request','read','record.operations','agent.plan','agent.execute','growth.approve','experiment']},
 finance:{name:'财务与审计',permissions:['read','audit']},
 viewer:{name:'只读成员',permissions:['read']}
};
export class AccessError extends Error{status:number;constructor(message:string,status=403){super(message);this.status=status;}}
export const email=(v:any)=>typeof v==='string'?v.trim().toLowerCase():'';
export function roleNames(grant:any):string[]{return Array.isArray(grant?.roles)?grant.roles:grant?.role?[grant.role]:[];}
export function hasRole(grant:any,role:string){return roleNames(grant).includes(role);}
export function allowed(grant:any,permission:string){return !!grant&&(grant.role==='owner'||roleNames(grant).some(r=>roles[r]?.permissions.includes(permission)));}
export function assertPermission(grant:any,p:string){if(!allowed(grant,p))throw new AccessError('当前岗位没有此操作权限：'+p);}
export function activeMember(m:any,now=Date.now()){return !!m&&m.enabled===true&&(!m.expires||Date.parse(m.expires)>now);}
export function grantFor(principal:any,project:string){if(principal.isOwner)return {role:'owner',budgetLimit:100000};const g=principal.member?.grants.find((g:any)=>g.project===project);if(!g)throw new AccessError('未获此项目授权');return g;}
export function withinBudget(g:any,amount:number){if(g.role==='owner')return;if(!Number.isFinite(amount)||amount<0||amount>g.budgetLimit)throw new AccessError('金额超出该成员的单次预算授权');}
export function kindPermission(kind:string){if(['用户问题池','产品需求','效果反馈','复盘看板'].includes(kind))return 'record.product';if(['开发任务','代码检查','发布记录'].includes(kind))return 'record.tech';if(['推广计划','数据指标'].includes(kind))return 'record.operations';return 'record.all';}
export function assertRecords(g:any,old:any,next:any){if(g.role==='owner'||allowed(g,'record.all'))return;if(!['record.product','record.tech','record.operations'].some(p=>allowed(g,p)))throw new AccessError('只读岗位不能保存项目事项');if(JSON.stringify(old?.config??{})!==JSON.stringify(next?.config??{}))throw new AccessError('只有项目负责人可调整项目目标与配置');if(!Array.isArray(next?.records))throw new AccessError('数据无效',400);const before=new Map((old?.records||[]).map((x:any)=>[x.id,x]));const after=new Map(next.records.map((x:any)=>[x.id,x]));for(const id of new Set([...before.keys(),...after.keys()])){const a:any=before.get(id),b:any=after.get(id);if(JSON.stringify(a)!==JSON.stringify(b)){if(a)assertPermission(g,kindPermission(a.kind));if(b)assertPermission(g,kindPermission(b.kind));}}for(const k of new Set([...Object.keys(old||{}),...Object.keys(next||{})]))if(!['records','config'].includes(k)&&JSON.stringify(old?.[k])!==JSON.stringify(next?.[k]))throw new AccessError('无权修改项目扩展配置');}
export function normalizeMember(b:any,ownerEmail:string){
 const e=email(b.email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)||e===email(ownerEmail))throw new AccessError('成员邮箱无效，不能修改系统所有者',400);
 if(!Array.isArray(b.grants)||b.grants.length>100)throw new AccessError('项目授权无效',400);const seen=new Set();const grants=b.grants.map((g:any)=>{const rs=roleNames(g);if(typeof g.project!=='string'||seen.has(g.project)||!rs.length||new Set(rs).size!==rs.length||rs.some((r:string)=>!Object.hasOwn(roles,r)||r==='regional_ceo')||typeof g.budgetLimit!=='number'||!Number.isFinite(g.budgetLimit)||g.budgetLimit<0||g.budgetLimit>100000)throw new AccessError('项目、岗位或预算额度无效',400);seen.add(g.project);return {project:g.project,roles:rs,role:rs[0],budgetLimit:g.budgetLimit};});
 const executionBudgetLimit=Number(b.executionBudgetLimit||0);if(!Number.isFinite(executionBudgetLimit)||executionBudgetLimit<0||executionBudgetLimit>100000)throw new AccessError('执行额度无效',400);
 const teams=(Array.isArray(b.teams)?b.teams:[]).map((t:any)=>{if(!['dev1','dev2','dev3'].includes(t.team)||!Array.isArray(t.roles)||!t.roles.length||t.roles.some((r:any)=>!['product','developer'].includes(r)))throw new AccessError('开发组或职责无效',400);return {team:t.team,roles:[...new Set(t.roles)]};});if(new Set(teams.map((t:any)=>t.team)).size!==teams.length)throw new AccessError('开发组重复',400);
 const regions=(Array.isArray(b.regions)?b.regions:[]).map((r:any)=>{if(typeof r.region!=='string'||!r.region||![r.projectLimit,r.regionLimit].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=100000))throw new AccessError('区域预算授权无效',400);return {region:r.region,canApprove:r.canApprove===true,canInitiate:r.canInitiate===true,projectLimit:r.projectLimit,regionLimit:r.regionLimit};});if(new Set(regions.map((r:any)=>r.region)).size!==regions.length)throw new AccessError('区域授权重复',400);
 const expires=typeof b.expires==='string'&&b.expires?new Date(b.expires).toISOString():'';if(expires&&Date.parse(expires)<=Date.now())throw new AccessError('授权到期时间必须晚于当前时间',400);
 return {email:e,name:String(b.name||'').trim().slice(0,100),enabled:b.enabled===true,expires,grants,teams,regions,sharedOps:b.sharedOps===true,executionBudgetLimit};
}
