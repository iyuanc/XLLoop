import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const file=path.resolve('lib/http/origin.ts');
const exportsObject={};
const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
vm.runInNewContext(code,{exports:exportsObject,URL,Request},{filename:file});

const {isSameOrigin,requestOrigin}=exportsObject;
const request=(url,headers={})=>new Request(url,{headers});

assert.equal(requestOrigin(request('https://xlloop.ybirds.cn/api/auth/login')),'https://xlloop.ybirds.cn');
assert.equal(isSameOrigin(request('https://xlloop.ybirds.cn/api/auth/login',{origin:'https://xlloop.ybirds.cn'})),true);
assert.equal(isSameOrigin(request('https://xlloop.ybirds.cn/api/auth/login',{origin:'https://evil.example'})),false);

const proxied=request('http://127.0.0.1:3100/api/auth/login',{
  host:'xlloop.ybirds.cn',
  origin:'https://xlloop.ybirds.cn',
  'x-forwarded-host':'xlloop.ybirds.cn',
  'x-forwarded-proto':'https',
});
assert.equal(requestOrigin(proxied),'https://xlloop.ybirds.cn');
assert.equal(isSameOrigin(proxied),true);

assert.equal(isSameOrigin(request('http://127.0.0.1:3100/api/auth/login',{
  host:'xlloop.ybirds.cn',
  origin:'https://evil.example',
  'x-forwarded-host':'xlloop.ybirds.cn',
  'x-forwarded-proto':'https',
})),false);
assert.equal(isSameOrigin(request('http://127.0.0.1:3100/api/auth/login',{
  origin:'https://xlloop.ybirds.cn',
  'x-forwarded-host':'xlloop.ybirds.cn',
  'x-forwarded-proto':'javascript',
})),false);
assert.equal(isSameOrigin(request('http://127.0.0.1:3100/api/auth/login')),true);

console.log('proxy-aware same-origin tests passed');
