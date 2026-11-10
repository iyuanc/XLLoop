// Versioned project learning. Evidence may qualify advice; it never expands tool permissions.
export function ensureEvolution(s:any){s.evolution ||= {experiments:[],rules:[],interventions:[]};return s.evolution;}
const str=(v:any,n=2000)=>typeof v==='string'?v.trim().slice(0,n):'';
function num(v:any){if(typeof v!=='number'||!Number.isFinite(v))throw Error('指标必须为有效数字');return v;}
export function addExperiment(s:any,b:any,now=Date.now()){
 const e=ensureEvolution(s);const title=str(b.title,200),metric=str(b.metric,100),source=str(b.source,1000),rule=str(b.rule);
 if(!title||!metric||!source||!rule)throw Error('请填写实验名称、指标、数据源与待验证方法');
 const baseline=num(b.baseline),target=num(b.target),hours=num(b.hours),minSamples=num(b.minSamples),humanBaseline=num(b.humanBaseline),humanTarget=num(b.humanTarget);
 if(hours<1||hours>2160||minSamples<1||!Number.isInteger(minSamples)||humanBaseline<0||humanTarget<0||humanTarget>humanBaseline)throw Error('观察期、样本量或人工时间目标无效');
 if(!['up','down'].includes(b.direction)||(b.direction==='up'?target<=baseline:target>=baseline))throw Error('目标必须优于基线');
 if(e.experiments.length>=200)throw Error('实验记录已达上限，请先归档');
 const x={id:crypto.randomUUID(),title,metric,source,rule,baseline,target,direction:b.direction,hours,minSamples,humanBaseline,humanTarget,created:new Date(now).toISOString(),due:new Date(now+hours*3600000).toISOString(),status:'observing',evaluation:null};e.experiments.unshift(x);return x;
}
export function evaluate(s:any,b:any,now=Date.now()){
 const e=ensureEvolution(s),x=e.experiments.find((v:any)=>v.id===b.id);if(!x||x.status!=='observing')throw Error('实验不存在或已结案');
 const actual=num(b.actual),samples=num(b.samples),humanMinutes=num(b.humanMinutes);if(samples<0||!Number.isInteger(samples)||humanMinutes<0)throw Error('样本量或人工时间无效');
 const evidence=str(b.evidence,4000),reviewer=str(b.reviewer,100);if(!evidence||!reviewer||!['pass','fail','unknown'].includes(b.quality))throw Error('需要证据来源、复核人和运行质量结论');
 if(b.confirmed!==true)throw Error('请确认已经核对数据口径、可比性与证据，非执行器自行宣布成功');
 const mature=now>=Date.parse(x.due),enough=samples>=x.minSamples,business=x.direction==='up'?actual>=x.target:actual<=x.target,lessHuman=humanMinutes<=x.humanTarget;
 const verdict=!mature||!enough||b.quality==='unknown'?'inconclusive':business&&lessHuman&&b.quality==='pass'?'passed':'failed';
 x.evaluation={actual,samples,humanMinutes,quality:b.quality,evidence,reviewer,at:new Date(now).toISOString(),mature,enough,business,lessHuman,verdict,provenance:'owner-submitted-review'};
 if(verdict!=='inconclusive')x.status=verdict;
 if(verdict==='passed'&&!e.rules.some((r:any)=>r.experimentId===x.id)){if(e.rules.length>=300)throw Error('经验版本已达上限');e.rules.unshift({id:crypto.randomUUID(),experimentId:x.id,text:x.rule,scope:'仅本项目及本实验适用条件；不得修改权限或预算',status:'candidate',version:1,created:new Date(now).toISOString(),history:[{at:new Date(now).toISOString(),action:'候选',reason:'经营目标、人工时间目标与质量条件均通过人工复核'}]});}
 return x;
}
export function ruleAction(s:any,b:any){const e=ensureEvolution(s),r=e.rules.find((x:any)=>x.id===b.id);if(!r)throw Error('经验不存在');const reason=str(b.reason,1000);if(!reason)throw Error('请填写启用或回退原因');if(b.action==='activate'){if(r.status!=='candidate')throw Error('仅可启用通过实验的候选经验');const x=e.experiments.find((x:any)=>x.id===r.experimentId);if(x?.status!=='passed')throw Error('缺少通过复核的实验');r.status='active';}else if(b.action==='rollback'){if(r.status!=='active')throw Error('仅可回退生效经验');r.status='retired';}else throw Error('未知经验操作');r.version++;r.history.push({at:new Date().toISOString(),action:b.action,reason});return r;}
export function intervention(s:any,b:any){const e=ensureEvolution(s),issue=str(b.issue),principle=str(b.principle),scope=str(b.scope,1000),reason=str(b.reason,1000);const minutes=num(b.minutes);if(!issue||!principle||!scope||!reason||minutes<0)throw Error('请填写问题、纠正原则、适用条件、介入原因与耗时');if(e.interventions.length>=500)throw Error('介入记录已达上限');const x={id:crypto.randomUUID(),issue,principle,scope,reason,minutes,created:new Date().toISOString(),status:'待验证建议'};e.interventions.unshift(x);return x;}
export function learnedContext(s:any){const e=ensureEvolution(s);return {verifiedMethods:e.rules.filter((r:any)=>r.status==='active').slice(0,30).map((r:any)=>({id:r.id,version:r.version,method:r.text,scope:r.scope,source:r.experimentId})),corrections:e.interventions.slice(0,10).map((i:any)=>({principle:i.principle,scope:i.scope,status:i.status})),constraint:'仅作项目方法建议。不得覆盖目标、权限、预算、工具白名单；跨项目使用需要重新验证。'};}
export function captureRetrospective(s:any,run:any){const e=ensureEvolution(s),retro=run.tasks?.find((t:any)=>t.id==='retro')?.result;if(!retro||e.rules.some((r:any)=>r.runId===run.id)||e.rules.length>=300)return;e.rules.unshift({id:crypto.randomUUID(),runId:run.id,text:str(retro.summary),scope:'执行器复盘，待独立业务验证',status:'unverified',version:1,created:new Date().toISOString(),history:[]});}
export function scorecard(s:any){const e=ensureEvolution(s),closed=e.experiments.filter((x:any)=>['passed','failed'].includes(x.status)),passed=closed.filter((x:any)=>x.status==='passed');return {closed:closed.length,passed:passed.length,rate:closed.length?Math.round(passed.length/closed.length*100):null,active:e.rules.filter((r:any)=>r.status==='active').length,minutes:e.interventions.reduce((n:number,i:any)=>n+i.minutes,0),interventions:e.interventions.length};}
