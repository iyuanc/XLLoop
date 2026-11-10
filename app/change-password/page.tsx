'use client';
import {FormEvent,useEffect,useState} from 'react';
import Link from 'next/link';

export default function ChangePasswordPage(){
 const [currentPassword,setCurrent]=useState(''),[newPassword,setNext]=useState(''),[confirm,setConfirm]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{fetch('/api/auth/session',{cache:'no-store'}).then(r=>{if(r.status===401)location.replace('/login?return_to=%2Fchange-password')})},[]);
 async function submit(event:FormEvent){event.preventDefault();if(newPassword!==confirm){setMessage('两次输入的新密码不一致');return;}setBusy(true);setMessage('');try{const r=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword})});const b:any=await r.json();if(!r.ok)throw Error(b.error||'修改失败');location.replace('/');}catch(e:any){setMessage(e.message||'修改失败');}finally{setBusy(false)}}
 return <main className="loginpage"><section className="logincard"><Link className="loginbrand" href="/"><span>X</span>XLLoop</Link><span className="loginversion">账号安全</span><h1>修改登录密码</h1><p>新密码至少6个字符。修改后其它登录会话将失效。</p><form className="simple-form" onSubmit={submit}><label>当前密码<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label><label>新密码<input type="password" autoComplete="new-password" minLength={6} maxLength={200} required value={newPassword} onChange={e=>setNext(e.target.value)}/></label><label>再次输入新密码<input type="password" autoComplete="new-password" minLength={6} maxLength={200} required value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>{message&&<p role="alert">{message}</p>}<button className="button primary" disabled={busy}>{busy?'正在保存…':'保存新密码'}</button></form></section></main>;
}
