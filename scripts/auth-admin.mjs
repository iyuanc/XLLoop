#!/usr/bin/env node
import {randomBytes,randomUUID,scrypt as nodeScrypt} from 'node:crypto';
import mysql from 'mysql2/promise';

const command=process.argv[2];
const args=new Map();
for(let i=3;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])usage();args.set(process.argv[i].slice(2),process.argv[i+1]);}

function usage(){
  console.error('用法: XLLOOP_ADMIN_PASSWORD=... node scripts/auth-admin.mjs <create-owner|create-user|reset-owner-password|reset-password> --email user@example.com [--name 姓名]');
  process.exit(2);
}
function required(name){const value=process.env[name]?.trim();if(!value)throw new Error(`缺少环境变量 ${name}`);return value;}
function numberEnv(name,fallback){const value=process.env[name];return value?Number(value):fallback;}
function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
function password(){const value=required('XLLOOP_ADMIN_PASSWORD');if(value.length<12||value.length>200)throw new Error('XLLOOP_ADMIN_PASSWORD 必须为 12–200 个字符');return value;}
function hashPassword(value){return new Promise((resolve,reject)=>{const salt=randomBytes(16);nodeScrypt(value,salt,64,{N:131072,r:8,p:1,maxmem:256*1024*1024},(error,key)=>error?reject(error):resolve(`scrypt$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`));});}

if(!['create-owner','create-user','reset-owner-password','reset-password'].includes(command))usage();
const email=normalizeEmail(args.get('email'));
if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('--email 无效');
const configuredOwner=normalizeEmail(required('XLLOOP_OWNER_EMAIL'));
if(['create-owner','reset-owner-password'].includes(command)&&email!==configuredOwner)throw new Error('--email 必须与 XLLOOP_OWNER_EMAIL 一致');
if(['create-user','reset-password'].includes(command)&&email===configuredOwner)throw new Error('owner 账号请使用对应的 owner 命令管理');
const passwordHash=await hashPassword(password());
const connection=await mysql.createConnection({
  host:process.env.MYSQL_HOST?.trim()||'127.0.0.1',port:numberEnv('MYSQL_PORT',3306),
  database:required('MYSQL_DATABASE'),user:required('MYSQL_USER'),password:required('MYSQL_PASSWORD'),
  charset:'utf8mb4',timezone:'Z'
});
let successMessage='';
try{
  await connection.beginTransaction();
  if(command==='create-owner'||command==='create-user'){
    const name=String(args.get('name')||email).trim().slice(0,100);
    const userId=randomUUID();
    await connection.execute('INSERT INTO auth_users(id,email,name,password_hash,enabled,must_change_password,created_at,updated_at) VALUES (?,?,?,?,1,1,?,?)',[userId,email,name,passwordHash,new Date(),new Date()]);
    const isOwner=command==='create-owner';
    await connection.execute('INSERT INTO auth_audit(id,user_id,email,action,outcome,ip,user_agent,at) VALUES (?,?,?,?,?,?,?,?)',[randomUUID(),userId,email,isOwner?'owner.create':'user.create','succeeded','','auth-admin CLI',new Date()]);
    successMessage=`已创建${isOwner?' owner':''}账号：${email}；首次登录必须修改密码。`;
  }else{
    const [result]=await connection.execute('UPDATE auth_users SET password_hash=?,enabled=1,must_change_password=1,failed_attempts=0,locked_until=NULL,password_changed_at=?,updated_at=? WHERE email=?',[passwordHash,new Date(),new Date(),email]);
    if(result.affectedRows!==1)throw new Error('未找到账号，请先创建该账号');
    await connection.execute('UPDATE auth_sessions s JOIN auth_users u ON u.id=s.user_id SET s.revoked_at=? WHERE u.email=? AND s.revoked_at IS NULL',[new Date(),email]);
    const [rows]=await connection.execute('SELECT id FROM auth_users WHERE email=?',[email]);
    const isOwner=command==='reset-owner-password';
    await connection.execute('INSERT INTO auth_audit(id,user_id,email,action,outcome,ip,user_agent,at) VALUES (?,?,?,?,?,?,?,?)',[randomUUID(),rows[0].id,email,isOwner?'owner.password.reset':'user.password.reset','succeeded','','auth-admin CLI',new Date()]);
    successMessage=`已重置${isOwner?' owner':''}密码并撤销现有会话：${email}；下次登录必须修改密码。`;
  }
  await connection.commit();
}catch(error){await connection.rollback();throw error;}finally{await connection.end();}
console.log(successMessage);
