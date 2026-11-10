'use client';
import Link from 'next/link';
export default function LoginGate({state,message,onRetry}:{state:string,message:string,onRetry:()=>void}){
 const loading=state==='checking',signIn=state==='unauthenticated';
 return <main className="loginpage"><section className="logincard"><Link className="loginbrand" href="/"><span>X</span>XLLoop</Link><span className="loginversion">公司项目工作空间 · v0.5.1</span><h1>{loading?'正在检查登录状态':signIn?'登录你的项目工作空间':state==='forbidden'?'当前账号尚未获得授权':'项目暂时无法连接'}</h1><p>{loading?'正在确认你的身份和项目权限，请稍候。':message||'请使用管理员创建的公司账号继续。'}</p>{signIn&&<Link className="button primary" href="/login?return_to=%2F">使用公司账号登录</Link>}{!loading&&<button className="button" onClick={onRetry}>重新检查连接</button>}<small>登录身份与项目权限分别校验；连接异常时不会显示为已登录或加载示例经营数据。</small></section></main>;
}
