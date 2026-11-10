import {effectiveMember} from '../organization/core';
import {email,activeMember,AccessError} from './core';
import {authenticatedUser} from '../auth/session';
export async function workspace(db:any){const r=await db.prepare('SELECT payload,revision FROM workspace_access WHERE id=?').bind('main').first();return r?{data:JSON.parse(r.payload),revision:r.revision}:null;}
export async function saveWorkspace(db:any,data:any,revision:number){const r=revision===0?await db.prepare('INSERT OR IGNORE INTO workspace_access(id,payload,revision) VALUES (?,?,1)').bind('main',JSON.stringify(data)).run():await db.prepare('UPDATE workspace_access SET payload=?,revision=revision+1 WHERE id=? AND revision=?').bind(JSON.stringify(data),'main',revision).run();if(!r.meta.changes)throw new AccessError('权限配置已更新，请刷新后重试',409);return revision+1;}
export async function principal(req:Request,env:any){const auth=await authenticatedUser(req,env);const path=new URL(req.url).pathname;if(auth.mustChangePassword&&!(req.method==='GET'&&path==='/api/access'))throw new AccessError('首次登录必须先修改密码',428);const uid=auth.id,em=email(auth.email);let w=await workspace(env.DB);
 // Bootstrap is pinned to the configured owner email, never first-visitor wins.
 if(!w){if(!env.XLLOOP_OWNER_EMAIL||em!==email(env.XLLOOP_OWNER_EMAIL))throw new AccessError('请系统所有者先登录初始化权限');try{await saveWorkspace(env.DB,{ownerId:uid,ownerEmail:em,members:[],emergencyStop:false},0);}catch(e:any){if(e.status!==409)throw e;}w=await workspace(env.DB);}
 if(!w)throw new AccessError('权限初始化失败');const isOwner=uid===w.data.ownerId;if(isOwner)return {uid,email:em,name:auth.name,mustChangePassword:auth.mustChangePassword,isOwner:true,ownerId:w.data.ownerId,workspace:w,member:null};
 const m=w.data.members.find((m:any)=>m.userId?m.userId===uid:em&&m.email===em);if(!activeMember(m))throw new AccessError('未授权、已停用或授权已到期');
 if(!m.userId){m.userId=uid;await saveWorkspace(env.DB,w.data,w.revision);w=(await workspace(env.DB))!;}
 return {uid,email:em,name:auth.name,mustChangePassword:auth.mustChangePassword,isOwner:false,ownerId:w.data.ownerId,workspace:w,member:effectiveMember(m,w.data)};
}
export async function internalOwnerPrincipal(env:any,uid:string){const w=await workspace(env.DB);if(!w||!uid||uid!==w.data.ownerId)throw new AccessError('后台服务 owner 上下文无效',403);const em=email(w.data.ownerEmail);return {uid,email:em,name:em,mustChangePassword:false,isOwner:true,ownerId:uid,workspace:w,member:null};}
export async function auditStart(db:any,actor:string,project:string,action:string){const id=crypto.randomUUID();await db.prepare('INSERT INTO access_audit(id,actor,project,action,outcome,at) VALUES (?,?,?,?,?,?)').bind(id,actor,project,action,'attempted',new Date().toISOString()).run();return id;}
export async function auditEnd(db:any,id:string,outcome:string){await db.prepare('UPDATE access_audit SET outcome=? WHERE id=?').bind(outcome,id).run();}
