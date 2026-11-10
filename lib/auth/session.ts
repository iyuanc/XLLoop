import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {email as normalizeEmail,AccessError} from '../access/core';

export const SESSION_COOKIE='__Host-xlloop_session';
const DEFAULT_HOURS=8;

export type AuthUser={id:string;email:string;name:string;mustChangePassword:boolean};

function cookieValue(req:Request,name:string){
  const raw=req.headers.get('cookie')||'';
  for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name)try{return decodeURIComponent(part.slice(i+1).trim());}catch{return '';}}
  return '';
}

function tokenHash(value:string){return createHash('sha256').update(value).digest('hex');}
function sameHex(a:string,b:string){try{const aa=Buffer.from(a,'hex'),bb=Buffer.from(b,'hex');return aa.length===32&&bb.length===32&&timingSafeEqual(aa,bb);}catch{return false;}}
function sessionHours(env:any){const value=Number(env.XLLOOP_SESSION_HOURS||DEFAULT_HOURS);return Number.isFinite(value)&&value>=1&&value<=168?value:DEFAULT_HOURS;}
export function requestIp(req:Request){return (req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'').trim().slice(0,64);}
export function requestAgent(req:Request){return (req.headers.get('user-agent')||'').slice(0,500);}

export async function auditAuth(db:any,userId:string|null,email:string,action:string,outcome:string,req?:Request){
  await db.prepare('INSERT INTO auth_audit(id,user_id,email,action,outcome,ip,user_agent,at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(randomUUID(),userId,normalizeEmail(email),action,outcome,req?requestIp(req):'',req?requestAgent(req):'',new Date()).run();
}

export async function createSession(db:any,user:AuthUser,req?:Request,hours=DEFAULT_HOURS){
  const id=randomUUID(),verifier=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.now()+hours*3600000);
  await db.prepare('INSERT INTO auth_sessions(id,user_id,verifier_hash,expires_at,last_seen_at,created_at,user_agent,ip) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id,user.id,tokenHash(verifier),expiresAt,new Date(),new Date(),req?requestAgent(req):'',req?requestIp(req):'').run();
  return {token:id+'.'+verifier,expiresAt};
}

export function sessionCookie(token:string,expiresAt:Date){
  const maxAge=Math.max(0,Math.floor((expiresAt.getTime()-Date.now())/1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}
export function clearSessionCookie(){return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;}

export async function authenticatedUser(req:Request,env:any):Promise<AuthUser>{
  if(env.XLLOOP_TEST_TRUST_IDENTITY_HEADERS===true){
    const id=req.headers.get('oai-authenticated-user-id'),em=normalizeEmail(req.headers.get('oai-authenticated-user-email'));
    if(id)return {id,email:em,name:em,mustChangePassword:false};
  }
  const token=cookieValue(req,SESSION_COOKIE),separator=token.indexOf('.');
  if(separator<1)throw new AccessError('请先登录',401);
  const id=token.slice(0,separator),verifier=token.slice(separator+1);
  if(!/^[a-f0-9-]{36}$/.test(id)||verifier.length<40)throw new AccessError('登录会话无效，请重新登录',401);
  const row=await env.DB.prepare('SELECT s.id,s.verifier_hash,s.expires_at,s.revoked_at,s.last_seen_at,u.id AS user_id,u.email,u.name,u.enabled,u.must_change_password FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.id=?').bind(id).first();
  if(!row||row.revoked_at||!row.enabled||new Date(row.expires_at).getTime()<=Date.now()||!sameHex(tokenHash(verifier),String(row.verifier_hash||'')))throw new AccessError('登录会话已失效，请重新登录',401);
  if(!row.last_seen_at||Date.now()-new Date(row.last_seen_at).getTime()>300000)await env.DB.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE id=?').bind(new Date(),id).run();
  return {id:String(row.user_id),email:normalizeEmail(row.email),name:String(row.name||row.email),mustChangePassword:!!row.must_change_password};
}

export async function revokeRequestSession(req:Request,db:any){
  const token=cookieValue(req,SESSION_COOKIE),id=token.split('.')[0];
  if(/^[a-f0-9-]{36}$/.test(id))await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(new Date(),id).run();
}

export async function issueSession(env:any,user:AuthUser,req?:Request){return createSession(env.DB,user,req,sessionHours(env));}
