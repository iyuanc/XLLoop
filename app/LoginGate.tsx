'use client';
const site='https://xlloop-operations.polishedpilot1.chatgpt.site';
export default function LoginGate({state,message,onRetry}:{state:string,message:string,onRetry:()=>void}){
 const loading=state==='checking',signIn=state==='unauthenticated';
 return <main className="loginpage"><section className="logincard"><a className="loginbrand" href={site} target="_top"><span>X</span>XLLoop</a><span className="loginversion">私有项目工作空间 · v0.5.1</span><h1>{loading?'正在检查登录状态':signIn?'登录你的项目工作空间':state==='forbidden'?'当前账号尚未获得授权':'项目暂时无法连接'}</h1><p>{loading?'正在确认你的身份和项目权限，请稍候。':message||'请使用获授权的ChatGPT账号继续。'}</p>{signIn&&<a className="button primary" href={site+'/signin-with-chatgpt?return_to=%2F'} target="_top">使用 ChatGPT 登录</a>}{!loading&&<button className="button" onClick={onRetry}>重新检查连接</button>}<a className="button" href={site} target="_blank" rel="noopener noreferrer">在浏览器中打开 XLLoop ↗</a><p className="loginhint">如果在App内点击登录后没有跳转，请使用“在浏览器中打开”，或点击页面右上角“…”选择用Safari打开。登录完成后回到此页面重新检查连接。</p><small>登录身份与项目权限分别校验；连接异常时不会显示为已登录或加载示例经营数据。</small></section></main>;
}
