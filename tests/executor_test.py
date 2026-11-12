import importlib.util,json,tempfile,pathlib,subprocess,unittest,time,sys
spec=importlib.util.spec_from_file_location('runner','executor/runner.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestGateway(unittest.TestCase):
 def test_execution(self):
  with tempfile.TemporaryDirectory() as d:
   script=pathlib.Path(d)/'agent.py';script.write_text('import json,os,sys\nb=json.load(sys.stdin)\nprint(json.dumps({"status":"succeeded","summary":b["command"],"evidence":"Fixture, not real agent work","cost":0.1,"metrics":{"allow_dirty_retry":os.environ.get("XLLOOP_ALLOW_UNCLAIMED_RETRY","")}}))')
   p={'cwd':d,'repo':'authorized','environment':'staging','max_cost_per_job':20,'tasks':{'analysis':{'command':[sys.executable,str(script)]},'develop':{'command':[sys.executable,str(script)]},'deploy':{'command':[sys.executable,str(script)]}}}
   g=m.Gateway({'projects':{'ybirds':p}},str(pathlib.Path(d)/'jobs.sqlite'))
   try:
    self.assertIn('model',g.capabilities('ybirds'));self.assertNotIn('analytics',g.capabilities('ybirds'))
    b={'id':'fixture-id','project':'ybirds','task':'analysis','command':'Fixture test','settings':{'repo':'authorized','environment':'staging'},'budget':{'maxAdditionalCost':1}}
    self.assertEqual(g.submit(b)[0],202)
    for _ in range(100):
     status,result=g.get('fixture-id')
     if result.get('status')=='succeeded':break
     time.sleep(.01)
    self.assertEqual(result['status'],'succeeded');self.assertEqual(result['cost'],.1)
    self.assertEqual(g.submit(b)[1]['status'],'succeeded')
    with self.assertRaises(ValueError):g.submit({**b,'command':'Changed'})
    with self.assertRaises(ValueError):g.submit({**b,'id':'denied','task':'deploy'})
    with self.assertRaises(ValueError):g.submit({**b,'id':'scope','settings':{'repo':'outside','environment':'staging'}})
    with self.assertRaises(ValueError):g.submit({**b,'id':'budget','budget':{'maxAdditionalCost':21}})
    prior={**b,'id':'prior-develop','runId':'run-one','task':'develop'}
    with g.connect() as db: db.execute('INSERT INTO jobs(id,project,status,request,created) VALUES(?,?,?,?,?)',(prior['id'],prior['project'],'failed',json.dumps(prior),time.time()))
    retry={**b,'id':'retry-develop','runId':'run-one','task':'develop'};self.assertEqual(g.submit(retry)[0],202)
    for _ in range(100):
     _,retry_result=g.get('retry-develop')
     if retry_result.get('status')=='succeeded':break
     time.sleep(.01)
    self.assertEqual(retry_result['metrics']['allow_dirty_retry'],'1')
    self.assertEqual(g.get('missing')[0],404)
   finally:g.pool.shutdown(wait=True)
 def test_multi_repository_registry(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);registry=root/'projects.json';template={'cwd':d,'max_cost_per_job':20,'tasks':{'develop':{'command':[sys.executable,'adapter.py']}}}
   config={'provisioning':{'enabled':True,'worktree_root':str(root/'worktrees'),'allowed_git_hosts':['gitlab.example.test'],'template_project':'ybirds'},'projects':{'ybirds':template}}
   g=m.Gateway(config,str(root/'jobs.sqlite'),str(registry))
   try:
    def fixture(project_root,item,allowed):
     target=project_root/item['id'];target.mkdir(parents=True,exist_ok=True)
     return {'id':item['id'],'name':item['name'],'cloneUrl':item['cloneUrl'],'baseBranch':'master','workBranch':item['workBranch'],'role':item['role'],'access':item['access'],'checks':item['checks'],'enabled':True,'autoPublish':item.get('autoPublish') is True,'path':str(target),'dirty':False,'head':'abc1234'}
    g.provision_repository=fixture
    result=g.configure_repositories({'project':'project-one','repositories':[{'id':'web','name':'Web','cloneUrl':'git@gitlab.example.test:team/web.git','baseBranch':'master','workBranch':'xlloop/project-one-web','role':'frontend','access':'edit','checks':['build'],'enabled':True,'autoPublish':True},{'id':'api','name':'API','cloneUrl':'git@gitlab.example.test:team/api.git','baseBranch':'master','workBranch':'xlloop/project-one-api','role':'backend','access':'read','checks':['test'],'enabled':True}]})
    self.assertEqual(len(result['repositories']),2);self.assertTrue(registry.is_file());self.assertTrue(g.project('project-one')['repositories'][0]['autoPublish']);self.assertEqual(g.project('project-one')['repositories'][1]['access'],'read');self.assertIn('repository',g.capabilities('project-one'))
   finally:g.pool.shutdown(wait=True)
 def test_repository_clone_uses_isolated_work_branch(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);source=root/'source';source.mkdir();subprocess.run(['git','init','-b','master'],cwd=source,check=True,capture_output=True);subprocess.run(['git','config','user.email','fixture@example.test'],cwd=source,check=True);subprocess.run(['git','config','user.name','Fixture'],cwd=source,check=True)
   (source/'README.md').write_text('fixture',encoding='utf-8');subprocess.run(['git','add','README.md'],cwd=source,check=True);subprocess.run(['git','commit','-m','fixture'],cwd=source,check=True,capture_output=True)
   project_root=root/'worktrees'/'project-one';project_root.mkdir(parents=True);config={'provisioning':{'enabled':True,'publish_enabled':True,'worktree_root':str(root/'worktrees'),'allowed_git_hosts':['fixture']},'projects':{}};g=m.Gateway(config,str(root/'jobs.sqlite'),str(root/'registry.json'))
   try:
    g.repository_url=lambda value,allowed:value
    row=g.provision_repository(project_root,{'id':'web','name':'Web','cloneUrl':str(source),'baseBranch':'master','workBranch':'xlloop/project-web','role':'frontend','access':'edit','checks':['build'],'enabled':True},{'fixture'})
    branch=subprocess.run(['git','branch','--show-current'],cwd=project_root/'web',check=True,capture_output=True,text=True).stdout.strip()
    self.assertEqual(branch,'xlloop/project-web');self.assertEqual(row['workBranch'],branch);self.assertFalse(row['dirty']);self.assertFalse(row['remotePublished'])
    (source/'BASE.md').write_text('latest base before development',encoding='utf-8');subprocess.run(['git','add','BASE.md'],cwd=source,check=True);subprocess.run(['git','commit','-m','base before development'],cwd=source,check=True,capture_output=True)
    g.prepare_development({'id':'develop-1','project':'project-one','task':'develop','runId':'run-one'},{'repositories':[row]})
    self.assertTrue((project_root/'web'/'BASE.md').is_file())
    g.registry['project-one']={'cwd':str(project_root),'repositories':[row],'tasks':{}};g.save_registry();(project_root/'web'/'README.md').write_text('changed',encoding='utf-8')
    with self.assertRaises(ValueError):g.publish_repository({'project':'project-one','repositoryId':'web','message':'测试提交','approved':False})
    with self.assertRaises(ValueError):g.publish_repository({'project':'project-one','repositoryId':'web','message':'english only','approved':True})
    published=g.publish_repository({'project':'project-one','repositoryId':'web','message':'测试自动分支提交','approved':True})
    self.assertEqual(published['branch'],'xlloop/project-web');self.assertEqual(len(published['commit']),40)
    remote=subprocess.run(['git','ls-remote','--heads',str(source),'refs/heads/xlloop/project-web'],check=True,capture_output=True,text=True).stdout
    self.assertIn('refs/heads/xlloop/project-web',remote)
    repeated=g.publish_repository({'project':'project-one','repositoryId':'web','message':'确认已推送','approved':True})
    self.assertEqual(repeated['status'],'already_published');self.assertEqual(repeated['commit'],published['commit'])
    (source/'BASE.md').write_text('base advanced after squash merge',encoding='utf-8');subprocess.run(['git','add','BASE.md'],cwd=source,check=True);subprocess.run(['git','commit','-m','advance base'],cwd=source,check=True,capture_output=True)
    (project_root/'web'/'README.md').write_text('changed again',encoding='utf-8')
    marker=project_root/'web'/'.git'/'xlloop-develop-owner.json';marker.write_text(json.dumps({'runId':'run-two','head':published['commit']}),encoding='utf-8')
    g.prepare_development({'id':'develop-2','project':'project-one','task':'develop','runId':'run-two'},g.registry['project-one'])
    self.assertEqual((project_root/'web'/'README.md').read_text(encoding='utf-8'),'changed again')
    updated=g.publish_repository({'project':'project-one','repositoryId':'web','message':'继续完善测试修改','approved':True})
    self.assertEqual(updated['status'],'published');self.assertNotEqual(updated['commit'],published['commit'])
    remote_head=subprocess.run(['git','ls-remote','--heads',str(source),'refs/heads/xlloop/project-web'],check=True,capture_output=True,text=True).stdout.split()[0]
    self.assertEqual(remote_head,updated['commit'])
    subprocess.run(['git','update-ref','-d','refs/heads/xlloop/project-web'],cwd=source,check=True)
    (source/'BASE.md').write_text('base advanced again after merge',encoding='utf-8');(source/'README.md').write_text('changed again',encoding='utf-8');subprocess.run(['git','add','BASE.md','README.md'],cwd=source,check=True);subprocess.run(['git','commit','-m','simulate squash merge'],cwd=source,check=True,capture_output=True)
    base_head=subprocess.run(['git','rev-parse','HEAD'],cwd=source,check=True,capture_output=True,text=True).stdout.strip()
    (project_root/'web'/'README.md').write_text('new delivery after merged branch deletion',encoding='utf-8')
    recreated=g.publish_repository({'project':'project-one','repositoryId':'web','message':'合并后继续交付修改','approved':True})
    self.assertEqual(recreated['status'],'published');self.assertTrue(recreated['rebasedToBase'])
    self.assertEqual(subprocess.run(['git','merge-base','--is-ancestor',base_head,recreated['commit']],cwd=project_root/'web').returncode,0)
   finally:g.pool.shutdown(wait=True)
unittest.main()
