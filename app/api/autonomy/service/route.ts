import {reconcileLaunches} from '../../../../lib/launch/store';
import {triage as feedbackTriage} from '../../../../lib/feedback/triage';
import {discover} from '../../../../lib/governance/discovery';
import {GET as readProjects} from '../../projects/route';
import {GET as readProjectState} from '../../state/route';
import {workspace} from '../../../../lib/access/store';
import {serviceAllowed,denied} from '../../../../lib/access/guard';
import {auditStart,auditEnd} from '../../../../lib/access/store';
// This shared unattended writer relies on Sites' owner-private platform boundary.
// Callers must first verify get_site still confirms owner-only access, then use
// its OAI-Sites-Authorization service token only against this same Site.
// Do not make this Site public without replacing this boundary with scoped auth.
import {env} from 'cloudflare:workers';
import {readAuto} from '../../../../lib/autonomy/store';
import {tick} from '../../../../lib/autonomy/tick';
const response=(b:any,s=200)=>Response.json(b,{status:s,headers:{'Cache-Control':'private,no-store'}});
async function handleGET(){const rows=await env.DB!.prepare('SELECT payload FROM autonomy_state LIMIT 20').all<any>();return response({projects:rows.results.map(r=>{const s=JSON.parse(r.payload);return {project:s.project,enabled:s.enabled,lastHeartbeat:s.lastHeartbeat,ticks:s.ticks,spent:s.spent,reserved:s.reserved,budgetLimit:s.budgetLimit,pending:s.pending?.id,activeRun:s.activeRun?.id,connection:s.connection?.connected,lanes:Object.fromEntries(Object.entries(s.lanes).map(([k,v]:any)=>[k,v.status]))}})});}
async function handlePOST(req:Request){try{const b:any=await req.json();if(b.action!=='tick')return response({error:'Only tick is supported'},400);const startup=await reconcileLaunches(env);const rows=await env.DB!.prepare("SELECT id FROM autonomy_state ORDER BY COALESCE(json_extract(payload,'$.lastHeartbeat'),'') ASC LIMIT 5").all<any>();const projects=rows.results.length?rows.results.map(r=>r.id):['ybirds'];const results:any[]=[{startup}];try{results.push({feedbackTriage:await feedbackTriage(env)});}catch(e:any){results.push({feedbackTriage:'retry_next_heartbeat',message:e.message});}try{results.push({opportunityDiscovery:await discover(env)});}catch(e:any){results.push({opportunityDiscovery:'retry_next_heartbeat',message:e.message});}for(const p of projects){try{results.push(await tick(env,p,new URL(req.url).origin));}catch(e:any){results.push({project:p,status:'retry_next_heartbeat',error:e.message});}}return response({heartbeat:new Date().toISOString(),results});}catch(e:any){return response({error:e.message},400)}}

export async function GET(req:Request){try{await serviceAllowed(req,env);if(new URL(req.url).searchParams.get('health')==='permissions'){const w=await workspace(env.DB);if(!w)return response({ownerInitialized:false});const checks=[];for(const [path,handler] of [['/api/projects',readProjects],['/api/state?project=ybirds',readProjectState]] as const){const base=new Request(new URL(path,req.url),{headers:{'oai-authenticated-user-id':w.data.ownerId}});const adapted={url:base.url,method:base.method,headers:base.headers,clone:()=>base.clone(),text:()=>base.text()} as Request;const r=await handler(adapted);checks.push({path,status:r.status,requestAdapter:true});}return response({ownerInitialized:true,checks});}return handleGET();}catch(e){return denied(e);}}
export async function POST(req:Request){let id='';try{const state=await serviceAllowed(req,env);if(state.stopped)return response({status:'global_stopped'});id=await auditStart(env.DB,'service:autonomy','*','autonomy.tick');const result=await handlePOST(req);await auditEnd(env.DB,id,result.ok?'succeeded':'rejected');return result;}catch(e){if(id)try{await auditEnd(env.DB,id,'failed_or_unknown')}catch{}return denied(e);}}
