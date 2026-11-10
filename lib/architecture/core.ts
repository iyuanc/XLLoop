export const agentRoles=['总控','数据与运营','产品','开发','审查与测试','发布','增长','效果'];
export function defaults(){return {nodes:[{id:'uk',name:'英国主控与海外执行节点',region:'UK',environment:'',owner:'',note:''},{id:'cn',name:'国内隔离执行节点',region:'CN',environment:'',owner:'',note:''}],routes:agentRoles.map(role=>({role,node:'uk',provider:'',model:'',fallback:'',dataScope:'仅所属区域',note:''})),history:[] as any[]};}
const text=(v:any,n:number)=>{if(typeof v!=='string'||v.length>n)throw Error('配置字段类型或长度无效');if(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|-----BEGIN .*PRIVATE KEY-----)/i.test(v))throw Error('请勿在配置中填写密钥或访问令牌');return v.trim();};
export function normalize(input:any){
 if(!input||!Array.isArray(input.nodes)||input.nodes.length!==2||!Array.isArray(input.routes)||input.routes.length!==agentRoles.length)throw Error('节点或 Agent 配置无效');
 const nodes=['uk','cn'].map(id=>{const list=input.nodes.filter((n:any)=>n?.id===id);if(list.length!==1)throw Error('节点标识重复或缺失');const n=list[0];if(n.region!==(id==='uk'?'UK':'CN'))throw Error('节点区域不可更改');return {id,name:text(n.name,100),region:n.region,environment:text(n.environment,150),owner:text(n.owner,100),note:text(n.note,500)};});
 const routes=agentRoles.map(role=>{const list=input.routes.filter((r:any)=>r?.role===role);if(list.length!==1)throw Error('Agent 角色重复或缺失');const r=list[0];if(!['uk','cn'].includes(r.node)||r.dataScope!=='仅所属区域')throw Error('节点或数据范围无效');return {role,node:r.node,provider:text(r.provider,100),model:text(r.model,100),fallback:text(r.fallback,100),dataScope:'仅所属区域',note:text(r.note,500)};});
 return {nodes,routes};
}
