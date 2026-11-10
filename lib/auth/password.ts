import {randomBytes, scrypt as nodeScrypt, timingSafeEqual} from 'node:crypto';

const KEY_LENGTH = 64;
const DEFAULT_N = 131072;
const DEFAULT_R = 8;
const DEFAULT_P = 1;

type ScryptOptions = {N?:number;r?:number;p?:number};

function derive(password:string,salt:Buffer,{N=DEFAULT_N,r=DEFAULT_R,p=DEFAULT_P}:ScryptOptions={}){
  const maxmem=Math.max(256*1024*1024,128*N*r+1024*1024);
  return new Promise<Buffer>((resolve,reject)=>nodeScrypt(password,salt,KEY_LENGTH,{N,r,p,maxmem},(error,key)=>error?reject(error):resolve(key as Buffer)));
}

export function validatePassword(password:unknown){
  if(typeof password!=='string'||password.length<6)throw new Error('密码至少需要6个字符');
  if(password.length>200)throw new Error('密码不能超过200个字符');
  return password;
}

export async function hashPassword(password:string,options:ScryptOptions={}){
  validatePassword(password);
  const N=options.N??DEFAULT_N,r=options.r??DEFAULT_R,p=options.p??DEFAULT_P;
  const salt=randomBytes(16),key=await derive(password,salt,{N,r,p});
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password:unknown,stored:unknown){
  if(typeof password!=='string'||typeof stored!=='string')return false;
  const parts=stored.split('$');
  if(parts.length!==6||parts[0]!=='scrypt')return false;
  const N=Number(parts[1]),r=Number(parts[2]),p=Number(parts[3]);
  if(!Number.isInteger(N)||!Number.isInteger(r)||!Number.isInteger(p)||N<16384||N>1048576||r<1||r>32||p<1||p>16)return false;
  try{
    const salt=Buffer.from(parts[4],'base64url'),expected=Buffer.from(parts[5],'base64url');
    if(salt.length<16||expected.length!==KEY_LENGTH)return false;
    const actual=await derive(password,salt,{N,r,p});
    return timingSafeEqual(actual,expected);
  }catch{return false;}
}
