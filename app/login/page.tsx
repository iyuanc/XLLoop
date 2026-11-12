'use client';
import {FormEvent,useState} from 'react';
import Link from 'next/link';
import ErrorDialog from '../ErrorDialog';

export default function LoginPage(){
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function submit(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const b:any=await r.json();if(!r.ok)throw Error(b.error||'登录失败');const p=new URLSearchParams(location.search).get('return_to');const target=p?.startsWith('/')&&!p.startsWith('//')?p:'/';location.replace(b.user?.mustChangePassword?'/change-password':target);}catch(e:any){setError(e.message||'登录失败');}finally{setBusy(false)}}
 return <main className="loginpage"><section className="logincard"><Link className="loginbrand" href="/"><span>X</span>XLLoop</Link><span className="loginversion">公司项目工作空间</span><h1>登录你的工作空间</h1><p>使用管理员为你创建的公司账号登录。</p><form className="simple-form" onSubmit={submit}><label>邮箱<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)}/></label><label>密码<input type="password" autoComplete="current-password" required minLength={6} maxLength={200} value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="button primary" disabled={busy}>{busy?'正在登录…':'登录'}</button></form><small>登录失败多次会临时锁定账号。请勿在共享设备保存密码。</small></section><ErrorDialog message={error} onClose={()=>setError('')}/></main>;
}
