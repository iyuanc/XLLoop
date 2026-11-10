import {env} from '../../../../lib/runtime/env';
import {clearSessionCookie,revokeRequestSession} from '../../../../lib/auth/session';
import {AccessError} from '../../../../lib/access/core';
import {denied} from '../../../../lib/access/guard';
import {isSameOrigin} from '../../../../lib/http/origin';

export async function POST(req:Request){
  try{
    if(!isSameOrigin(req))throw new AccessError('跨站请求被拒绝',403);
    await revokeRequestSession(req,env.DB);
    return Response.json({ok:true},{headers:{'Cache-Control':'no-store','Clear-Site-Data':'"cache", "cookies", "storage"','Set-Cookie':clearSessionCookie()}});
  }catch(e){return denied(e);}
}
