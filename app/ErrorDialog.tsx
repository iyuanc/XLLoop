'use client';
import type {ReactNode} from 'react';
export default function ErrorDialog({message,onClose,onRetry,title='操作失败',children}:{message?:string,onClose:()=>void,onRetry?:()=>void,title?:string,children?:ReactNode}){
  if(!message)return null;
  return <div role="presentation" style={{position:'fixed',inset:0,background:'rgba(0,0,0,.45)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:2000,padding:16}} onClick={onClose}><div role="alertdialog" aria-modal="true" aria-label={title} style={{background:'#fff',color:'#111',borderRadius:12,padding:24,maxWidth:360,width:'100%',boxShadow:'0 12px 40px rgba(0,0,0,.25)'}} onClick={e=>e.stopPropagation()}><h2 style={{margin:'0 0 12px',fontSize:18}}>{title}</h2><p style={{margin:'0 0 20px',overflowWrap:'anywhere'}}>{message}{children}</p><div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>{onRetry&&<button type="button" className="button" onClick={()=>{onClose();onRetry()}}>重试</button>}<button type="button" className="button primary" autoFocus onClick={onClose}>我知道了</button></div></div></div>;
}
