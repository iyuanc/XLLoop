import {AccessError,email as normalizeEmail} from '../access/core';
import {hashPassword,validatePassword,verifyPassword} from './password';
import {auditAuth,AuthUser,issueSession} from './session';

const MAX_FAILURES=5,LOCK_MINUTES=15;
const DUMMY_HASH='scrypt$131072$8$1$KioqKioqKioqKioqKioqKg$T6ViFBRcff4aSg4Mp_DpmAF2Qqd9DpSAHXXWSFAoA7CEzOFYm9bWM5N7tsWIUqd2ZWZUlfHF6PD-2Lkgd-zZow';
function user(row:any):AuthUser{return {id:String(row.id),email:normalizeEmail(row.email),name:String(row.name||row.email),mustChangePassword:!!row.must_change_password};}

export async function login(env:any,req:Request,rawEmail:unknown,password:unknown){
  const em=normalizeEmail(rawEmail);
  if(!em||typeof password!=='string')throw new AccessError('邮箱或密码错误',401);
  const row=await env.DB.prepare('SELECT id,email,name,password_hash,enabled,must_change_password,failed_attempts,locked_until FROM auth_users WHERE email=?').bind(em).first();
  const locked=!!row?.locked_until&&new Date(row.locked_until).getTime()>Date.now();
  // Keep an unknown email measurably similar to a known email without revealing account existence.
  const passwordMatches=await verifyPassword(password,row?.password_hash||DUMMY_HASH);
  const valid=!!row&&!locked&&row.enabled===1&&passwordMatches;
  if(!valid){
    if(row&&!locked){const failures=Number(row.failed_attempts||0)+1,until=failures>=MAX_FAILURES?new Date(Date.now()+LOCK_MINUTES*60000):null;await env.DB.prepare('UPDATE auth_users SET failed_attempts=?,locked_until=?,updated_at=? WHERE id=?').bind(failures>=MAX_FAILURES?0:failures,until,new Date(),row.id).run();}
    await auditAuth(env.DB,row?.id||null,em,'login','failed',req);
    throw new AccessError('邮箱或密码错误',401);
  }
  await env.DB.prepare('UPDATE auth_users SET failed_attempts=0,locked_until=NULL,last_login_at=?,updated_at=? WHERE id=?').bind(new Date(),new Date(),row.id).run();
  const current=user(row),session=await issueSession(env,current,req);await auditAuth(env.DB,current.id,current.email,'login','succeeded',req);
  return {user:current,...session};
}

export async function changePassword(env:any,req:Request,current:AuthUser,currentPassword:unknown,nextPassword:unknown){
  try{validatePassword(nextPassword);}catch(e){throw new AccessError(e instanceof Error?e.message:'新密码无效',400);}
  if(currentPassword===nextPassword)throw new AccessError('新密码不能与当前密码相同',400);
  const row=await env.DB.prepare('SELECT password_hash FROM auth_users WHERE id=? AND enabled=1').bind(current.id).first();
  if(!row||!await verifyPassword(currentPassword,row.password_hash)){await auditAuth(env.DB,current.id,current.email,'password.change','failed',req);throw new AccessError('当前密码错误',401);}
  const passwordHash=await hashPassword(nextPassword as string);
  await env.DB.prepare('UPDATE auth_users SET password_hash=?,must_change_password=0,failed_attempts=0,locked_until=NULL,password_changed_at=?,updated_at=? WHERE id=?').bind(passwordHash,new Date(),new Date(),current.id).run();
  await env.DB.prepare('UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(new Date(),current.id).run();
  const updated={...current,mustChangePassword:false},session=await issueSession(env,updated,req);await auditAuth(env.DB,current.id,current.email,'password.change','succeeded',req);
  return {user:updated,...session};
}
