import {env} from '../../../../lib/runtime/env';
import {authenticatedUser} from '../../../../lib/auth/session';
import {denied} from '../../../../lib/access/guard';

export async function GET(req:Request){try{return Response.json({user:await authenticatedUser(req,env)},{headers:{'Cache-Control':'no-store'}});}catch(e){return denied(e);}}
