import importlib.util,json,tempfile,pathlib,unittest,time,sys
spec=importlib.util.spec_from_file_location('runner','executor/runner.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestGateway(unittest.TestCase):
 def test_execution(self):
  with tempfile.TemporaryDirectory() as d:
   script=pathlib.Path(d)/'agent.py';script.write_text('import json,sys\nb=json.load(sys.stdin)\nprint(json.dumps({"status":"succeeded","summary":b["command"],"evidence":"Fixture, not real agent work","cost":0.1}))')
   p={'cwd':d,'repo':'authorized','environment':'staging','max_cost_per_job':20,'tasks':{'analysis':{'command':[sys.executable,str(script)]},'deploy':{'command':[sys.executable,str(script)]}}}
   g=m.Gateway({'projects':{'ybirds':p}},str(pathlib.Path(d)/'jobs.sqlite'))
   try:
    self.assertIn('analytics',g.capabilities('ybirds'))
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
unittest.main()
