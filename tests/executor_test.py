import importlib.util,json,tempfile,pathlib,subprocess,unittest,time,sys
spec=importlib.util.spec_from_file_location('runner','executor/runner.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestGateway(unittest.TestCase):
 def test_execution(self):
  with tempfile.TemporaryDirectory() as d:
   script=pathlib.Path(d)/'agent.py';script.write_text('import json,sys\nb=json.load(sys.stdin)\nprint(json.dumps({"status":"succeeded","summary":b["command"],"evidence":"Fixture, not real agent work","cost":0.1}))')
   p={'cwd':d,'repo':'authorized','environment':'staging','max_cost_per_job':20,'tasks':{'analysis':{'command':[sys.executable,str(script)]},'deploy':{'command':[sys.executable,str(script)]}}}
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
    g.registry['project-one']={'cwd':str(project_root),'repositories':[row],'tasks':{}};g.save_registry();(project_root/'web'/'README.md').write_text('changed',encoding='utf-8')
    with self.assertRaises(ValueError):g.publish_repository({'project':'project-one','repositoryId':'web','message':'测试提交','approved':False})
    with self.assertRaises(ValueError):g.publish_repository({'project':'project-one','repositoryId':'web','message':'english only','approved':True})
    published=g.publish_repository({'project':'project-one','repositoryId':'web','message':'测试自动分支提交','approved':True})
    self.assertEqual(published['branch'],'xlloop/project-web');self.assertEqual(len(published['commit']),40)
    remote=subprocess.run(['git','ls-remote','--heads',str(source),'refs/heads/xlloop/project-web'],check=True,capture_output=True,text=True).stdout
    self.assertIn('refs/heads/xlloop/project-web',remote)
    with self.assertRaises(ValueError):g.publish_repository({'project':'project-one','repositoryId':'web','message':'重复提交','approved':True})
   finally:g.pool.shutdown(wait=True)
unittest.main()
