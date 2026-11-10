import {env} from '../../../../lib/runtime/env';
import {changePassword} from '../../../../lib/auth/service';
import {authenticatedUser,sessionCookie} from '../../../../lib/auth/session';
import {AccessError} from '../../../../lib/access/core';
import {denied} from '../../../../lib/access/guard';
import {isSameOrigin} from '../../../../lib/http/origin';

export async function POST(req:Request){
  try{
    if(!isSameOrigin(req))throw new AccessError('跨站请求被拒绝',403);
    const current=await authenticatedUser(req,env),raw=await req.text();if(raw.length>4096)throw new AccessError('请求过大',413);
    let body:any;try{body=JSON.parse(raw);}catch{throw new AccessError('请求无效',400);}
    const result=await changePassword(env,req,current,body.currentPassword,body.newPassword);
    return Response.json({user:result.user},{headers:{'Cache-Control':'no-store','Set-Cookie':sessionCookie(result.token,result.expiresAt)}});
  }catch(e){return denied(e);}
}
