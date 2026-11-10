import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {DatabaseSync} from 'node:sqlite';
import * as nodeCrypto from 'node:crypto';
import {Buffer} from 'node:buffer';

const sqlite=new DatabaseSync(':memory:');
sqlite.exec(`
CREATE TABLE auth_users(id TEXT PRIMARY KEY,email TEXT UNIQUE,name TEXT,password_hash TEXT,enabled INTEGER,must_change_password INTEGER,failed_attempts INTEGER DEFAULT 0,locked_until TEXT,password_changed_at TEXT,last_login_at TEXT,created_at TEXT,updated_at TEXT);
CREATE TABLE auth_sessions(id TEXT PRIMARY KEY,user_id TEXT,verifier_hash TEXT,expires_at TEXT,last_seen_at TEXT,revoked_at TEXT,user_agent TEXT,ip TEXT,created_at TEXT);
CREATE TABLE auth_audit(id TEXT PRIMARY KEY,user_id TEXT,email TEXT,action TEXT,outcome TEXT,ip TEXT,user_agent TEXT,at TEXT);
CREATE TABLE workspace_access(id TEXT PRIMARY KEY,payload TEXT,revision INTEGER);
`);
const sqlValue=value=>Object.prototype.toString.call(value)==='[object Date]'?value.toISOString():value;
const DB={prepare(sql){const bound=(...input)=>{const args=input.map(sqlValue),statement=sqlite.prepare(sql);return {first:async()=>statement.get(...args)||null,all:async()=>({results:statement.all(...args)}),run:async()=>({meta:{changes:Number(statement.run(...args).changes)}})}};return {bind:bound,...bound()};}};

const cache=new Map();
function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file);const exp={};cache.set(file,exp);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports:exp,require(id){if(id==='node:crypto')return nodeCrypto;return load(path.resolve(path.dirname(file),id+'.ts'));},Request,Response,Headers,URL,Buffer,crypto:nodeCrypto.webcrypto,console},{filename:file});return exp;
}

const passwords=load('lib/auth/password.ts');
const sessions=load('lib/auth/session.ts');
const auth=load('lib/auth/service.ts');
const accessStore=load('lib/access/store.ts');
const env={DB,XLLOOP_SESSION_HOURS:1,XLLOOP_OWNER_EMAIL:'owner@example.test'};
const initialPassword='Initial-passphrase-2026';
const initialHash=await passwords.hashPassword(initialPassword,{N:16384});
assert.match(initialHash,/^scrypt\$16384\$8\$1\$/);
assert.equal(await passwords.verifyPassword(initialPassword,initialHash),true);
assert.equal(await passwords.verifyPassword('wrong-password-2026',initialHash),false);
await assert.rejects(()=>passwords.hashPassword('too-short'),/至少需要12个字符/);

await DB.prepare('INSERT INTO auth_users(id,email,name,password_hash,enabled,must_change_password,failed_attempts,created_at,updated_at) VALUES (?,?,?,?,1,1,0,?,?)')
  .bind('11111111-1111-4111-8111-111111111111','owner@example.test','Owner',initialHash,new Date(),new Date()).run();
const request=new Request('https://xlloop.test/api/auth/login',{method:'POST',headers:{'user-agent':'auth-test','x-real-ip':'127.0.0.1'}});
const result=await auth.login(env,request,'OWNER@example.test',initialPassword);
assert.equal(result.user.mustChangePassword,true);
const storedSession=sqlite.prepare('SELECT verifier_hash FROM auth_sessions WHERE id=?').get(result.token.split('.')[0]);
assert.equal(storedSession.verifier_hash.length,64);
assert.equal(result.token.includes(storedSession.verifier_hash),false);
const cookie=sessions.sessionCookie(result.token,result.expiresAt);
assert.match(cookie,/^__Host-xlloop_session=/);
for(const flag of ['Path=/','Secure','HttpOnly','SameSite=Lax'])assert.ok(cookie.includes(flag));
const sessionRequest=new Request('https://xlloop.test/api/auth/session',{headers:{cookie}});
assert.equal((await sessions.authenticatedUser(sessionRequest,env)).email,'owner@example.test');
await assert.rejects(()=>sessions.authenticatedUser(new Request('https://xlloop.test/api/auth/session',{headers:{'oai-authenticated-user-id':'spoofed'}}),env),/请先登录/);
const accessRequest=new Request('https://xlloop.test/api/access',{headers:{cookie}});
assert.equal((await accessStore.principal(accessRequest,env)).isOwner,true);
await assert.rejects(()=>accessStore.principal(new Request('https://xlloop.test/api/state?project=ybirds',{headers:{cookie}}),env),/必须先修改密码/);

const changed=await auth.changePassword(env,sessionRequest,result.user,initialPassword,'Replacement-passphrase-2026');
assert.equal(changed.user.mustChangePassword,false);
assert.equal(sqlite.prepare('SELECT must_change_password FROM auth_users WHERE id=?').get(result.user.id).must_change_password,0);
assert.ok(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(result.token.split('.')[0]).revoked_at);
const newCookie=sessions.sessionCookie(changed.token,changed.expiresAt);
assert.equal((await sessions.authenticatedUser(new Request('https://xlloop.test/',{headers:{cookie:newCookie}}),env)).id,result.user.id);
await sessions.revokeRequestSession(new Request('https://xlloop.test/',{headers:{cookie:newCookie}}),DB);
await assert.rejects(()=>sessions.authenticatedUser(new Request('https://xlloop.test/',{headers:{cookie:newCookie}}),env),/已失效/);

for(let i=0;i<5;i++)await assert.rejects(()=>auth.login(env,request,'owner@example.test','definitely-wrong-passphrase'),/邮箱或密码错误/);
const locked=sqlite.prepare('SELECT failed_attempts,locked_until FROM auth_users WHERE id=?').get(result.user.id);
assert.equal(locked.failed_attempts,0);assert.ok(new Date(locked.locked_until).getTime()>Date.now());
await assert.rejects(()=>auth.login(env,request,'owner@example.test','Replacement-passphrase-2026'),/邮箱或密码错误/);
assert.ok(sqlite.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='login' AND outcome='failed'").get().n>=6);

console.log('auth password, session verifier, secure cookie, anti-spoofing, password rotation, revocation and lockout tests passed');
