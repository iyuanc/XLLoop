import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import assert from 'node:assert/strict';

const exports={};
const code=ts.transpileModule(fs.readFileSync('lib/architecture/core.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(code,{exports,URL,Set},{filename:'lib/architecture/core.ts'});
const base=exports.defaults();
base.repositories=[
 {id:'ybirds-web',name:'Web',cloneUrl:'git@gitlab.ybirds.cn:team/web.git',baseBranch:'master',workBranch:'xlloop/ybirds-web',role:'前端',access:'edit',checks:'build,test',enabled:true},
 {id:'ybirds-api',name:'API',cloneUrl:'https://gitlab.ybirds.cn/team/api.git',baseBranch:'master',workBranch:'xlloop/ybirds-api',role:'后端',access:'read',checks:['api-test'],enabled:true},
];
const saved=exports.normalize(base);
assert.equal(saved.repositories.length,2);
assert.deepEqual([...saved.repositories[0].checks],['build','test']);
assert.equal(saved.repositories[1].access,'read');
assert.throws(()=>exports.normalize({...base,repositories:[...base.repositories,{...base.repositories[0]}]}),/重复仓库/);
assert.throws(()=>exports.normalize({...base,repositories:[{...base.repositories[0],cloneUrl:'https://token@gitlab.ybirds.cn/team/web.git'}]}),/仓库地址/);
assert.throws(()=>exports.normalize({...base,repositories:[{...base.repositories[0],workBranch:'bad branch'}]}),/分支名称/);
assert.throws(()=>exports.normalize({...base,repositories:[{...base.repositories[0],workBranch:'master'}]}),/xlloop/);
console.log('PASS: multiple GitLab repositories normalize independently; duplicate, credential-bearing and invalid branch settings are rejected');
