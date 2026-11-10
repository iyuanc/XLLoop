function firstForwardedValue(value:string|null){
  return value?.split(',')[0]?.trim()||'';
}

/**
 * Resolve the browser-facing origin when Next.js runs behind a trusted local
 * reverse proxy. XLLoop binds Node.js to loopback, and Nginx overwrites these
 * forwarding headers before proxying the request.
 */
export function requestOrigin(req:Request){
  const proto=firstForwardedValue(req.headers.get('x-forwarded-proto')).toLowerCase();
  const host=firstForwardedValue(req.headers.get('x-forwarded-host'))||firstForwardedValue(req.headers.get('host'));
  if((proto==='http'||proto==='https')&&host){
    try{return new URL(`${proto}://${host}`).origin;}catch{}
  }
  return new URL(req.url).origin;
}

export function isSameOrigin(req:Request){
  const supplied=req.headers.get('origin');
  if(!supplied)return true;
  try{return new URL(supplied).origin===requestOrigin(req);}catch{return false;}
}
