import './globals.css';
export const viewport={width:'device-width',initialScale:1};
export const metadata={title:'XLLoop · 项目运营闭环台',description:'从洞察到结果，让每一次迭代形成闭环。'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
