#!/usr/bin/env python3
"""XLLoop reference execution gateway. Python 3.11+. Bind behind an HTTPS proxy.
Fixed, administrator-configured agent commands receive job JSON on stdin.
No command text from an HTTP request is evaluated as a shell command.
"""
import argparse, concurrent.futures, copy, hmac, json, os, re, signal, sqlite3, subprocess, tempfile, threading, time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
CAPS = {
 'analysis':['model'], 'spec':['model'], 'develop':['model','repository'],
 'review':['model','repository'], 'test':['ci'], 'preview':['preview'], 'deploy':['deploy'],
 'cdn':['cdn'], 'recovery':['rollback'], 'growth':['marketing'],
 'feedback':['model','analytics'], 'retro':['model']}
CAPS.update({'scan_internal':['analytics','model'],'scan_competitors':['web','model'],'scan_industry':['web','model'],'scan_seo':['search','web'],'scan_geo':['geo','model'],'scan_outreach':['marketing','model'],'scan_feedback':['feedback','model']})
CAPS['discover_projects']=['opportunities','web','model']
CAPS['triage_feedback']=['feedback_triage','model']
GATED = {'deploy','recovery','growth'}
class Gateway:
 def __init__(self, config, database, registry=None):
  self.config=config; self.database=database; self.registry_path=Path(registry).resolve() if registry else None; self.registry={}; self.lock=threading.Lock(); self.provision_lock=threading.Lock(); self.pool=concurrent.futures.ThreadPoolExecutor(max_workers=2)
  if self.registry_path and self.registry_path.is_file():
   saved=json.loads(self.registry_path.read_text(encoding='utf-8')); self.registry=saved if isinstance(saved,dict) else {}
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
  p=self.registry.get(project) or self.config.get('projects',{}).get(project)
  if not p: raise ValueError('Project is not authorized')
  return p
 def save_registry(self):
  if not self.registry_path: raise ValueError('Dynamic project registry is not configured')
  self.registry_path.parent.mkdir(parents=True,exist_ok=True)
  fd,name=tempfile.mkstemp(prefix='.projects-',suffix='.json',dir=self.registry_path.parent)
  try:
   with os.fdopen(fd,'w',encoding='utf-8') as handle: json.dump(self.registry,handle,ensure_ascii=False,indent=2);handle.write('\n')
   os.chmod(name,0o600);os.replace(name,self.registry_path)
  finally:
   if os.path.exists(name): os.unlink(name)
 def git(self,cwd,*args,timeout=180):
  result=self.git_process(cwd,*args,timeout=timeout)
  if result.returncode: raise ValueError((result.stderr or result.stdout or 'Git command failed')[-1500:])
  return result.stdout
 def git_process(self,cwd,*args,timeout=180):
  return subprocess.run(['git',*args],cwd=cwd,text=True,encoding='utf-8',errors='replace',stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout,check=False,env={k:os.environ[k] for k in ['PATH','HOME','LANG','SSH_AUTH_SOCK','GIT_SSH_COMMAND'] if k in os.environ})
 def repository_url(self,value,allowed_hosts):
  if not isinstance(value,str) or len(value)>500 or '\n' in value or '\r' in value: raise ValueError('Repository URL is invalid')
  match=re.fullmatch(r'git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+(?:\.git)?)',value)
  if match: host=match.group(1).lower()
  else:
   parsed=urlparse(value);host=(parsed.hostname or '').lower()
   if parsed.scheme not in ('https','ssh') or parsed.password or parsed.query or parsed.fragment or not host or parsed.path in ('','/') or parsed.scheme=='ssh' and parsed.username not in (None,'git'): raise ValueError('Repository URL is invalid')
   if parsed.scheme=='https' and parsed.username: raise ValueError('Credentials must not be embedded in repository URL')
  if host not in allowed_hosts: raise ValueError('Repository host is not authorized')
  return value
 def repository_branch(self,value,work=False):
  if not isinstance(value,str) or len(value)>120: raise ValueError('Repository branch is invalid')
  self.git(None,'check-ref-format','--branch',value,timeout=10)
  if work and (value in {'main','master','production','release'} or not value.startswith('xlloop/')): raise ValueError('Working branch must use xlloop/ and cannot be protected')
  return value
 def provision_repository(self,project_root,item,allowed_hosts):
  if not isinstance(item,dict): raise ValueError('Repository configuration is invalid')
  repo_id=str(item.get('id') or '').lower()
  if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,49}',repo_id): raise ValueError('Repository id is invalid')
  url=self.repository_url(item.get('cloneUrl'),allowed_hosts);base=self.repository_branch(item.get('baseBranch') or 'master');work=self.repository_branch(item.get('workBranch'),True)
  access='read' if item.get('access')=='read' else 'edit';checks=item.get('checks') if isinstance(item.get('checks'),list) else []
  if any(not isinstance(x,str) or not re.fullmatch(r'[-A-Za-z0-9_.]{1,50}',x) for x in checks): raise ValueError('Repository checks are invalid')
  target=(project_root/repo_id).resolve()
  if target.parent!=project_root: raise ValueError('Repository target escapes project root')
  if not target.exists():
   self.git(project_root,'clone','--no-checkout','--origin','origin','--',url,str(target));self.git(target,'fetch','--no-tags','origin',base);self.git(target,'switch','-c',work,'origin/'+base)
  else:
   if not (target/'.git').exists(): raise ValueError('Repository target exists but is not a Git checkout')
   current=self.git(target,'branch','--show-current').strip();remote=self.git(target,'remote','get-url','origin').strip()
   if remote!=url: raise ValueError('Existing repository remote does not match configuration')
   dirty=bool(self.git(target,'status','--porcelain').strip())
   if dirty and current!=work: raise ValueError('Cannot change working branch while repository has uncommitted changes')
   if not dirty:
    self.git(target,'fetch','--no-tags','origin',base)
    if current!=work:
     if self.git_process(target,'show-ref','--verify','--quiet','refs/heads/'+work).returncode==0: raise ValueError('Configured working branch already exists locally')
     remote_work=self.git_process(target,'ls-remote','--exit-code','--heads','origin','refs/heads/'+work)
     if remote_work.returncode==0: raise ValueError('Configured working branch already exists on GitLab; choose a new xlloop/* branch')
     if remote_work.returncode not in (2,): raise ValueError((remote_work.stderr or 'Unable to verify remote working branch')[-1500:])
     self.git(target,'switch','-c',work,'origin/'+base)
    else:self.git(target,'merge','--ff-only','origin/'+base)
  remote_work=self.git_process(target,'ls-remote','--exit-code','--heads','origin','refs/heads/'+work)
  if remote_work.returncode not in (0,2): raise ValueError((remote_work.stderr or 'Unable to verify remote working branch')[-1500:])
  return {'id':repo_id,'name':str(item.get('name') or repo_id)[:100],'cloneUrl':url,'baseBranch':base,'workBranch':work,'role':str(item.get('role') or '')[:100],'access':access,'checks':list(dict.fromkeys(checks)),'enabled':item.get('enabled') is not False,'autoPublish':item.get('autoPublish') is True,'path':str(target),'dirty':bool(self.git(target,'status','--porcelain').strip()),'head':self.git(target,'rev-parse','--short','HEAD').strip(),'remotePublished':remote_work.returncode==0}
 def configure_repositories(self,body):
  policy=self.config.get('provisioning',{});project=body.get('project');items=body.get('repositories')
  if policy.get('enabled') is not True or not self.registry_path: raise ValueError('Repository provisioning is disabled')
  if not isinstance(project,str) or not re.fullmatch(r'(?:[a-z0-9][a-z0-9_-]{0,63}|p-[a-f0-9-]{36})',project) or not isinstance(items,list) or not 0<len(items)<=20: raise ValueError('Project or repository list is invalid')
  root=Path(policy.get('worktree_root','')).resolve();root.mkdir(parents=True,exist_ok=True);project_root=(root/project).resolve()
  if project_root.parent!=root: raise ValueError('Project directory escapes worktree root')
  project_root.mkdir(mode=0o750,parents=True,exist_ok=True);allowed={str(x).lower() for x in policy.get('allowed_git_hosts',[]) if isinstance(x,str)}
  if not allowed: raise ValueError('No Git hosts are authorized')
  enabled=[item for item in items if isinstance(item,dict) and item.get('enabled') is not False]
  ids=[str(item.get('id') or '').lower() for item in enabled];urls=[str(item.get('cloneUrl') or '') for item in enabled]
  if not enabled or len(ids)!=len(set(ids)) or len(urls)!=len(set(urls)): raise ValueError('Enabled repositories must have unique ids and URLs')
  with self.provision_lock:
   repositories=[self.provision_repository(project_root,item,allowed) for item in enabled]
   template_name=policy.get('template_project','ybirds');template=copy.deepcopy(self.config.get('projects',{}).get(project) or self.config.get('projects',{}).get(template_name))
   if not isinstance(template,dict): raise ValueError('Provisioning project template is unavailable')
   scope='\n'.join(f"{row['cloneUrl']}@{row['workBranch']}" for row in repositories)
   settings=body.get('settings') if isinstance(body.get('settings'),dict) else {}
   targets={key:str(settings.get(key) or '').strip()[:1000] for key in ('environment','analytics','cdn','channels')}
   template.update(cwd=str(project_root),repo=scope,repositories=repositories,**targets);self.registry[project]=template;self.save_registry()
  return {'project':project,'repo':scope,'repositories':repositories,'capabilities':self.capabilities(project)}
 def repository_status(self,project):
  p=self.project(project);rows=[]
  for saved in p.get('repositories',[]):
   row=dict(saved);target=Path(row.get('path','')).resolve()
   try:
    ahead=self.git_process(target,'rev-list','--count','origin/'+str(row.get('baseBranch') or 'master')+'..HEAD')
    row.update(dirty=bool(self.git(target,'status','--porcelain').strip()),head=self.git(target,'rev-parse','--short','HEAD').strip(),branch=self.git(target,'branch','--show-current').strip(),ahead=int(ahead.stdout.strip()) if ahead.returncode==0 and ahead.stdout.strip().isdigit() else 0)
   except Exception: row.update(unavailable=True)
   rows.append(row)
  return {'project':project,'repo':p.get('repo',''),'repositories':rows,'capabilities':self.capabilities(project)}
 def publish_repository(self,body):
  policy=self.config.get('provisioning',{});project=body.get('project');repo_id=body.get('repositoryId');message=body.get('message')
  if policy.get('publish_enabled') is not True: raise ValueError('Repository publishing is disabled')
  if body.get('approved') is not True: raise ValueError('Publishing requires explicit operator approval')
  if not isinstance(project,str) or not re.fullmatch(r'(?:[a-z0-9][a-z0-9_-]{0,63}|p-[a-f0-9-]{36})',project): raise ValueError('Project is invalid')
  if not isinstance(repo_id,str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,49}',repo_id): raise ValueError('Repository id is invalid')
  if not isinstance(message,str) or not 2<=len(message.strip())<=200 or '\n' in message or '\r' in message or not re.search(r'[\u4e00-\u9fff]',message): raise ValueError('Commit message must be a one-line Chinese description of 2 to 200 characters')
  p=self.project(project);rows=p.get('repositories',[]);row=next((item for item in rows if item.get('id')==repo_id),None)
  if not row or row.get('enabled') is False: raise ValueError('Repository is not authorized')
  if row.get('access')!='edit': raise ValueError('Read-only repository cannot be published')
  work=self.repository_branch(row.get('workBranch'),True);base=self.repository_branch(row.get('baseBranch') or 'master')
  root=Path(policy.get('worktree_root','')).resolve();project_root=(root/project).resolve();target=Path(row.get('path','')).resolve()
  if project_root.parent!=root or target!=project_root/repo_id or not (target/'.git').exists(): raise ValueError('Repository checkout is outside the authorized worktree')
  allowed={str(x).lower() for x in policy.get('allowed_git_hosts',[]) if isinstance(x,str)};expected=self.repository_url(row.get('cloneUrl'),allowed)
  with self.provision_lock:
   if self.git(target,'branch','--show-current').strip()!=work: raise ValueError('Repository is on a different working branch')
   if self.git(target,'remote','get-url','origin').strip()!=expected: raise ValueError('Repository remote does not match configuration')
   if self.git(target,'diff','--name-only','--diff-filter=U').strip(): raise ValueError('Repository has unresolved conflicts')
   dirty=bool(self.git(target,'status','--porcelain').strip());original_head=self.git(target,'rev-parse','HEAD').strip();rebased_to_base=False
   remote=self.git_process(target,'ls-remote','--exit-code','--heads','origin','refs/heads/'+work)
   if remote.returncode not in (0,2): raise ValueError((remote.stderr or 'Unable to verify remote working branch')[-1500:])
   self.git(target,'fetch','--no-tags','origin',base)
   remote_commit=''
   if remote.returncode==0:
    self.git(target,'fetch','--no-tags','origin',work)
    remote_commit=self.git(target,'rev-parse','FETCH_HEAD').strip()
   based_on_remote_base=self.git_process(target,'merge-base','--is-ancestor','origin/'+base,'HEAD').returncode==0
   continues_remote_work=bool(remote_commit) and self.git_process(target,'merge-base','--is-ancestor',remote_commit,'HEAD').returncode==0
   if not based_on_remote_base and not continues_remote_work:
    published_commit=str(row.get('publishedCommit') or '')
    if remote_commit or not dirty or published_commit!=original_head: raise ValueError('Working branch is neither based on the configured remote base nor a safe continuation of the remote working branch')
    self.git(target,'stash','push','--include-untracked','-m','xlloop-publish-base-refresh')
    stash_commit=self.git(target,'rev-parse','refs/stash').strip()
    self.git(target,'reset','--hard','origin/'+base)
    applied=self.git_process(target,'stash','apply','--index',stash_commit)
    if applied.returncode:
     self.git(target,'reset','--hard',original_head);self.git(target,'clean','-fd')
     restored=self.git_process(target,'stash','apply','--index',stash_commit)
     if restored.returncode: raise ValueError('Automatic base refresh failed and the original changes remain in the Git stash; operator recovery is required')
     self.git(target,'stash','drop','stash@{0}')
     raise ValueError('Current changes conflict with the updated remote base; the original working changes were restored')
    self.git(target,'stash','drop','stash@{0}');rebased_to_base=True
   if dirty:
    self.git(target,'add','-A','--','.')
    if self.git_process(target,'diff','--cached','--quiet').returncode==0: raise ValueError('Repository has no publishable changes')
    commit_name=str(policy.get('commit_name') or 'XLLoop Automation')[:100];commit_email=str(policy.get('commit_email') or 'xlloop@localhost')[:200]
    self.git(target,'-c','user.name='+commit_name,'-c','user.email='+commit_email,'commit','-m',message.strip())
   elif self.git_process(target,'diff','--quiet','origin/'+base,'HEAD').returncode==0:
    raise ValueError('Repository has no changes to publish')
   commit=self.git(target,'rev-parse','HEAD').strip()
   if remote_commit and remote_commit!=commit and self.git_process(target,'merge-base','--is-ancestor',remote_commit,commit).returncode:
    raise ValueError('Remote working branch has changes that are not in the local checkout; synchronize or use a new xlloop/* branch')
   status='already_published' if remote_commit==commit else 'published'
   if status=='published': self.git(target,'push','--porcelain','origin','HEAD:refs/heads/'+work,timeout=300)
   row.update(head=commit[:12],dirty=False,remotePublished=True,publishedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),publishedCommit=commit)
   self.save_registry()
   marker_value=self.git(target,'rev-parse','--git-path','xlloop-develop-owner.json').strip();marker=Path(marker_value) if Path(marker_value).is_absolute() else (target/marker_value).resolve();git_dir=Path(self.git(target,'rev-parse','--absolute-git-dir').strip()).resolve()
   try: marker.relative_to(git_dir);marker.unlink(missing_ok=True)
   except (ValueError,OSError): pass
  return {'project':project,'repositoryId':repo_id,'branch':work,'commit':commit,'message':message.strip(),'status':status,'rebasedToBase':rebased_to_base}
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
  if task=='develop' and (not isinstance(body.get('runId'),str) or not re.fullmatch(r'[A-Za-z0-9-]{1,150}',body['runId'])): raise ValueError('Development task requires a valid run id')
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
   allowed=['PATH','HOME','LANG','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','PNPM_HOME']+p.get('env_allowlist',[])
   env={k:os.environ[k] for k in allowed if k in os.environ}
   env.update(XLLOOP_JOB_ID=job_id,XLLOOP_PROJECT=body['project'],XLLOOP_MAX_ADDITIONAL_COST=str(body['budget']['maxAdditionalCost']))
   if body.get('task')=='develop':
    with self.connect() as db: prior=db.execute("SELECT request FROM jobs WHERE project=? AND id<>? AND status='failed' ORDER BY created DESC LIMIT 50",(body['project'],job_id)).fetchall()
    for saved in prior:
     try: request=json.loads(saved[0])
     except (TypeError,json.JSONDecodeError): continue
     if request.get('task')=='develop' and request.get('runId')==body.get('runId'):
      env['XLLOOP_ALLOW_UNCLAIMED_RETRY']='1';break
   if p.get('repositories'): env['XLLOOP_REPOSITORIES_JSON']=json.dumps(p['repositories'],ensure_ascii=False)
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
   if u.path=='/v1/repositories': return self.respond(200,self.gateway.repository_status(parse_qs(u.query).get('project',[''])[0]))
   if u.path.startswith('/v1/jobs/'): return self.respond(*self.gateway.get(unquote(u.path[len('/v1/jobs/'):])) )
   self.respond(404,{'error':'Not found'})
  except Exception: self.respond(400,{'error':'Project or request is invalid'})
 def do_POST(self):
  if not self.authorized(): return self.respond(401,{'error':'Unauthorized'})
  if self.path not in {'/v1/jobs','/v1/repositories','/v1/repositories/publish'}: return self.respond(404,{'error':'Not found'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if not 0<size<=100000: return self.respond(413,{'error':'Body size is invalid'})
   body=json.loads(self.rfile.read(size))
   if self.path=='/v1/repositories': return self.respond(200,self.gateway.configure_repositories(body))
   if self.path=='/v1/repositories/publish': return self.respond(200,self.gateway.publish_repository(body))
   self.respond(*self.gateway.submit(body))
  except ValueError as e: self.respond(400,{'error':str(e)})
  except Exception: self.respond(500,{'error':'Executor error; inspect protected server logs'})
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--db',default='jobs.sqlite');parser.add_argument('--registry');parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8788);args=parser.parse_args()
 token=os.environ.get('XLLOOP_RUNNER_TOKEN','')
 if len(token)<32: raise SystemExit('Set XLLOOP_RUNNER_TOKEN to an administrator-managed secret of at least 32 characters.')
 Handler.gateway=Gateway(json.loads(Path(args.config).read_text()),args.db,args.registry);Handler.token=token
 print('XLLoop gateway ready. Use an HTTPS reverse proxy; no model or tool credentials are configured automatically.',flush=True)
 ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
