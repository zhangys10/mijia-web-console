"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceControlSource, DeviceTopology } from "../lib/device-topology";
import { classifyDeviceKind, groupControlledDevices, inferHardwareRole, isControlDevice, isIndependentSmartDevice, listSwitchChannelTargets, selectDeviceView, type HardwareRole, type SwitchChannelTarget } from "../lib/device-views";
import { buildBindingActionParameters, listSwitchBindingTargets, listVisibleControlSources, type BindingAction, type SwitchBindingCapability, type SwitchBindingTarget } from "../lib/switch-bindings";

type Device = { id:number;did?:string;name:string;home:string;homeId:string;room:string;kind:string;icon:string;on:boolean;status:string;detail:string;color:string;online?:boolean;parentId?:string|null;urn?:string|null;logicalType?:string;hardwareRole?:HardwareRole;topology?:DeviceTopology|null;virtual?:boolean;members?:Device[] };
type AssociatedDeviceLink = { did:string; device?:Device; member?:Device };
type XiaomiHome = { id:string;name:string };
type SettingValue = boolean|number|string;
type Setting = { key:string;label:string;type:"switch"|"range"|"choice"|"action"|"text";siid:number;piid?:number;aiid?:number;min?:number;max?:number;step?:number;unit?:string;choices?:Array<[SettingValue,string]>;inputs?:number[];isPower?:boolean;format?:string };
type SpecProperty = { key:string;name:string;label:string;siid:number;piid:number;format:string;readable:boolean;writable:boolean;notify:boolean;unit?:string;choices?:Array<{value:SettingValue;label:string}>;range?:{min:number;max:number;step:number} };
type SpecAction = { key:string;name:string;label:string;siid:number;aiid:number;inputs:number[] };
type SpecEvent = { key:string;name:string;label:string;siid:number;eiid:number;arguments:number[] };
type SpecGroup = { key:string;name:string;label:string;siid:number;properties:SpecProperty[];actions:SpecAction[];events:SpecEvent[] };
type DeviceSpecification = { loading:boolean;groups:SpecGroup[];urn?:string;error?:string;binding?:SwitchBindingCapability };
type Connection = { loading:boolean;connected:boolean;region?:string;userId?:string;error?:string };
type Qr = { loading:boolean;imageUrl?:string;loginUrl?:string;error?:string;expired?:boolean;expiresAt?:number };

const demo:Device[]=[
  {id:1,name:"客厅吸顶灯",home:"我的家",homeId:"demo",room:"客厅",kind:"light",icon:"☀",on:true,status:"已开启",detail:"yeelink.light.demo",color:"orange",online:true},
  {id:2,name:"米家空调",home:"我的家",homeId:"demo",room:"客厅",kind:"aircondition",icon:"❄",on:true,status:"制冷中",detail:"xiaomi.aircondition.demo",color:"blue",online:true},
  {id:3,name:"扫拖机器人",home:"我的家",homeId:"demo",room:"客厅",kind:"vacuum",icon:"◎",on:false,status:"充电中",detail:"xiaomi.vacuum.demo",color:"green",online:true},
  {id:4,name:"床头灯",home:"我的家",homeId:"demo",room:"主卧",kind:"lamp",icon:"♢",on:false,status:"已关闭",detail:"yeelink.lamp.demo",color:"violet",online:true},
  {id:5,name:"空气净化器",home:"我的家",homeId:"demo",room:"主卧",kind:"airpurifier",icon:"≈",on:true,status:"自动模式",detail:"zhimi.airpurifier.demo",color:"cyan",online:true},
  {id:6,name:"智能门锁",home:"我的家",homeId:"demo",room:"玄关",kind:"lock",icon:"▣",on:true,status:"已上锁",detail:"xiaomi.lock.demo",color:"slate",online:true},
  {id:7,name:"客厅三开",home:"我的家",homeId:"demo",room:"客厅",kind:"switch",icon:"ϟ",on:true,status:"在线",detail:"xiaomi.switch.demo3",color:"orange",online:true},
  {id:8,name:"主卧中控",home:"我的家",homeId:"demo",room:"主卧",kind:"switch",icon:"ϟ",on:true,status:"在线",detail:"xiaomi.switch.panel",color:"violet",online:true},
  {id:9,name:"客厅中控",home:"我的家",homeId:"demo",room:"客厅",kind:"switch",icon:"▤",on:true,status:"在线",detail:"xiaomi.controller.oh4w",color:"blue",online:true,hardwareRole:"controller"},
];

const regionLabels:Record<string,string>={cn:"中国大陆",sg:"新加坡",de:"欧洲",us:"美国",ru:"俄罗斯",i2:"印度"};

export default function Home(){
  const [devices,setDevices]=useState(demo),[homes,setHomes]=useState<XiaomiHome[]>([{id:"demo",name:"我的家"}]),[selectedHome,setSelectedHome]=useState("demo"),[room,setRoom]=useState("全屋"),[tab,setTab]=useState("首页"),[toast,setToast]=useState(""),[authOpen,setAuthOpen]=useState(false),[region,setRegion]=useState("cn"),[connection,setConnection]=useState<Connection>({loading:true,connected:false}),[qr,setQr]=useState<Qr>({loading:false}),[syncing,setSyncing]=useState(false),[qrSeconds,setQrSeconds]=useState(0),[selectedDevice,setSelectedDevice]=useState<Device|null>(null),[settingValues,setSettingValues]=useState<Record<string,SettingValue>>({}),[operating,setOperating]=useState(""),[deviceSpec,setDeviceSpec]=useState<DeviceSpecification>({loading:false,groups:[]}),[deviceView,setDeviceView]=useState<"hardware"|"controlled">("hardware"),[focusedMapping,setFocusedMapping]=useState<Device|null>(null),[bindingDevice,setBindingDevice]=useState<Device|null>(null);
  const polling=useRef(false),specRequest=useRef(0);
  const homeDevices=useMemo(()=>devices.filter(device=>device.homeId===selectedHome),[devices,selectedHome]);
  const hardwareDevices=useMemo(()=>selectDeviceView(homeDevices,"hardware"),[homeDevices]);
  const actualDevices=useMemo(()=>groupControlledDevices(selectDeviceView(homeDevices,"controlled")),[homeDevices]);
  const viewDevices=useMemo(()=>deviceView==="controlled"?actualDevices:hardwareDevices,[actualDevices,deviceView,hardwareDevices]);
  const rooms=useMemo(()=>["全屋",...Array.from(new Set(homeDevices.map(d=>d.room)))],[homeDevices]);
  const shown=useMemo(()=>room==="全屋"?viewDevices:viewDevices.filter(d=>d.room===room),[viewDevices,room]);
  const groupedRooms=useMemo(()=>Array.from(new Set(shown.map(device=>device.room))).map(name=>({name,devices:shown.filter(device=>device.room===name)})),[shown]);
  const topologySummary=useMemo(()=>({panels:hardwareDevices.filter(isControlDevice).length,targets:actualDevices.filter(device=>Boolean(device.topology?.controlledBy.length)).length,secondary:homeDevices.filter(device=>device.topology?.role==="secondary-panel").length,wired:homeDevices.reduce((total,device)=>total+(device.topology?.channels??[]).filter(channel=>channel.connectionType==="wired"||channel.connectionType==="mixed").length,0),wireless:homeDevices.reduce((total,device)=>total+(device.topology?.channels??[]).filter(channel=>channel.connectionType==="wireless"||channel.connectionType==="mixed").length,0),fanout:homeDevices.reduce((total,device)=>total+(device.topology?.channels??[]).filter(channel=>channel.targets.length>1).length,0)}),[actualDevices,hardwareDevices,homeDevices]);

  const message=(text:string)=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};

  async function loadDevices(notify=false,preserveRoom=false){
    const response=await fetch("/api/xiaomi/devices");
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"XIAOMI_DEVICE_SYNC_FAILED");
    const icons:Record<string,string>={light:"☀",lamp:"♢",aircondition:"❄",acpartner:"❄",airpurifier:"≈",vacuum:"◎",fan:"≈",lock:"▣",curtain:"▥",humidifier:"◌",plug:"ϟ",switch:"ϟ",camera:"◉",sensor:"↗"};
    const mapped:Device[]=data.devices.map((device:{did:string;name:string;home:string;homeId:string;room:string;model:string;logicalType?:string;online:boolean;parentId?:string|null;urn?:string|null;topology?:DeviceTopology|null},index:number)=>{const type=classifyDeviceKind(device.model,device.name,device.logicalType);return{id:index+100,did:device.did,name:device.name,home:device.home||"我的家",homeId:device.homeId||"default",room:device.room||"未分配",kind:type,icon:icons[type]||"↗",on:false,status:device.online?"在线":"离线",detail:device.model||"米家设备",color:["orange","blue","green","violet","cyan"][index%5],online:device.online,parentId:device.parentId,urn:device.urn,logicalType:device.logicalType,hardwareRole:inferHardwareRole(device.model,device.name),topology:device.topology}});
    const nextHomes:XiaomiHome[]=Array.isArray(data.homes)&&data.homes.length?data.homes.map((home:{id:string;name:string})=>({id:String(home.id),name:home.name})):Array.from(new Map(mapped.map(device=>[device.homeId,{id:device.homeId,name:device.home}])).values());
    setHomes(nextHomes);
    setSelectedHome(current=>nextHomes.some(home=>home.id===current)?current:(nextHomes[0]?.id||"default"));
    if(!preserveRoom)setRoom("全屋");
    setDevices(mapped);
    if(notify)message(`已同步 ${nextHomes.length} 个家庭、${mapped.length} 台米家设备`);
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

  async function applySetting(device:Device,setting:Setting,value:SettingValue=true){
    if(!device.online){message("设备当前离线，无法控制");return}
    if(!device.did){message("演示设备无法发送真实控制指令，请先连接米家账号");return}
    setOperating(`${device.id}:${setting.key}`);
    try{
      let params:SettingValue[]=[];
      if(setting.type==="action"&&setting.inputs?.length){
        const raw=settingValues[`${setting.key}:inputs`];
        const parsed=JSON.parse(typeof raw==="string"&&raw.trim()?raw:"[]") as unknown;
        if(!Array.isArray(parsed)||parsed.length!==setting.inputs.length||parsed.some(item=>!["boolean","number","string"].includes(typeof item)))throw new Error("INVALID_ACTION_PARAMETERS");
        params=parsed as SettingValue[];
      }
      const body=setting.type==="action"?{did:device.did,action:true,siid:setting.siid,aiid:setting.aiid,params}:{did:device.did,siid:setting.siid,piid:setting.piid,value};
      const response=await fetch("/api/xiaomi/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error);
      setSettingValues(values=>({...values,[setting.key]:value}));
      if(setting.key==="power"||setting.isPower){setDevices(list=>list.map(item=>item.id===device.id?{...item,on:Boolean(value),status:value?"已开启":"已关闭"}:item));setSelectedDevice(current=>current?.id===device.id?{...current,on:Boolean(value),status:value?"已开启":"已关闭"}:current)}
      message(`${device.name}：${setting.label}${setting.type==="action"?"已执行":"设置成功"}`);
    }catch(error){message(`控制失败：${friendlyError(error instanceof Error?error.message:"UNKNOWN_ERROR")}`)}
    finally{setOperating("")}
  }

  async function applySwitchBinding(device:Device,action:BindingAction,target:SwitchBindingTarget,sourceKey:number){
    if(!device.online){message("设备当前离线，无法修改绑定");return}
    if(!device.did){message("请先连接真实米家账号和设备");return}
    setOperating(`${device.id}:binding:${action.key}`);
    try{
      const params=buildBindingActionParameters(action,target,sourceKey);
      const response=await fetch("/api/xiaomi/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({did:device.did,action:true,siid:action.siid,aiid:action.aiid,params})});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error);
      message(`${device.name}：按键 ${sourceKey} 已绑定 ${target.name}`);
      try{await loadDevices(false,true)}catch{message("绑定已提交，稍后同步设备以查看最新关系")}
    }catch(error){message(`绑定失败：${friendlyError(error instanceof Error?error.message:"UNKNOWN_ERROR")}`)}
    finally{setOperating("")}
  }

  async function openDevice(device:Device,mappedDevice?:Device){
    const requestId=++specRequest.current;
    setSelectedDevice(device);setFocusedMapping(mappedDevice??null);setSettingValues({power:device.on});setDeviceSpec({loading:Boolean(device.did),groups:[]});
    if(!device.did)return;
    try{
      const query=new URLSearchParams({model:device.detail});if(device.urn)query.set("urn",device.urn);
      const response=await fetch(`/api/xiaomi/spec?${query}`);const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error);
      if(requestId!==specRequest.current)return;
      const groups=Array.isArray(result.groups)?result.groups as SpecGroup[]:[];
      setDeviceSpec({loading:false,groups,urn:result.urn,binding:result.binding&&typeof result.binding==="object"?result.binding as SwitchBindingCapability:undefined});
      if(!device.online)return;
      const readable=groups.flatMap(group=>group.properties.filter(property=>property.readable)).sort((a,b)=>Number(b.writable)-Number(a.writable)).slice(0,40);
      if(!readable.length)return;
      const mappings=readable.map(property=>`${property.siid}.${property.piid}`).join(",");
      const stateResponse=await fetch(`/api/xiaomi/control?did=${encodeURIComponent(device.did)}&properties=${encodeURIComponent(mappings)}`);const state=await stateResponse.json();
      if(!stateResponse.ok||!state.ok)throw new Error(state.error);
      if(requestId!==specRequest.current)return;
      const values=Object.fromEntries(Object.entries(state.values as Record<string,unknown>).filter(([,value])=>["boolean","number","string"].includes(typeof value))) as Record<string,SettingValue>;
      const firstPower=groups.flatMap(group=>group.properties).find(property=>property.name==="on"&&typeof values[property.key]==="boolean");
      const switchGroups=groups.filter(group=>group.name==="switch");
      const allWireless=switchGroups.length>0&&switchGroups.every(group=>group.properties.some(property=>/wireless|button-mode|switch-mode/.test(property.name)&&Boolean(values[property.key])));
      if(allWireless&&device.topology&&device.topology.role!=="secondary-panel"){
        const topology={...device.topology,role:"secondary-panel" as const};
        setSelectedDevice(current=>current?.id===device.id?{...current,topology}:current);
        setDevices(list=>list.map(item=>item.id===device.id?{...item,topology}:item));
      }
      setSettingValues(current=>({...current,...values,...(firstPower?{power:values[firstPower.key]}:{})}));
      if(firstPower){const on=Boolean(values[firstPower.key]);setSelectedDevice(current=>current?.id===device.id?{...current,on,status:on?"已开启":"已关闭"}:current);setDevices(list=>list.map(item=>item.id===device.id?{...item,on,status:on?"已开启":"已关闭"}:item))}
    }catch(error){
      if(requestId!==specRequest.current)return;
      const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";
      setDeviceSpec(current=>({...current,loading:false,error:reason}));
      if(device.online)message(`设备能力读取失败：${friendlyError(reason)}`);
    }
  }

  function openMappedDevice(device:Device){
    const parentId=device.parentId??device.topology?.parentId;
    const parent=device.topology?.relation==="mapped"&&parentId?hardwareDevices.find(item=>item.did===parentId)??homeDevices.find(item=>item.did===parentId):undefined;
    if(parent)void openDevice(parent,device);else void openDevice(device);
  }

  function associatedDeviceLinks(group:Device):AssociatedDeviceLink[]{
    const links=new Map<string,AssociatedDeviceLink>();
    for(const member of group.members?.length?group.members:[group]){
      if(!member.did)continue;
      const parentId=member.parentId??member.topology?.parentId;
      const device=hardwareDevices.find(item=>item.did===member.did)??(parentId?hardwareDevices.find(item=>item.did===parentId):undefined)??homeDevices.find(item=>item.did===member.did);
      links.set(member.did,{did:member.did,device,member});
    }
    for(const source of group.topology?.controlledBy??[]){
      if(links.has(source.sourceId))continue;
      const device=hardwareDevices.find(item=>item.did===source.sourceId)??homeDevices.find(item=>item.did===source.sourceId);
      links.set(source.sourceId,{did:source.sourceId,device});
    }
    return[...links.values()];
  }

  function openAssociatedDevice(link:AssociatedDeviceLink){
    if(link.device){void openDevice(link.device,link.member&&link.device.did!==link.member.did?link.member:undefined);return}
    if(link.member){openMappedDevice(link.member);return}
    message(`未找到设备 ${link.did} 的配置入口`);
  }

  function openDeviceCard(device:Device){
    if(deviceView==="hardware"){void openDevice(device);return}
    setBindingDevice(device);
  }

  function chooseBoundController(controller:Device){
    const target=bindingDevice?.members?.find(member=>member.topology?.controlledBy.some(source=>source.sourceId===controller.did))??bindingDevice?.members?.[0];
    setBindingDevice(null);
    void openDevice(controller,target);
  }

  function chooseConcreteMember(member:Device){
    setBindingDevice(null);
    openMappedDevice(member);
  }

  function runScene(name:string){message(`${name} 已执行`);if(name==="离家")setDevices(list=>list.map(d=>["light","lamp","aircondition","airpurifier","fan"].includes(d.kind)?{...d,on:false,status:"已关闭"}:d))}
  function openLogin(){setAuthOpen(true);if(!connection.connected&&!qr.imageUrl&&!qr.loading)void startLogin()}
  async function logout(){await fetch("/api/xiaomi/status",{method:"DELETE"});polling.current=false;specRequest.current++;setConnection({loading:false,connected:false});setDevices(demo);setHomes([{id:"demo",name:"我的家"}]);setSelectedHome("demo");setSelectedDevice(null);setBindingDevice(null);setFocusedMapping(null);setDeviceSpec({loading:false,groups:[]});setDeviceView("hardware");setQr({loading:false});setAuthOpen(false);message("已断开米家云连接")}

  return <main className="shell">
    <aside className="sidebar"><div className="brand"><b>mi</b><div><strong>我的家</strong><small>{connection.connected?regionLabels[connection.region||"cn"]:"米家云直连"}</small></div></div><nav>{[["首页","⌂"],["设备","▦"],["场景","✦"],["自动化","⌁"],["能耗","ϟ"]].map(([name,icon])=><button key={name} className={tab===name?"active":""} onClick={()=>setTab(name)}><i>{icon}</i>{name}</button>)}</nav><div className="sidefoot"><div className={`mode ${connection.connected?"connected":""}`}><span/><div><strong>{connection.loading?"检查连接中":connection.connected?"米家云已连接":"演示模式"}</strong><small>{connection.connected?`账号 ${connection.userId}`:"扫码登录以同步真实设备"}</small></div></div><button className="settings" onClick={openLogin}>⚙　账号与连接</button><div className="profile"><b>R</b><div><strong>Ryan</strong><small>家庭管理员</small></div><i>⋯</i></div></div></aside>

    <section className="workspace"><header><div><p>2026年8月25日 · 星期二</p><h1>{tab==="首页"?"早上好，Ryan":tab}</h1></div><div className="actions"><button aria-label="搜索">⌕</button><button aria-label="通知">♢</button><button className="primary" disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"↻ 同步中…":connection.connected?"↻ 同步设备":"＋ 连接米家"}</button></div></header>

    {tab==="首页"||tab==="设备"?<>
      {tab==="首页"&&<><section className="metrics"><Metric icon="↗" tone="orange" label="室内温度" value="24.6" unit="°C" note="较昨日低 0.8°C"/><Metric icon="◌" tone="blue" label="室内湿度" value="58" unit="%" note="舒适范围"/><Metric icon="≈" tone="green" label="空气质量" value="优" unit="" note="PM2.5 · 8 μg/m³"/><Metric icon="ϟ" tone="violet" label="今日用电" value="6.4" unit=" kWh" note="↓ 12% 较昨日"/></section>
      <Title title="快捷场景" sub="轻触即可执行预设" action="管理场景 →"/><section className="scenes">{[["回家","打开客厅灯光与空调","⌂","orange"],["离家","关闭设备并启用安防","↗","blue"],["观影","调暗灯光，关闭窗帘","▷","violet"],["晚安","关闭全屋灯光与家电","☾","indigo"]].map(([name,description,icon,color])=><button key={name} onClick={()=>runScene(name)}><span className={color}>{icon}</span><div><strong>{name}</strong><small>{description}</small></div><b>›</b></button>)}</section></>}
      <Title title={tab==="设备"?"家庭与设备":"我的设备"} sub={`${homeDevices.filter(d=>d.online!==false).length} 台在线 · ${homeDevices.filter(d=>d.online===false).length} 台离线`} action={`${homes.length} 个家庭`}/>
      <div className="home-tabs">{homes.map(home=><button key={home.id} className={selectedHome===home.id?"active":""} onClick={()=>{setSelectedHome(home.id);setRoom("全屋")}}><span>⌂</span><strong>{home.name}</strong><small>{devices.filter(device=>device.homeId===home.id).length} 台设备</small></button>)}</div>
      <div className="rooms">{rooms.map(item=><button key={item} className={room===item?"active":""} onClick={()=>setRoom(item)}>{item}</button>)}</div>
      <div className="topology-toolbar"><div className="device-view-switch"><button className={deviceView==="hardware"?"active":""} onClick={()=>setDeviceView("hardware")}>⌘ 开关与硬件</button><button className={deviceView==="controlled"?"active":""} onClick={()=>setDeviceView("controlled")}>◉ 实际受控设备</button></div><small>{deviceView==="hardware"?"实体开关、中控与智能灯具；按键直接显示绑定灯具":"受控设备 → 有线主控 + 所有无线副控"}</small></div>
      {connection.connected&&(topologySummary.targets>0||topologySummary.secondary>0)&&<div className="topology-summary"><span><b>{topologySummary.panels}</b> 台开关／中控</span><span><b>{topologySummary.targets}</b> 个受控目标</span>{topologySummary.wired>0&&<span className="wired-summary"><b>{topologySummary.wired}</b> 条有线回路</span>}{topologySummary.wireless>0&&<span className="wireless-summary"><b>{topologySummary.wireless}</b> 条无线绑定</span>}{topologySummary.fanout>0&&<span className="fanout-summary"><b>{topologySummary.fanout}</b> 个一控多路按键</span>}</div>}
      {groupedRooms.map(group=><section className="room-group" key={`${selectedHome}:${deviceView}:${group.name}`}><div className="room-heading"><strong>{group.name}</strong><span>{group.devices.length} {deviceView==="hardware"?"台实体设备":"个实际目标"}</span></div><section className="devices">{group.devices.map(device=>{
        const channels=deviceView==="hardware"?device.topology?.channels??[]:[];
        const role=device.topology?.role,sources=device.topology?.controlledBy??[],associated=deviceView==="controlled"?associatedDeviceLinks(device):[],targetCount=channels.reduce((total,channel)=>total+channel.targets.length,0),controller=isControlDevice(device),central=device.hardwareRole==="controller"||inferHardwareRole(device.detail,device.name)==="controller";
        return <article key={deviceView==="controlled"?`${device.homeId}:${device.room}:${device.name}`:`${device.homeId}:${device.did??device.id}`} className={`device-card ${deviceView==="controlled"?"virtual-device-card":"hardware-device-card"} ${device.online===false?"offline":""} ${role==="primary"?"primary-device":role==="secondary-panel"?"secondary-panel":""}`} role="button" tabIndex={0} onClick={()=>openDeviceCard(device)} onKeyDown={event=>{if(event.currentTarget===event.target&&(event.key==="Enter"||event.key===" ")){event.preventDefault();openDeviceCard(device)}}}>
          <div className="device-top"><span className={device.color}>{device.icon}</span>{deviceView==="controlled"&&<span className="virtual-badge">受控灯具</span>}</div>
          <div className="device-title-row"><h3>{device.name}</h3>{deviceView==="controlled"?<span className="topology-badge controlled-load">按名称归类</span>:<span className={`topology-badge ${controller?role||"primary":"controlled-load"}`}>{controller?central?"中控屏":"实体开关":"智能灯具"}</span>}</div>{deviceView==="controlled"?<><p>{associated.length||device.members?.length||1} 个关联设备 ID · {sources.length} 个控制来源</p><div className="detail">{device.room} · 点击 ID 跳转到实体配置<b>›</b></div></>:controller?<><p>{channels.length} 个按键 · {targetCount} 个受控目标</p><div className="detail">{device.room} · 点击查看按键与灯具<b>›</b></div></>:<><p>{device.status} · 独立智能设备</p><div className="detail">{device.room} · 点击设置智能灯具<b>›</b></div></>}
          {deviceView==="controlled"&&associated.length>0&&<div className="associated-device-ids">{associated.map(link=><button type="button" key={link.did} onClick={event=>{event.stopPropagation();openAssociatedDevice(link)}} title={`打开设备 ${link.did} 的配置`}><span>{link.device?.name??"关联设备"}</span><code>{link.did}</code><b>›</b></button>)}</div>}
          {deviceView==="controlled"&&<div className="card-binding-summary"><span>{sources.filter(source=>source.connectionType==="wired").length} 有线</span><span>{sources.filter(source=>source.connectionType==="wireless").length} 无线</span><small>查看具体设备卡片</small></div>}
          {deviceView==="hardware"&&channels.length>0&&<div className="card-binding-summary"><span>{channels.length} 个按键</span><span>{channels.reduce((total,channel)=>total+channel.targets.length,0)} 个绑定</span><small>点击查看详情</small></div>}
          {deviceView==="hardware"&&role==="secondary-panel"&&!channels.length&&<div className="card-binding-summary"><small>点击查看无线副控设置</small></div>}
        </article>})}</section></section>)}
      {connection.connected&&homeDevices.length===0&&<div className="empty-state"><strong>当前家庭没有找到设备</strong><p>请确认选择的家庭和服务器区域与米家 App 一致。</p></div>}
    </>:tab==="场景"?<Panel title="场景中心" text="集中管理一键场景，让多个设备按预设状态协同工作。"><div className="panel-grid">{["回家","离家","观影","晚安"].map(name=><button key={name} onClick={()=>runScene(name)}>✦<strong>{name}</strong><small>点击立即执行</small></button>)}</div></Panel>:tab==="自动化"?<Panel title="自动化" text="根据时间、环境和设备状态，让家自动响应。"><Rule a="日落后" b="有人回家" c="打开玄关灯"/><Rule a="每日 23:30" b="门锁已上锁" c="执行晚安"/></Panel>:<Panel title="家庭能耗" text="查看设备用电趋势，发现节能空间。"><div className="chart">{[44,62,52,78,68,90,64].map((height,index)=><i key={index} style={{height:`${height}%`}}/>)}</div><div className="labels">{["周一","周二","周三","周四","周五","周六","今天"].map(day=><span key={day}>{day}</span>)}</div></Panel>}</section>

    <aside className="rightbar"><div className={`api ${connection.connected?"cloud-live":""}`}><div className="api-title"><span>⌁</span><div><strong>米家云</strong><small>{connection.connected?`${regionLabels[connection.region||"cn"]} · 已连接`:"扫码授权 · 直接连接"}</small></div></div><p>{connection.error?`最近同步失败：${friendlyError(connection.error)}`:connection.connected?`已连接小米账号 ${connection.userId}，可以同步家庭、房间与设备。`:"使用米家 App 扫描官方账号二维码登录，无需 Home Assistant，也无需输入账号密码。"}</p><button disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"正在同步设备…":connection.connected?"立即同步设备":"扫码连接米家"} <b>→</b></button></div><Title title="最近动态" sub="家庭设备实时记录" action="···"/><div className="timeline"><Activity icon="⌂" tone="orange" title="执行「回家」场景" text="3 台设备已响应" time="2 分钟前"/><Activity icon="✓" tone="green" title="智能门锁已上锁" text="通过指纹 · 家庭成员" time="18 分钟前"/><Activity icon="↗" tone="blue" title="空调已调至 24°C" text="自动化 · 舒适温度" time="1 小时前"/><Activity icon="◎" tone="violet" title="扫拖机器人完成清洁" text="清洁 42㎡ · 用时 38 分钟" time="3 小时前"/></div><button className="all">查看全部动态</button><div className="home-status"><div><strong>家庭状态</strong><span>{connection.connected?"米家云在线":"演示数据"}</span></div><section><Status icon="◈" n={String(devices.length)} label="设备总数"/><Status icon="ϟ" n={String(devices.filter(d=>d.on).length)} label="运行中"/><Status icon="⌁" n={String(rooms.length-1)} label="房间"/></section></div></aside>

    {bindingDevice&&<div className="modal-bg" onMouseDown={()=>setBindingDevice(null)}><div className="modal binding-modal" onMouseDown={event=>event.stopPropagation()}><button className="close" onClick={()=>setBindingDevice(null)}>×</button><div className="device-modal-head"><span className={bindingDevice.color}>{bindingDevice.icon}</span><div><h2>{bindingDevice.name}</h2><p>{bindingDevice.home} · {bindingDevice.room} · 按名称归类</p></div></div><div className="binding-selector-title"><strong>关联的实际设备 ID</strong><small>{associatedDeviceLinks(bindingDevice).length} 个设备</small></div><ConcreteDeviceCards group={bindingDevice} devices={hardwareDevices} onController={chooseBoundController} onMember={chooseConcreteMember}/><p className="capability-note">点击任一设备 ID 会打开对应开关、中控或独立智能灯的实际配置页面。</p></div></div>}
    {selectedDevice&&<div className="modal-bg" onMouseDown={()=>{specRequest.current++;setSelectedDevice(null)}}><div className="modal device-modal" onMouseDown={event=>event.stopPropagation()}>
      <button className="close" onClick={()=>{specRequest.current++;setSelectedDevice(null)}}>×</button>
      <div className="device-modal-head"><span className={selectedDevice.color}>{selectedDevice.icon}</span><div><h2>{selectedDevice.name}</h2><p>{selectedDevice.home} · {selectedDevice.room} · {selectedDevice.online?"在线":"离线"}</p></div></div>
      <div className="device-identity"><div><small>设备类型</small><strong>{deviceKindLabel(selectedDevice.kind)}</strong></div><div><small>设备型号</small><strong>{selectedDevice.detail}</strong></div>{selectedDevice.did&&<div><small>设备 ID</small><strong>{selectedDevice.did}</strong></div>}</div>
      {(focusedMapping||selectedDevice.topology&&selectedDevice.topology.role!=="independent"||Boolean(selectedDevice.topology?.controlledBy.length))&&<div className="modal-topology"><div><strong>设备控制拓扑</strong>{selectedDevice.topology?.role&&selectedDevice.topology.role!=="independent"&&<TopologyBadge role={selectedDevice.topology.role} connectionType={selectedDevice.topology.connectionType}/>}</div>{focusedMapping&&<p><b>{selectedDevice.name}</b><span>›</span><b>{focusedMapping.topology?.channelLabel||"关联按键"}</b><span>›</span><b>{focusedMapping.name}</b></p>}{selectedDevice.topology?.parentName&&!focusedMapping&&<p><b>{selectedDevice.topology.parentName}</b><span>›</span><b>{selectedDevice.topology.channelLabel||"关联按键"}</b><span>›</span><b>{selectedDevice.name}</b></p>}{focusedMapping&&Boolean(focusedMapping.topology?.controlledBy.length)&&<ControlSources sources={focusedMapping.topology!.controlledBy} devices={hardwareDevices} onOpen={item=>void openDevice(item)}/>} {!focusedMapping&&Boolean(selectedDevice.topology?.controlledBy.length)&&<ControlSources sources={selectedDevice.topology!.controlledBy} devices={hardwareDevices} onOpen={item=>void openDevice(item)}/>}</div>}
      {isControlDevice(selectedDevice)&&deviceSpec.binding&&!deviceSpec.loading&&<SwitchBindingPanel key={selectedDevice.did??selectedDevice.id} device={selectedDevice} specification={deviceSpec} devices={homeDevices} values={settingValues} operating={operating} onBind={(action,target,sourceKey)=>void applySwitchBinding(selectedDevice,action,target,sourceKey)} onProperty={(property,target)=>void applySetting(selectedDevice,{key:property.key,label:`绑定 ${target.name}`,type:"text",siid:property.siid,piid:property.piid,format:property.format},target.did)} onPair={action=>void applySetting(selectedDevice,{key:action.key,label:action.label,type:"action",siid:action.siid,aiid:action.aiid,inputs:action.inputs})}/>}
      <div className="settings-heading"><strong>型号实际支持的设置</strong><span>{deviceSpec.loading?"读取中…":`${deviceSpec.groups.length?deviceSpec.groups.reduce((count,group)=>count+group.properties.filter(property=>property.writable).length+group.actions.length,0):deviceSettings(selectedDevice).length} 项`}</span></div>
      {deviceSpec.loading?<div className="spec-loading"><span/>正在解析设备公开规格和按键功能</div>:deviceSpec.groups.length?<div className="spec-groups">{deviceSpec.groups.map(group=>{
        const settings=groupSettings(group),readonly=group.properties.filter(property=>property.readable&&!property.writable),mapped=groupRelatedDevices(selectedDevice,group,deviceSpec.groups,homeDevices),bindings=groupBindings(selectedDevice,group,deviceSpec.groups);
        const relatedChannel=selectedDevice.topology?.channels.find(channel=>groupChannelMatch(channel.channelIndex,channel.channelSiid,group,deviceSpec.groups));
        const relatedTargets=groupDisplayTargets(relatedChannel,mapped,bindings,homeDevices);
        const wireless=relatedChannel?.connectionType==="wireless"||group.properties.some(property=>/wireless|button-mode|switch-mode/.test(property.name)&&Boolean(settingValues[property.key]));
        return <details className={`spec-group ${focusedMapping&&mapped.some(device=>device.id===focusedMapping.id)?"focused-group":""}`} key={group.key} open={group.name==="switch"||/panel|binding|relay|wireless|mutual/.test(group.name)||deviceSpec.groups.length<=3}>
          <summary><strong>{group.label}{group.name==="switch"&&<span className={`channel-role ${wireless?"wireless":"wired"}`}>{wireless?"无线副控":"有线主控"}</span>}</strong><small>{relatedTargets.length?`${relatedTargets.map(item=>item.name).join("、")} · `:""}{settings.length?`${settings.length} 项设置`:"状态与事件"}{group.events.length?` · ${group.events.length} 个事件`:""}</small></summary>
          {group.name==="switch"&&<div className={`channel-targets ${relatedTargets.length?"":"unbound"}`}><span>{wireless?"这个按键无线控制的灯具":"这个按键有线连接的灯具"}</span>{relatedTargets.length?relatedTargets.map(item=>item.smart&&item.device?<button className="channel-smart-target" key={item.id} type="button" onClick={()=>void openDevice(item.device!)}><strong>{item.name}</strong><small>{item.room} · 查看智能灯具 ›</small></button>:<strong key={item.id}>{item.name}<small>{item.room}</small></strong>):<small>米家云暂未返回该按键绑定的灯具</small>}</div>}
          {group.name!=="switch"&&relatedTargets.length>0&&<div className="channel-targets"><span>已关联的受控设备</span>{relatedTargets.map(item=><strong key={item.id}>{item.name}<small>{item.room}</small></strong>)}</div>}
          {settings.length>0&&<div className="setting-list">{settings.map(setting=><SettingRow key={setting.key} setting={setting} device={selectedDevice} values={settingValues} operating={operating} onApply={(item,value)=>void applySetting(selectedDevice,item,value)} onChange={(key,value)=>setSettingValues(values=>({...values,[key]:value}))}/>)}</div>}
          {readonly.length>0&&<div className="spec-readonly">{readonly.map(property=><div key={property.key}><span>{property.label}</span><strong>{formatPropertyValue(property,settingValues[property.key])}</strong></div>)}</div>}
          {group.events.length>0&&<div className="spec-events">{group.events.map(event=><div key={event.key}><span>↗ {event.label}</span><small>事件 {event.siid}.{event.eiid}</small></div>)}<p>按键事件已由设备公开；实时订阅和米家自动化编辑不属于当前云端控制接口。</p></div>}
        </details>})}</div>:deviceSettings(selectedDevice).length?<><div className="setting-list">{deviceSettings(selectedDevice).map(setting=><SettingRow key={setting.key} setting={setting} device={selectedDevice} values={settingValues} operating={operating} onApply={(item,value)=>void applySetting(selectedDevice,item,value)} onChange={(key,value)=>setSettingValues(values=>({...values,[key]:value}))}/>)}</div>{deviceSpec.error&&<p className="spec-warning">暂时无法读取型号规格，当前展示通用控制：{friendlyError(deviceSpec.error)}</p>}</>:<div className="readonly-note">该设备未公开可写控制项，可用属性和事件以其真实 MIoT 规格为准。</div>}
      <p className="capability-note">只显示该设备型号公开的属性、动作和事件；按键绑定、无线模式及背光选项仅在厂商已公开对应能力时出现。</p>
    </div></div>}
    {authOpen&&<div className="modal-bg" onMouseDown={()=>{setAuthOpen(false);polling.current=false}}><div className="modal cloud-modal" onMouseDown={event=>event.stopPropagation()}><button className="close" onClick={()=>{setAuthOpen(false);polling.current=false}}>×</button><span className="mi-logo">mi</span><h2>{connection.connected?"米家账号已连接":"扫码登录米家"}</h2><p>{connection.connected?`已连接小米账号 ${connection.userId}，服务器区域：${regionLabels[connection.region||"cn"]}。`:"打开米家 App 或小米账号，扫描二维码完成授权。账号密码不会输入到本站。"}</p>{connection.connected?<><div className="connected-info"><span>✓</span><div><strong>米家云连接正常</strong><small>{devices.length} 台设备已同步</small></div></div><button className="logout" onClick={logout}>断开账号连接</button></>:<><label className="region-picker"><span>设备所在区域</span><select value={region} onChange={event=>{setRegion(event.target.value);setQr({loading:false});polling.current=false}}>{Object.entries(regionLabels).map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label><div className="qr-box">{qr.loading?<div className="qr-loading"><span/><small>正在向小米获取二维码</small></div>:qr.imageUrl&&!qr.error&&!qr.expired?<img src={qr.imageUrl} alt="小米账号扫码登录二维码"/>:<div className="qr-error"><strong>{qr.expired?"二维码已过期":qr.error?friendlyError(qr.error):"点击生成登录二维码"}</strong><button onClick={startLogin}>{qr.expired?"刷新二维码":"重新获取"}</button></div>}</div>{qr.imageUrl&&!qr.error&&!qr.expired&&<><p className={`qr-countdown ${qrSeconds<=30?"expiring":""}`}>二维码有效期 {String(Math.floor(qrSeconds/60)).padStart(2,"0")}:{String(qrSeconds%60).padStart(2,"0")}</p><p className="scan-tip">扫描后请在手机上确认登录</p></>}{qr.loginUrl&&!qr.expired&&<a className="qr-link" href={qr.loginUrl} target="_blank" rel="noreferrer">无法扫码？在小米官网完成登录 →</a>}<div className="security-note">⌁ 会话使用加密 HttpOnly Cookie 保存，浏览器脚本无法读取。</div></>}</div></div>}
    {toast&&<div className="toast">✓　{toast}</div>}
  </main>
}

function SwitchBindingPanel({device,specification,devices,values,operating,onBind,onProperty,onPair}:{device:Device;specification:DeviceSpecification;devices:Device[];values:Record<string,SettingValue>;operating:string;onBind:(action:BindingAction,target:SwitchBindingTarget,sourceKey:number)=>void;onProperty:(property:SpecProperty,target:SwitchBindingTarget)=>void;onPair:(action:BindingAction)=>void}){
  const [sourceKey,setSourceKey]=useState(1),[targetKey,setTargetKey]=useState("");
  const capability=specification.binding;
  if(!capability)return null;
  const switchGroups=specification.groups.filter(group=>group.name==="switch");
  const buttons=switchGroups.length?switchGroups.map((group,index)=>({value:index+1,label:group.label,siid:group.siid})):(device.topology?.channels??[]).map((channel,index)=>({value:channel.channelIndex??index+1,label:channel.label,siid:channel.channelSiid??undefined}));
  const selectedButton=buttons.find(button=>button.value===sourceKey)??buttons[0];
  const activeKey=selectedButton?.value??sourceKey;
  const targetCandidates=listSwitchBindingTargets(device,devices);
  const suitableAction=(target:SwitchBindingTarget)=>capability.targetActions.find(action=>{
    if(target.kind==="wired-circuit"&&!action.targetChannelSelectable)return false;
    if(target.kind==="smart-device"&&action.targetChannelSelectable)return false;
    if(action.sourceKeySelectable||buttons.length<=1)return true;
    return action.groupName==="switch"&&Boolean(selectedButton)&&action.groupSiid===selectedButton?.siid;
  });
  const availableTargets=targetCandidates.filter(target=>Boolean(suitableAction(target))||target.kind==="smart-device"&&capability.targetProperties.length>0);
  const selectedTarget=availableTargets.find(target=>target.key===targetKey)??availableTargets[0];
  const selectedAction=selectedTarget?suitableAction(selectedTarget):undefined;
  const selectedProperty=selectedTarget?.kind==="smart-device"&&!selectedAction?capability.targetProperties[0]:undefined;
  const readonly=capability.properties.filter(property=>property.readable);
  const disabled=!device.online||Boolean(operating);
  const state=capability.status==="writable"?"可配置":capability.status==="readonly"?"仅可查看":"型号未开放";
  const description=capability.status==="unsupported"?"该型号未公开按键绑定属性或动作，无法通过米家云新建绑定。":capability.status==="readonly"?"该型号只公开可读取的绑定信息，没有可写绑定接口。":capability.mode==="target-action"?"根据该型号实际公开的动作参数，选择无线按键和它控制的灯具。":capability.mode==="target-property"?"该型号公开目标设备属性，仅支持绑定具有独立设备 ID 的智能灯。":"该型号公开学习配对或绑定设置；仅展示厂商允许的真实操作。";

  return <section className={`switch-binding-panel ${capability.status}`}>
    <div className="binding-panel-heading"><div><strong>按键与灯具绑定</strong><small>{capability.model}</small></div><span>{state}</span></div>
    <p className="binding-description">{description}</p>
    {readonly.length>0&&<div className="binding-readonly">{readonly.map(property=><div key={property.key}><span>{property.label}</span><strong>{formatPropertyValue(property,values[property.key])}</strong></div>)}</div>}
    {(capability.mode==="target-action"||capability.mode==="target-property")&&availableTargets.length>0&&<div className="binding-editor">
      {buttons.length>1&&<label><span>来源按键</span><select disabled={disabled} value={String(activeKey)} onChange={event=>setSourceKey(Number(event.target.value))}>{buttons.map(button=><option key={`${button.value}:${button.siid}`} value={String(button.value)}>{button.label}</option>)}</select></label>}
      <label><span>控制的灯具</span><select disabled={disabled} value={selectedTarget?.key??""} onChange={event=>setTargetKey(event.target.value)}>{availableTargets.map(target=><option key={target.key} value={target.key}>{target.room} · {target.name}{target.controllerName?` · ${target.controllerName}按键 ${target.channelIndex??target.channelSiid}`:" · 独立智能灯"}</option>)}</select></label>
      {selectedTarget&&<p className="binding-target-hint">{selectedTarget.kind==="wired-circuit"?`普通灯实际绑定 ${selectedTarget.controllerName} 的有线回路 ${selectedTarget.channelIndex??selectedTarget.channelSiid}。`:"独立智能灯通过它真实的米家设备 ID 绑定。"}</p>}
      <button className="setting-action binding-save" disabled={disabled||!selectedTarget||!selectedAction&&!selectedProperty} onClick={()=>{if(!selectedTarget)return;if(selectedAction)onBind(selectedAction,selectedTarget,activeKey);else if(selectedProperty)onProperty(selectedProperty,selectedTarget)}}>{operating?"处理中…":"保存真实绑定"}</button>
    </div>}
    {(capability.mode==="target-action"||capability.mode==="target-property")&&availableTargets.length===0&&<p className="binding-limitation">{targetCandidates.length?"该型号没有同时公开安全选择来源按键、目标设备和目标回路所需的参数，因此不提供不可用的绑定按钮。":"当前家庭没有找到该型号可绑定的独立智能灯或已识别有线回路。"}</p>}
    {capability.mode==="pairing"&&capability.pairingActions.length>0&&<div className="binding-pair-actions">{capability.pairingActions.map(action=><button key={action.key} className="setting-action" disabled={disabled} onClick={()=>onPair(action)}>{action.label}</button>)}</div>}
    {capability.mode==="pairing"&&capability.pairingActions.length===0&&<p className="binding-limitation">{capability.actions.length?"绑定动作需要厂商私有参数，不能安全生成指定灯具的绑定；公开属性可在下方型号设置中查看。":"该型号只公开绑定开关或相关状态，没有公开选择具体灯具的动作。"}</p>}
  </section>
}

function Metric(p:{icon:string;tone:string;label:string;value:string;unit:string;note:string}){return <article><span className={p.tone}>{p.icon}</span><div><small>{p.label}</small><strong>{p.value}<em>{p.unit}</em></strong><p>{p.note}</p></div></article>}
function Title(p:{title:string;sub:string;action:string}){return <div className="title"><div><h2>{p.title}</h2><p>{p.sub}</p></div><button>{p.action}</button></div>}
function Activity(p:{icon:string;tone:string;title:string;text:string;time:string}){return <div className="activity"><span className={p.tone}>{p.icon}</span><div><strong>{p.title}</strong><p>{p.text}</p><small>{p.time}</small></div></div>}
function Status(p:{icon:string;n:string;label:string}){return <span>{p.icon}<b>{p.n}</b><small>{p.label}</small></span>}
function Panel({title,text,children}:{title:string;text:string;children:React.ReactNode}){return <section className="panel"><div className="panel-title"><span>✦</span><div><h2>{title}</h2><p>{text}</p></div></div>{children}</section>}
function Rule({a,b,c}:{a:string;b:string;c:string}){return <div className="rule"><span>{a}</span><b>如果</b><span>{b}</span><b>就</b><span>{c}</span><i>已启用</i></div>}
function TopologyBadge({role,connectionType}:{role:DeviceTopology["role"];connectionType?:DeviceTopology["connectionType"]}){if(role==="independent")return null;const label=role==="primary"?(connectionType==="mixed"?"有线 / 无线":"有线主控"):role==="secondary-panel"?"无线副控":"受控回路";return <span className={`topology-badge ${role} ${connectionType||""}`}>{label}</span>}
function ControlSources({sources,devices,onOpen}:{sources:DeviceControlSource[];devices?:Device[];onOpen?:(device:Device)=>void}){
  const ordered=[...sources].sort((left,right)=>Number(left.sourceRole!=="primary")-Number(right.sourceRole!=="primary"));
  return <div className="control-sources"><small>控制来源 · {sources.filter(source=>source.connectionType==="wired").length} 有线 / {sources.filter(source=>source.connectionType==="wireless").length} 无线</small>{ordered.map(source=>{
    const device=devices?.find(item=>item.did===source.sourceId);
    return <button key={`${source.sourceId}:${source.channelIndex}:${source.channelSiid}`} className="control-source-row" type="button" onClick={event=>{event.stopPropagation();if(device&&onOpen)onOpen(device)}} disabled={!device||!onOpen}><span className={`source-role ${source.sourceRole} ${source.connectionType}`}>{source.connectionType==="wired"?"有线主控":"无线副控"}</span><span className="source-identity"><strong>{source.sourceName}</strong>{source.viaName&&<small>经 {source.viaName}</small>}</span><span className="source-channel"><strong>{source.channelIndex!==null?`按键 ${source.channelIndex===0?1:source.channelIndex}`:source.channelSiid!==null?`服务 ${source.channelSiid}`:source.sourceRoom}</strong>{source.targetCount>1&&<small>同时控制 {source.targetCount} 台</small>}</span></button>
  })}</div>
}
function ConcreteDeviceCards({group,devices,onController,onMember}:{group:Device;devices:Device[];onController:(device:Device)=>void;onMember:(device:Device)=>void}){
  const sources=listVisibleControlSources(group.topology?.controlledBy??[]);
  const cards=new Map<string,React.ReactNode>();
  for(const source of sources){
    const device=devices.find(item=>item.did===source.sourceId),channel=source.channelIndex!==null?`按键 ${source.channelIndex===0?1:source.channelIndex}`:source.channelSiid!==null?`服务 ${source.channelSiid}`:"关联按键";
    cards.set(source.sourceId,<ConcreteDeviceCard key={source.sourceId} device={device} name={device?.name??source.sourceName} icon="ϟ" tone={source.connectionType==="wired"?"orange":"violet"} label={source.connectionType==="wired"?"有线主控":"无线副控"} note={`${source.sourceRoom} · ${channel} · ID ${source.sourceId}`} onOpen={device?()=>onController(device):undefined}/>);
  }
  for(const member of group.members?.length?group.members:[group]){
    if(!member.did||cards.has(member.did))continue;
    const parentId=member.parentId??member.topology?.parentId,device=devices.find(item=>item.did===member.did)??(parentId?devices.find(item=>item.did===parentId):undefined),smart=isIndependentSmartDevice(member);
    const onOpen=device&&isControlDevice(device)?()=>onController(device):()=>onMember(member);
    cards.set(member.did,<ConcreteDeviceCard key={member.did} device={device??member} name={device?.name??member.name} icon={device?.icon??member.icon} tone={device?.color??member.color} label={smart?"智能设备":parentId?"映射回路":"关联设备"} note={`ID ${member.did}${device&&device.did!==member.did?` · 配置于 ${device.name}`:""}`} onOpen={onOpen}/>);
  }
  if(!cards.size)return <div className="unresolved-binding"><strong>暂未识别到关联设备 ID</strong><small>同步结果返回设备 ID 后，会在这里列出对应的配置入口。</small></div>;
  return <div className="concrete-device-list">{[...cards.values()]}</div>;
}
function ConcreteDeviceCard({device,name,icon,tone,label,note,onOpen}:{device?:Device;name:string;icon:string;tone:string;label:string;note:string;onOpen?:()=>void}){
  return <button type="button" className="concrete-device-card" disabled={!onOpen} onClick={event=>{event.stopPropagation();onOpen?.()}}><span className={tone}>{icon}</span><div><strong>{name}</strong><small>{note}</small></div><em>{label}</em>{device&&onOpen&&<b>›</b>}</button>
}
function groupChannelMatch(index:number|null,siid:number|null,group:SpecGroup,groups:SpecGroup[]){if(siid!==null)return siid===group.siid;if(index===null)return false;const ordinal=groups.filter(item=>item.name==="switch").findIndex(item=>item.key===group.key);return ordinal>=0&&(index===ordinal+1||index===0&&ordinal===0)}
function groupRelatedDevices(device:Device,group:SpecGroup,groups:SpecGroup[],devices:Device[]){return devices.filter(item=>item.parentId===device.did&&groupChannelMatch(item.topology?.channelIndex??null,item.topology?.channelSiid??null,group,groups))}
function groupBindings(device:Device,group:SpecGroup,groups:SpecGroup[]){return(device.topology?.bindings??[]).filter(binding=>groupChannelMatch(binding.channelIndex,binding.channelSiid,group,groups))}
function groupDisplayTargets(channel:DeviceTopology["channels"][number]|undefined,mapped:Device[],bindings:DeviceTopology["bindings"],devices:Device[]):SwitchChannelTarget<Device>[]{
  const targets=new Map(listSwitchChannelTargets(channel,devices).map(target=>[target.id,target]));
  for(const item of mapped)if(item.did&&!targets.has(item.did))targets.set(item.did,{id:item.did,name:item.name,room:item.room,device:item,smart:isIndependentSmartDevice(item)});
  for(const item of bindings)if(!targets.has(item.targetId)){const device=devices.find(candidate=>candidate.did===item.targetId);targets.set(item.targetId,{id:item.targetId,name:item.targetName,room:item.targetRoom,device,smart:Boolean(device&&isIndependentSmartDevice(device))})}
  return[...targets.values()];
}
function SettingRow({setting,device,values,operating,onApply,onChange}:{setting:Setting;device:Device;values:Record<string,SettingValue>;operating:string;onApply:(setting:Setting,value?:SettingValue)=>void;onChange:(key:string,value:SettingValue)=>void}){
  const disabled=!device.online||Boolean(operating),value=values[setting.key];
  return <div className={`setting-row ${setting.type==="action"&&setting.inputs?.length?"with-inputs":""}`}><div className="setting-label"><strong>{setting.label}</strong><small>{setting.type==="action"?`动作 ${setting.siid}.${setting.aiid}`:`属性 ${setting.siid}.${setting.piid}`}</small></div>
    {setting.type==="switch"?<button className={`switch ${value?"on":""}`} disabled={disabled} onClick={()=>onApply(setting,!value)}><i/></button>:
    setting.type==="action"?<div className="action-control">{Boolean(setting.inputs?.length)&&<input aria-label={`${setting.label}参数`} placeholder={`JSON 数组，${setting.inputs?.length} 个参数`} value={String(values[`${setting.key}:inputs`]??"")} onChange={event=>onChange(`${setting.key}:inputs`,event.target.value)}/>}<button className="setting-action" disabled={disabled} onClick={()=>onApply(setting)}>{operating===`${device.id}:${setting.key}`?"执行中":"执行"}</button></div>:
    setting.type==="choice"?<select disabled={disabled} value={String(value??setting.choices?.[0]?.[0]??"")} onChange={event=>{const choice=setting.choices?.find(([candidate])=>String(candidate)===event.target.value);if(choice)onApply(setting,choice[0])}}>{setting.choices?.map(([choice,label])=><option key={String(choice)} value={String(choice)}>{label}</option>)}</select>:
    setting.type==="range"?<div className="range-control"><input type="range" min={setting.min} max={setting.max} step={setting.step||1} disabled={disabled} value={Number(value??setting.min??0)} onChange={event=>onChange(setting.key,Number(event.target.value))} onPointerUp={()=>onApply(setting,Number(values[setting.key]??setting.min??0))} onKeyUp={event=>{if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key))onApply(setting,Number(values[setting.key]??setting.min??0))}}/><small>{String(value??setting.min)}{setting.unit}</small></div>:
    <div className="text-control"><input aria-label={setting.label} disabled={disabled} value={String(value??"")} onChange={event=>onChange(setting.key,event.target.value)}/><button className="setting-action" disabled={disabled} onClick={()=>{const raw=values[setting.key]??"";onApply(setting,/^(u?int|float|double)/.test(setting.format||"")?Number(raw):raw)}}>保存</button></div>}
  </div>
}
function groupSettings(group:SpecGroup):Setting[]{
  const properties:Setting[]=group.properties.filter(property=>property.writable).map(property=>({key:property.key,label:property.label,type:property.format==="bool"?"switch":property.choices?.length?"choice":property.range?"range":"text",siid:property.siid,piid:property.piid,unit:property.unit,min:property.range?.min,max:property.range?.max,step:property.range?.step,choices:property.choices?.map(choice=>[choice.value,choice.label] as [SettingValue,string]),isPower:property.name==="on",format:property.format}));
  const actions:Setting[]=group.actions.map(action=>({key:action.key,label:action.label,type:"action",siid:action.siid,aiid:action.aiid,inputs:action.inputs}));
  return[...properties,...actions];
}
function formatPropertyValue(property:SpecProperty,value:SettingValue|undefined){if(value===undefined)return"未读取";const choice=property.choices?.find(item=>item.value===value);if(choice)return choice.label;if(typeof value==="boolean")return value?"开启":"关闭";return`${value}${property.unit||""}`}
function deviceKindLabel(kind:string){return({light:"灯光",lamp:"灯光",aircondition:"空调",acpartner:"空调伴侣",airpurifier:"空气净化器",vacuum:"扫拖机器人",fan:"风扇",lock:"智能门锁",curtain:"窗帘",humidifier:"加湿器",plug:"智能插座",switch:"智能开关",camera:"摄像头",sensor:"传感器"} as Record<string,string>)[kind]||"智能设备"}
function deviceSettings(device:Device):Setting[]{
  if(isControlDevice(device))return[];
  const power:Setting={key:"power",label:"电源开关",type:"switch",siid:2,piid:1};
  if(["light","lamp"].includes(device.kind))return[power,{key:"brightness",label:"亮度",type:"range",siid:2,piid:2,min:1,max:100,unit:"%"},{key:"temperature",label:"色温",type:"range",siid:2,piid:3,min:2700,max:6500,step:100,unit:"K"}];
  if(["aircondition","acpartner"].includes(device.kind))return[power,{key:"mode",label:"工作模式",type:"choice",siid:2,piid:2,choices:[[0,"自动"],[1,"制冷"],[2,"制热"],[3,"除湿"],[4,"送风"]]},{key:"target",label:"目标温度",type:"range",siid:2,piid:4,min:16,max:30,unit:"°C"}];
  if(device.kind==="airpurifier")return[power,{key:"mode",label:"净化模式",type:"choice",siid:2,piid:4,choices:[[0,"自动"],[1,"睡眠"],[2,"收藏"],[3,"强力"]]},{key:"speed",label:"风速档位",type:"range",siid:2,piid:5,min:1,max:3,unit:" 档"}];
  if(device.kind==="fan")return[power,{key:"speed",label:"风速档位",type:"range",siid:2,piid:2,min:1,max:4,unit:" 档"},{key:"oscillation",label:"左右摇头",type:"switch",siid:2,piid:3}];
  if(device.kind==="humidifier")return[power,{key:"humidity",label:"目标湿度",type:"range",siid:2,piid:6,min:30,max:80,step:5,unit:"%"},{key:"mode",label:"加湿模式",type:"choice",siid:2,piid:5,choices:[[0,"自动"],[1,"低档"],[2,"中档"],[3,"高档"]]}];
  if(device.kind==="vacuum")return[{key:"start",label:"开始清扫",type:"action",siid:2,aiid:1},{key:"pause",label:"暂停清扫",type:"action",siid:2,aiid:2},{key:"charge",label:"返回充电",type:"action",siid:3,aiid:1},{key:"mode",label:"清扫模式",type:"choice",siid:2,piid:3,choices:[[0,"安静"],[1,"标准"],[2,"强力"],[3,"最大"]]}];
  if(device.kind==="curtain")return[{key:"position",label:"窗帘开合度",type:"range",siid:2,piid:2,min:0,max:100,unit:"%"}];
  if(["plug","switch"].includes(device.kind))return[power];
  return[];
}
function friendlyError(error:string){if(error==="SESSION_SECRET_NOT_CONFIGURED")return"网站会话加密尚未配置";if(error==="XIAOMI_QR_UNAVAILABLE")return"小米暂未返回登录二维码";if(error==="XIAOMI_QR_EXPIRED")return"二维码已过期，请重新获取";if(error==="XIAOMI_SERVICE_TOKEN_MISSING")return"登录成功，但未能取得米家服务令牌";if(error==="XIAOMI_NOT_CONNECTED")return"登录状态已失效，请重新扫码";if(error==="XIAOMI_CLOUD_TIMEOUT")return"米家云响应超时，请确认服务器区域后重试";if(error==="XIAOMI_CLOUD_RESPONSE_INVALID"||error==="XIAOMI_DEVICE_RESPONSE_INVALID")return"米家云返回的数据无法识别";if(error==="MIOT_SPEC_MODEL_NOT_FOUND")return"该型号尚未公开 MIoT 设备规格";if(error==="MIOT_SPEC_RESPONSE_INVALID"||error==="MIOT_SPEC_UNAVAILABLE")return"设备规格服务暂不可用";if(error==="INVALID_ACTION_PARAMETERS")return"请按要求输入正确数量的 JSON 参数";if(error==="BINDING_ACTION_TARGET_UNSUPPORTED")return"该型号没有公开可写目标设备参数";if(error==="BINDING_ACTION_CHANNEL_UNSUPPORTED"||error==="BINDING_ACTION_CHANNEL_MISSING")return"该型号未公开普通灯所需的有线回路参数";if(error==="BINDING_ACTION_PARAMETERS_UNKNOWN")return"绑定动作包含未公开含义的厂商参数";if(error==="XIAOMI_CLOUD_HTTP_401")return"米家登录已失效，请重新扫码登录";if(error==="XIAOMI_CLOUD_HTTP_403")return"米家云拒绝访问，请重新登录并确认所在区域";if(error.startsWith("XIAOMI_PROPERTY_CODE_"))return`设备未接受该设置，错误码 ${error.slice("XIAOMI_PROPERTY_CODE_".length)}`;if(error.startsWith("MIOT_SPEC_HTTP_"))return`设备规格服务返回 HTTP ${error.split("_").pop()}`;if(error.startsWith("XIAOMI_CLOUD_HTTP_"))return`米家云返回 HTTP ${error.split("_").pop()}`;if(error.startsWith("XIAOMI_CLOUD_CODE_"))return`米家云错误 ${error.split("_").pop()}，请确认服务器区域`;return`连接米家云失败：${error||"未知错误"}`}
