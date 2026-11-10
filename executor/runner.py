#!/usr/bin/env python3
"""XLLoop reference execution gateway. Python 3.11+. Bind behind an HTTPS proxy.
Fixed, administrator-configured agent commands receive job JSON on stdin.
No command text from an HTTP request is evaluated as a shell command.
"""
import argparse, concurrent.futures, hmac, json, os, re, signal, sqlite3, subprocess, threading, time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
CAPS = {
 'analysis':['model','analytics'], 'spec':['model'], 'develop':['model','repository'],
 'review':['model','repository'], 'test':['ci'], 'preview':['preview'], 'deploy':['deploy'],
 'cdn':['cdn'], 'recovery':['rollback'], 'growth':['marketing'],
 'feedback':['model','analytics'], 'retro':['model']}
CAPS.update({'scan_internal':['analytics','model'],'scan_competitors':['web','model'],'scan_industry':['web','model'],'scan_seo':['search','web'],'scan_geo':['geo','model'],'scan_outreach':['marketing','model'],'scan_feedback':['feedback','model']})
CAPS['discover_projects']=['opportunities','web','model']
CAPS['triage_feedback']=['feedback_triage','model']
GATED = {'deploy','recovery','growth'}
class Gateway:
 def __init__(self, config, database):
  self.config=config; self.database=database; self.lock=threading.Lock(); self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=2)
  with self.connect() as db:
   db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project TEXT NOT NULL, status TEXT NOT NULL, request TEXT NOT NULL, result TEXT, created REAL NOT NULL)')
   # A restart cannot establish whether an external operation actually completed.
   db.execute("UPDATE jobs SET status='unknown' WHERE status IN ('queued','running')")
 @contextmanager
 def connect(self):
  db=sqlite3.connect(self.database, timeout=20)
  try:
   with db: yield db
  finally: db.close()
 def project(self, project):
  p=self.config.get('projects',{}).get(project)
  if not p: raise ValueError('Project is not authorized')
  return p
 def capabilities(self, project):
  p=self.project(project)
  return sorted({c for task,v in p.get('tasks',{}).items() if task in CAPS and v.get('command') for c in CAPS[task]})
 def get(self, job_id):
  with self.connect() as db: row=db.execute('SELECT status,result FROM jobs WHERE id=?',(job_id,)).fetchone()
  if not row: return 404, {'error':'Unknown job id'}
  if row[0]=='unknown': return 409, {'error':'Execution outcome unknown; operator must inspect evidence before resolving this job. Do not resubmit.'}
  return 200, json.loads(row[1]) if row[1] else {'status':row[0]}
 def submit(self, body):
  job_id=body.get('id',''); project=body.get('project'); task=body.get('task')
  if not isinstance(job_id,str) or not re.fullmatch(r'[A-Za-z0-9-]{1,150}',job_id): raise ValueError('Invalid idempotency id')
  if task=='triage_feedback' and body.get('scope')!='analysis-only': raise ValueError('Feedback triage is analysis-only')
  if task=='discover_projects' and (project!='opportunity-research' or body.get('scope')!='research-only'): raise ValueError('Discovery requires isolated research project and scope')
  p=self.project(project); command=p.get('tasks',{}).get(task,{}).get('command')
  if task not in CAPS or not isinstance(command,list) or not command or any(not isinstance(v,str) for v in command): raise ValueError('Task has no administrator-approved command')
  if task in GATED and body.get('approval',{}).get('approved') is not True: raise ValueError('This task requires explicit approval')
  remaining=body.get('budget',{}).get('maxAdditionalCost')
  if not isinstance(remaining,(int,float)) or not 0<remaining<=p.get('max_cost_per_job',20): raise ValueError('Budget must be positive and within the configured per-job ceiling')
  for k in ['repo','environment','analytics','cdn','channels']:
   if p.get(k) and body.get('settings',{}).get(k)!=p[k]: raise ValueError('Target outside configured project scope: '+k)
  workdir=Path(p.get('cwd','')).resolve()
  if not workdir.is_dir(): raise ValueError('Project working directory is unavailable')
  with self.lock, self.connect() as db:
   old=db.execute('SELECT project,request FROM jobs WHERE id=?',(job_id,)).fetchone()
   if old:
    if old[0]!=project or json.loads(old[1])!=body: raise ValueError('Idempotency id reused with different request')
    return self.get(job_id)
   db.execute('INSERT INTO jobs(id,project,status,request,created) VALUES(?,?,?,?,?)',(job_id,project,'queued',json.dumps(body),time.time()))
  self.pool.submit(self.execute,body,p,command,workdir)
  return 202, {'status':'queued'}
 def update(self,job_id,status,result=None):
  with self.connect() as db: db.execute('UPDATE jobs SET status=?,result=? WHERE id=?',(status,json.dumps(result) if result else None,job_id))
 def execute(self,body,p,command,workdir):
  job_id=body['id']; self.update(job_id,'running'); proc=None
  try:
   # Provider secrets are selected by the administrator, never supplied by a job.
   allowed=['PATH','HOME','LANG','TMPDIR']+p.get('env_allowlist',[])
   env={k:os.environ[k] for k in allowed if k in os.environ}
   env.update(XLLOOP_JOB_ID=job_id,XLLOOP_PROJECT=body['project'],XLLOOP_MAX_ADDITIONAL_COST=str(body['budget']['maxAdditionalCost']))
   proc=subprocess.Popen(command,cwd=workdir,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,start_new_session=True)
   out,err=proc.communicate(json.dumps(body),timeout=min(1800,max(10,p.get('timeout_seconds',300))))
   if proc.returncode: self.update(job_id,'failed',{'status':'failed','error':'Configured agent exited with code '+str(proc.returncode)+'. Inspect protected executor logs. Actual cost is unknown until reconciled.'}); return
   if len(out)>30000: raise ValueError('Agent output too large')
   result=json.loads(out)
   if result.get('status') not in ('succeeded','failed'): raise ValueError('Agent must return final succeeded or failed status')
   if result['status']=='succeeded':
    cost=result.get('cost')
    if not isinstance(result.get('summary'),str) or not result.get('evidence') or not isinstance(cost,(int,float)) or not 0<=cost<1e9: raise ValueError('Agent must provide summary, evidence and actual nonnegative cost')
   self.update(job_id,result['status'],result)
  except subprocess.TimeoutExpired:
   if proc: os.killpg(proc.pid,signal.SIGKILL); proc.communicate()
   self.update(job_id,'unknown')
  except Exception:
   # Invalid reports do not prove that external actions did not happen.
   self.update(job_id,'unknown')
class Handler(BaseHTTPRequestHandler):
 gateway=None; token=''
 def log_message(self,*args): pass
 def respond(self,status,data):
  raw=json.dumps(data).encode(); self.send_response(status); self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def authorized(self): return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.token)
 def do_GET(self):
  if not self.authorized(): return self.respond(401,{'error':'Unauthorized'})
  try:
   u=urlparse(self.path)
   if u.path=='/v1/capabilities': return self.respond(200,{'capabilities':self.gateway.capabilities(parse_qs(u.query).get('project',[''])[0])})
   if u.path.startswith('/v1/jobs/'): return self.respond(*self.gateway.get(unquote(u.path[len('/v1/jobs/'):])) )
   self.respond(404,{'error':'Not found'})
  except Exception: self.respond(400,{'error':'Project or request is invalid'})
 def do_POST(self):
  if not self.authorized(): return self.respond(401,{'error':'Unauthorized'})
  if self.path!='/v1/jobs': return self.respond(404,{'error':'Not found'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=100000: return self.respond(413,{'error':'Body size is invalid'})
   body=json.loads(self.rfile.read(size)); self.respond(*self.gateway.submit(body))
  except ValueError as e: self.respond(400,{'error':str(e)})
  except Exception: self.respond(500,{'error':'Executor error; inspect protected server logs'})
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--db',default='jobs.sqlite');parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8788);args=parser.parse_args()
 token=os.environ.get('XLLOOP_RUNNER_TOKEN','')
 if len(token)<32: raise SystemExit('Set XLLOOP_RUNNER_TOKEN to an administrator-managed secret of at least 32 characters.')
 Handler.gateway=Gateway(json.loads(Path(args.config).read_text()),args.db);Handler.token=token
 print('XLLoop gateway ready. Use an HTTPS reverse proxy; no model or tool credentials are configured automatically.',flush=True)
 ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
