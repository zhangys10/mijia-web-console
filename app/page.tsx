"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Device = { id:number;did?:string;name:string;room:string;kind:string;icon:string;on:boolean;status:string;detail:string;color:string;online?:boolean };
type Connection = { loading:boolean;connected:boolean;region?:string;userId?:string;error?:string };
type Qr = { loading:boolean;imageUrl?:string;loginUrl?:string;error?:string;expired?:boolean;expiresAt?:number };

const demo:Device[]=[
  {id:1,name:"客厅吸顶灯",room:"客厅",kind:"灯光",icon:"☀",on:true,status:"已开启",detail:"亮度 68% · 暖白",color:"orange",online:true},
  {id:2,name:"米家空调",room:"客厅",kind:"环境",icon:"❄",on:true,status:"制冷中",detail:"24°C · 自动风",color:"blue",online:true},
  {id:3,name:"扫拖机器人",room:"客厅",kind:"清洁",icon:"◎",on:false,status:"充电中",detail:"电量 86% · 基站",color:"green",online:true},
  {id:4,name:"床头灯",room:"主卧",kind:"灯光",icon:"♢",on:false,status:"已关闭",detail:"离线控制可用",color:"violet",online:true},
  {id:5,name:"空气净化器",room:"主卧",kind:"环境",icon:"≈",on:true,status:"自动模式",detail:"PM2.5 处于优",color:"cyan",online:true},
  {id:6,name:"智能门锁",room:"玄关",kind:"安防",icon:"▣",on:true,status:"已上锁",detail:"电量 72%",color:"slate",online:true},
];

const regionLabels:Record<string,string>={cn:"中国大陆",sg:"新加坡",de:"欧洲",us:"美国",ru:"俄罗斯",i2:"印度"};

export default function Home(){
  const [devices,setDevices]=useState(demo),[room,setRoom]=useState("全屋"),[tab,setTab]=useState("首页"),[toast,setToast]=useState(""),[authOpen,setAuthOpen]=useState(false),[region,setRegion]=useState("cn"),[connection,setConnection]=useState<Connection>({loading:true,connected:false}),[qr,setQr]=useState<Qr>({loading:false}),[syncing,setSyncing]=useState(false),[qrSeconds,setQrSeconds]=useState(0);
  const polling=useRef(false);
  const rooms=useMemo(()=>["全屋",...Array.from(new Set(devices.map(d=>d.room)))],[devices]);
  const shown=useMemo(()=>room==="全屋"?devices:devices.filter(d=>d.room===room),[devices,room]);

  const message=(text:string)=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};

  async function loadDevices(notify=false){
    const response=await fetch("/api/xiaomi/devices");
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"XIAOMI_DEVICE_SYNC_FAILED");
    const icons:Record<string,string>={light:"☀",lamp:"♢",aircondition:"❄",acpartner:"❄",airpurifier:"≈",vacuum:"◎",fan:"≈",lock:"▣",curtain:"▥",humidifier:"◌",plug:"ϟ",switch:"ϟ",camera:"◉",sensor:"↗"};
    const mapped:Device[]=data.devices.map((device:{did:string;name:string;room:string;model:string;online:boolean},index:number)=>{const type=Object.keys(icons).find(key=>device.model.includes(key))||"sensor";return{id:index+100,did:device.did,name:device.name,room:device.room||"未分配",kind:type,icon:icons[type],on:device.online,status:device.online?"在线":"离线",detail:device.model||"米家设备",color:["orange","blue","green","violet","cyan"][index%5],online:device.online}});
    setDevices(mapped);
    if(notify)message(`已同步 ${mapped.length} 台米家设备`);
  }

  async function syncDevices(){
    if(syncing)return;
    setSyncing(true);
    message("正在同步米家设备…");
    try{await loadDevices(true);setConnection(state=>({...state,error:undefined}))}
    catch(error){const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";setConnection(state=>({...state,error:reason}));message(`同步失败：${friendlyError(reason)}`)}
    finally{setSyncing(false)}
  }

  async function checkSession(){
    try{const response=await fetch("/api/xiaomi/status");const result=await response.json();if(result.connected){setConnection({loading:false,connected:true,region:result.region,userId:result.userId});setRegion(result.region);try{await loadDevices()}catch(error){const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";setConnection(state=>({...state,error:reason}));message(`设备同步失败：${friendlyError(reason)}`)}}else setConnection({loading:false,connected:false})}
    catch(error){setConnection({loading:false,connected:false,error:error instanceof Error?error.message:"UNKNOWN_ERROR"})}
  }

  useEffect(()=>{void checkSession();return()=>{polling.current=false}},[]);
  useEffect(()=>{
    if(!qr.expiresAt||qr.expired)return;
    const tick=()=>{const remaining=Math.max(0,Math.ceil((qr.expiresAt!-Date.now())/1000));setQrSeconds(remaining);if(remaining===0){polling.current=false;setQr(state=>({...state,expired:true,error:undefined}))}};
    tick();
    const timer=window.setInterval(tick,1000);
    return()=>window.clearInterval(timer);
  },[qr.expiresAt,qr.expired]);

  async function startLogin(){
    setQr({loading:true});polling.current=false;
    try{const response=await fetch("/api/xiaomi/qr/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({region})});const result=await response.json();if(!response.ok)throw new Error(result.error);const expiresIn=Number(result.expiresIn)||300;setQrSeconds(expiresIn);setQr({loading:false,imageUrl:`${result.imageUrl}?v=${Date.now()}`,loginUrl:result.loginUrl,expiresAt:Date.now()+expiresIn*1000});polling.current=true;void poll()}
    catch(error){setQr({loading:false,error:error instanceof Error?error.message:"UNKNOWN_ERROR"})}
  }

  async function poll(){
    while(polling.current){
      try{const response=await fetch("/api/xiaomi/qr/poll");const result=await response.json();if(!response.ok){if(result.error==="XIAOMI_QR_EXPIRED"||result.error==="XIAOMI_QR_MISSING"){setQr({loading:false,expired:true});polling.current=false;break}throw new Error(result.error)}if(!result.pending){polling.current=false;setConnection({loading:false,connected:true,region:result.region,userId:`••••${result.userId}`});setAuthOpen(false);await syncDevices();break}}
      catch(error){setQr(state=>({...state,error:error instanceof Error?error.message:"UNKNOWN_ERROR"}));polling.current=false;break}
      await new Promise(resolve=>window.setTimeout(resolve,1800));
    }
  }

  async function toggle(id:number){
    const device=devices.find(d=>d.id===id);if(!device)return;const next=!device.on;setDevices(list=>list.map(d=>d.id===id?{...d,on:next,status:next?"已开启":"已关闭"}:d));
    if(device.did){try{const response=await fetch("/api/xiaomi/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({did:device.did,value:next})});const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error)}catch(error){setDevices(list=>list.map(d=>d.id===id?{...d,on:!next,status:!next?"已开启":"已关闭"}:d));message(`控制失败：${friendlyError(error instanceof Error?error.message:"UNKNOWN_ERROR")}`)}}
  }

  function runScene(name:string){message(`${name} 已执行`);if(name==="离家")setDevices(list=>list.map(d=>d.kind==="灯光"||d.kind==="环境"?{...d,on:false,status:"已关闭"}:d))}
  function openLogin(){setAuthOpen(true);if(!connection.connected&&!qr.imageUrl&&!qr.loading)void startLogin()}
  async function logout(){await fetch("/api/xiaomi/status",{method:"DELETE"});polling.current=false;setConnection({loading:false,connected:false});setDevices(demo);setQr({loading:false});setAuthOpen(false);message("已断开米家云连接")}

  return <main className="shell">
    <aside className="sidebar"><div className="brand"><b>mi</b><div><strong>我的家</strong><small>{connection.connected?regionLabels[connection.region||"cn"]:"米家云直连"}</small></div></div><nav>{[["首页","⌂"],["设备","▦"],["场景","✦"],["自动化","⌁"],["能耗","ϟ"]].map(([name,icon])=><button key={name} className={tab===name?"active":""} onClick={()=>setTab(name)}><i>{icon}</i>{name}</button>)}</nav><div className="sidefoot"><div className={`mode ${connection.connected?"connected":""}`}><span/><div><strong>{connection.loading?"检查连接中":connection.connected?"米家云已连接":"演示模式"}</strong><small>{connection.connected?`账号 ${connection.userId}`:"扫码登录以同步真实设备"}</small></div></div><button className="settings" onClick={openLogin}>⚙　账号与连接</button><div className="profile"><b>R</b><div><strong>Ryan</strong><small>家庭管理员</small></div><i>⋯</i></div></div></aside>

    <section className="workspace"><header><div><p>2026年8月25日 · 星期二</p><h1>{tab==="首页"?"早上好，Ryan":tab}</h1></div><div className="actions"><button aria-label="搜索">⌕</button><button aria-label="通知">♢</button><button className="primary" disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"↻ 同步中…":connection.connected?"↻ 同步设备":"＋ 连接米家"}</button></div></header>

    {tab==="首页"||tab==="设备"?<>
      <section className="metrics"><Metric icon="↗" tone="orange" label="室内温度" value="24.6" unit="°C" note="较昨日低 0.8°C"/><Metric icon="◌" tone="blue" label="室内湿度" value="58" unit="%" note="舒适范围"/><Metric icon="≈" tone="green" label="空气质量" value="优" unit="" note="PM2.5 · 8 μg/m³"/><Metric icon="ϟ" tone="violet" label="今日用电" value="6.4" unit=" kWh" note="↓ 12% 较昨日"/></section>
      <Title title="快捷场景" sub="轻触即可执行预设" action="管理场景 →"/><section className="scenes">{[["回家","打开客厅灯光与空调","⌂","orange"],["离家","关闭设备并启用安防","↗","blue"],["观影","调暗灯光，关闭窗帘","▷","violet"],["晚安","关闭全屋灯光与家电","☾","indigo"]].map(([name,description,icon,color])=><button key={name} onClick={()=>runScene(name)}><span className={color}>{icon}</span><div><strong>{name}</strong><small>{description}</small></div><b>›</b></button>)}</section>
      <Title title="我的设备" sub={`${devices.filter(d=>d.online!==false).length} 台在线 · ${devices.filter(d=>d.online===false).length} 台离线`} action="查看全部 →"/><div className="rooms">{rooms.map(item=><button key={item} className={room===item?"active":""} onClick={()=>setRoom(item)}>{item}</button>)}</div>
      <section className="devices">{shown.map(device=><article key={device.id}><div className="device-top"><span className={device.color}>{device.icon}</span><button aria-label={`${device.name}${device.on?"关闭":"开启"}`} className={`switch ${device.on?"on":""}`} onClick={()=>toggle(device.id)}><i/></button></div><h3>{device.name}</h3><p>{device.room} · {device.status}</p><div className="detail">{device.detail}<b>›</b></div></article>)}</section>
      {connection.connected&&devices.length===0&&<div className="empty-state"><strong>当前区域没有找到设备</strong><p>请确认选择的服务器区域与米家 App 一致。</p></div>}
    </>:tab==="场景"?<Panel title="场景中心" text="集中管理一键场景，让多个设备按预设状态协同工作。"><div className="panel-grid">{["回家","离家","观影","晚安"].map(name=><button key={name} onClick={()=>runScene(name)}>✦<strong>{name}</strong><small>点击立即执行</small></button>)}</div></Panel>:tab==="自动化"?<Panel title="自动化" text="根据时间、环境和设备状态，让家自动响应。"><Rule a="日落后" b="有人回家" c="打开玄关灯"/><Rule a="每日 23:30" b="门锁已上锁" c="执行晚安"/></Panel>:<Panel title="家庭能耗" text="查看设备用电趋势，发现节能空间。"><div className="chart">{[44,62,52,78,68,90,64].map((height,index)=><i key={index} style={{height:`${height}%`}}/>)}</div><div className="labels">{["周一","周二","周三","周四","周五","周六","今天"].map(day=><span key={day}>{day}</span>)}</div></Panel>}</section>

    <aside className="rightbar"><div className={`api ${connection.connected?"cloud-live":""}`}><div className="api-title"><span>⌁</span><div><strong>米家云</strong><small>{connection.connected?`${regionLabels[connection.region||"cn"]} · 已连接`:"扫码授权 · 直接连接"}</small></div></div><p>{connection.error?`最近同步失败：${friendlyError(connection.error)}`:connection.connected?`已连接小米账号 ${connection.userId}，可以同步家庭、房间与设备。`:"使用米家 App 扫描官方账号二维码登录，无需 Home Assistant，也无需输入账号密码。"}</p><button disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"正在同步设备…":connection.connected?"立即同步设备":"扫码连接米家"} <b>→</b></button></div><Title title="最近动态" sub="家庭设备实时记录" action="···"/><div className="timeline"><Activity icon="⌂" tone="orange" title="执行「回家」场景" text="3 台设备已响应" time="2 分钟前"/><Activity icon="✓" tone="green" title="智能门锁已上锁" text="通过指纹 · 家庭成员" time="18 分钟前"/><Activity icon="↗" tone="blue" title="空调已调至 24°C" text="自动化 · 舒适温度" time="1 小时前"/><Activity icon="◎" tone="violet" title="扫拖机器人完成清洁" text="清洁 42㎡ · 用时 38 分钟" time="3 小时前"/></div><button className="all">查看全部动态</button><div className="home-status"><div><strong>家庭状态</strong><span>{connection.connected?"米家云在线":"演示数据"}</span></div><section><Status icon="◈" n={String(devices.length)} label="设备总数"/><Status icon="ϟ" n={String(devices.filter(d=>d.on).length)} label="运行中"/><Status icon="⌁" n={String(rooms.length-1)} label="房间"/></section></div></aside>

    {authOpen&&<div className="modal-bg" onMouseDown={()=>{setAuthOpen(false);polling.current=false}}><div className="modal cloud-modal" onMouseDown={event=>event.stopPropagation()}><button className="close" onClick={()=>{setAuthOpen(false);polling.current=false}}>×</button><span className="mi-logo">mi</span><h2>{connection.connected?"米家账号已连接":"扫码登录米家"}</h2><p>{connection.connected?`已连接小米账号 ${connection.userId}，服务器区域：${regionLabels[connection.region||"cn"]}。`:"打开米家 App 或小米账号，扫描二维码完成授权。账号密码不会输入到本站。"}</p>{connection.connected?<><div className="connected-info"><span>✓</span><div><strong>米家云连接正常</strong><small>{devices.length} 台设备已同步</small></div></div><button className="logout" onClick={logout}>断开账号连接</button></>:<><label className="region-picker"><span>设备所在区域</span><select value={region} onChange={event=>{setRegion(event.target.value);setQr({loading:false});polling.current=false}}>{Object.entries(regionLabels).map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label><div className="qr-box">{qr.loading?<div className="qr-loading"><span/><small>正在向小米获取二维码</small></div>:qr.imageUrl&&!qr.error&&!qr.expired?<img src={qr.imageUrl} alt="小米账号扫码登录二维码"/>:<div className="qr-error"><strong>{qr.expired?"二维码已过期":qr.error?friendlyError(qr.error):"点击生成登录二维码"}</strong><button onClick={startLogin}>{qr.expired?"刷新二维码":"重新获取"}</button></div>}</div>{qr.imageUrl&&!qr.error&&!qr.expired&&<><p className={`qr-countdown ${qrSeconds<=30?"expiring":""}`}>二维码有效期 {String(Math.floor(qrSeconds/60)).padStart(2,"0")}:{String(qrSeconds%60).padStart(2,"0")}</p><p className="scan-tip">扫描后请在手机上确认登录</p></>}{qr.loginUrl&&!qr.expired&&<a className="qr-link" href={qr.loginUrl} target="_blank" rel="noreferrer">无法扫码？在小米官网完成登录 →</a>}<div className="security-note">⌁ 会话使用加密 HttpOnly Cookie 保存，浏览器脚本无法读取。</div></>}</div></div>}
    {toast&&<div className="toast">✓　{toast}</div>}
  </main>
}

function Metric(p:{icon:string;tone:string;label:string;value:string;unit:string;note:string}){return <article><span className={p.tone}>{p.icon}</span><div><small>{p.label}</small><strong>{p.value}<em>{p.unit}</em></strong><p>{p.note}</p></div></article>}
function Title(p:{title:string;sub:string;action:string}){return <div className="title"><div><h2>{p.title}</h2><p>{p.sub}</p></div><button>{p.action}</button></div>}
function Activity(p:{icon:string;tone:string;title:string;text:string;time:string}){return <div className="activity"><span className={p.tone}>{p.icon}</span><div><strong>{p.title}</strong><p>{p.text}</p><small>{p.time}</small></div></div>}
function Status(p:{icon:string;n:string;label:string}){return <span>{p.icon}<b>{p.n}</b><small>{p.label}</small></span>}
function Panel({title,text,children}:{title:string;text:string;children:React.ReactNode}){return <section className="panel"><div className="panel-title"><span>✦</span><div><h2>{title}</h2><p>{text}</p></div></div>{children}</section>}
function Rule({a,b,c}:{a:string;b:string;c:string}){return <div className="rule"><span>{a}</span><b>如果</b><span>{b}</span><b>就</b><span>{c}</span><i>已启用</i></div>}
function friendlyError(error:string){if(error==="SESSION_SECRET_NOT_CONFIGURED")return"网站会话加密尚未配置";if(error==="XIAOMI_QR_UNAVAILABLE")return"小米暂未返回登录二维码";if(error==="XIAOMI_QR_EXPIRED")return"二维码已过期，请重新获取";if(error==="XIAOMI_SERVICE_TOKEN_MISSING")return"登录成功，但未能取得米家服务令牌";if(error==="XIAOMI_NOT_CONNECTED")return"登录状态已失效，请重新扫码";if(error==="XIAOMI_CLOUD_TIMEOUT")return"米家云响应超时，请确认服务器区域后重试";if(error==="XIAOMI_CLOUD_RESPONSE_INVALID")return"米家云返回的数据无法识别";if(error==="XIAOMI_CLOUD_HTTP_401")return"米家登录已失效，请重新扫码登录";if(error==="XIAOMI_CLOUD_HTTP_403")return"米家云拒绝访问，请重新登录并确认所在区域";if(error.startsWith("XIAOMI_CLOUD_HTTP_"))return`米家云返回 HTTP ${error.split("_").pop()}`;if(error.startsWith("XIAOMI_CLOUD_CODE_"))return`米家云错误 ${error.split("_").pop()}，请确认服务器区域`;return`连接米家云失败：${error||"未知错误"}`}
