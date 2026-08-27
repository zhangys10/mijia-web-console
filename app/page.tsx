"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import DeviceManagement from "./device-management";
import { isDeviceGroupId } from "../lib/device-groups";
import { buildActiveDeviceGroups, type ActiveDeviceGroup, type ActiveDeviceItem, type ManagedDevice, type ManagedPowerControl } from "../lib/device-management";
import type { DeviceControlSource, DeviceTopology } from "../lib/device-topology";
import { classifyDeviceKind, findPhysicalDevice, inferHardwareRole, isControlDevice, isIndependentSmartDevice, listSwitchChannelTargets, samePhysicalDevice, selectDeviceView, type SwitchChannelTarget } from "../lib/device-views";
import { buildBindingActionParameters, listSwitchBindingTargets, type BindingAction, type SwitchBindingCapability, type SwitchBindingTarget } from "../lib/switch-bindings";
import { findSwitchGroupChannel, switchGroupConnection, switchGroupMatches } from "../lib/switch-channel-mode";
import type { ManualScene } from "../lib/xiaomi-scenes";

type Device = ManagedDevice;
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
type SceneLoadState = { loading:boolean;items:ManualScene[];error?:string };

const demo:Device[]=[
  {id:1,name:"客厅吸顶灯",home:"我的家",homeId:"demo",room:"客厅",kind:"light",icon:"☀",on:true,status:"已开启",detail:"yeelink.light.demo",color:"orange",online:true},
  {id:2,name:"米家空调",home:"我的家",homeId:"demo",room:"客厅",kind:"aircondition",icon:"❄",on:true,status:"制冷中",detail:"xiaomi.aircondition.demo",color:"blue",online:true},
  {id:3,name:"扫拖机器人",home:"我的家",homeId:"demo",room:"客厅",kind:"vacuum",icon:"◎",on:false,status:"充电中",detail:"xiaomi.vacuum.demo",color:"green",online:true},
  {id:4,name:"床头灯",home:"我的家",homeId:"demo",room:"主卧",kind:"lamp",icon:"♢",on:false,status:"已关闭",detail:"yeelink.lamp.demo",color:"violet",online:true},
  {id:5,name:"空气净化器",home:"我的家",homeId:"demo",room:"主卧",kind:"airpurifier",icon:"≈",on:true,status:"自动模式",detail:"zhimi.airpurifier.demo",color:"cyan",online:true},
  {id:6,name:"智能门锁",home:"我的家",homeId:"demo",room:"玄关",kind:"lock",icon:"▣",on:null,status:"已上锁",detail:"xiaomi.lock.demo",color:"slate",online:true},
  {id:7,name:"客厅三开",home:"我的家",homeId:"demo",room:"客厅",kind:"switch",icon:"ϟ",on:null,status:"在线",detail:"xiaomi.switch.demo3",color:"orange",online:true,hardwareRole:"switch"},
  {id:8,name:"主卧中控",home:"我的家",homeId:"demo",room:"主卧",kind:"switch",icon:"ϟ",on:null,status:"在线",detail:"xiaomi.switch.panel",color:"violet",online:true,hardwareRole:"switch"},
  {id:9,name:"客厅中控",home:"我的家",homeId:"demo",room:"客厅",kind:"switch",icon:"▤",on:null,status:"在线",detail:"xiaomi.controller.oh4w",color:"blue",online:true,hardwareRole:"controller"},
];

const demoScenes:ManualScene[]=[
  {id:"demo-home",homeId:"demo",name:"回家",icon:"⌂",enabled:true,actionCount:2,actions:[{order:1,label:"开启",deviceName:"玄关灯",details:[{kind:"power",label:"电源",value:"开启",state:"on"}]},{order:2,label:"舒适模式",deviceName:"客厅空调",details:[{kind:"property",label:"温度",value:"24°C"}]}]},
  {id:"demo-away",homeId:"demo",name:"离家",icon:"↗",enabled:true,actionCount:2,actions:[{order:1,label:"关闭全部照明",deviceName:"全屋灯具",details:[{kind:"power",label:"电源",value:"关闭",state:"off"}]},{order:2,label:"布防",deviceName:"家庭安防",details:[]}]},
  {id:"demo-movie",homeId:"demo",name:"观影",icon:"▷",enabled:true,actionCount:3,actions:[{order:1,label:"关闭",deviceName:"客厅主灯",details:[{kind:"power",label:"电源",value:"关闭",state:"off"}]},{order:2,label:"调暗",deviceName:"电视背景灯",details:[{kind:"brightness",label:"亮度",value:"20%"}]},{order:3,label:"关闭",deviceName:"客厅窗帘",details:[]}]},
  {id:"demo-night",homeId:"demo",name:"晚安",icon:"☾",enabled:true,actionCount:3,actions:[{order:1,label:"关闭全部照明",deviceName:"全屋灯具",details:[{kind:"power",label:"电源",value:"关闭",state:"off"}]},{order:2,label:"睡眠模式",deviceName:"主卧空调",details:[{kind:"property",label:"温度",value:"26°C"}]},{order:3,label:"上锁",deviceName:"智能门锁",details:[]}]},
];

const regionLabels:Record<string,string>={cn:"中国大陆",sg:"新加坡",de:"欧洲",us:"美国",ru:"俄罗斯",i2:"印度"};

export default function Home(){
  const [devices,setDevices]=useState(demo),[homes,setHomes]=useState<XiaomiHome[]>([{id:"demo",name:"我的家"}]),[selectedHome,setSelectedHome]=useState("demo"),[room,setRoom]=useState("全屋"),[tab,setTab]=useState("首页"),[toast,setToast]=useState(""),[authOpen,setAuthOpen]=useState(false),[region,setRegion]=useState("cn"),[connection,setConnection]=useState<Connection>({loading:true,connected:false}),[qr,setQr]=useState<Qr>({loading:false}),[syncing,setSyncing]=useState(false),[qrSeconds,setQrSeconds]=useState(0),[selectedDevice,setSelectedDevice]=useState<Device|null>(null),[settingValues,setSettingValues]=useState<Record<string,SettingValue>>({}),[operating,setOperating]=useState(""),[deviceSpec,setDeviceSpec]=useState<DeviceSpecification>({loading:false,groups:[]}),[focusedMapping,setFocusedMapping]=useState<Device|null>(null),[scenesByHome,setScenesByHome]=useState<Record<string,SceneLoadState>>({demo:{loading:false,items:demoScenes}}),[sceneOperating,setSceneOperating]=useState(""),[selectedScene,setSelectedScene]=useState<ManualScene|null>(null);
  const polling=useRef(false),specRequest=useRef(0),sceneGeneration=useRef(0);
  const homeDevices=useMemo(()=>devices.filter(device=>device.homeId===selectedHome),[devices,selectedHome]);
  const hardwareDevices=useMemo(()=>selectDeviceView(homeDevices,"hardware"),[homeDevices]);
  const activeDeviceGroups=useMemo(()=>buildActiveDeviceGroups(homeDevices),[homeDevices]);
  const activeDeviceCount=useMemo(()=>activeDeviceGroups.reduce((count,group)=>count+group.items.length,0),[activeDeviceGroups]);
  const currentHome=homes.find(home=>home.id===selectedHome)??homes[0];
  const rooms=useMemo(()=>["全屋",...Array.from(new Set(homeDevices.map(d=>d.room)))],[homeDevices]);
  const sceneState=scenesByHome[selectedHome]??{loading:connection.connected,items:[]};
  const currentScenes=connection.connected?(selectedHome==="demo"?[]:sceneState.items):demoScenes;
  const quickScenes=currentScenes.slice(0,4);

  const message=(text:string)=>{setToast(text);window.setTimeout(()=>setToast(""),2600)};

  async function loadScenes(homeId:string,notifyOnError=false){
    if(homeId==="demo")return;
    const generation=sceneGeneration.current;
    setScenesByHome(states=>({...states,[homeId]:{loading:true,items:states[homeId]?.items??[]}}));
    try{
      const response=await fetch(`/api/xiaomi/scenes?homeId=${encodeURIComponent(homeId)}`);
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"XIAOMI_SCENE_SYNC_FAILED");
      if(generation!==sceneGeneration.current)return;
      const items=Array.isArray(data.scenes)?data.scenes as ManualScene[]:[];
      setScenesByHome(states=>({...states,[homeId]:{loading:false,items}}));
    }catch(error){
      if(generation!==sceneGeneration.current)return;
      const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";
      setScenesByHome(states=>({...states,[homeId]:{loading:false,items:states[homeId]?.items??[],error:reason}}));
      if(notifyOnError)message(`场景同步失败：${friendlyError(reason)}`);
    }
  }

  async function loadDevices(notify=false,preserveRoom=false){
    const response=await fetch("/api/xiaomi/devices");
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||"XIAOMI_DEVICE_SYNC_FAILED");
    const icons:Record<string,string>={light:"☀",lamp:"♢",aircondition:"❄",acpartner:"❄",airpurifier:"≈",vacuum:"◎",fan:"≈",lock:"▣",curtain:"▥",humidifier:"◌",plug:"ϟ",switch:"ϟ",camera:"◉",sensor:"↗"};
    const mapped:Device[]=data.devices.map((device:{did:string;name:string;home:string;homeId:string;room:string;model:string;logicalType?:string;online:boolean;on?:boolean|null;parentId?:string|null;urn?:string|null;topology?:DeviceTopology|null;groupMemberIds?:string[];groupIds?:string[];powerControl?:ManagedPowerControl|null},index:number)=>{const type=classifyDeviceKind(device.model,device.name,device.logicalType);const on=typeof device.on==="boolean"?device.on:null;const status=!device.online?"离线":device.on===true?"已开启":device.on===false?"已关闭":"状态待确认";return{id:index+100,did:device.did,name:device.name,home:device.home||"我的家",homeId:device.homeId||"default",room:device.room||"未分配",kind:type,icon:isDeviceGroupId(device.did)?"◫":icons[type]||"↗",on,status,detail:device.model||"米家设备",color:["orange","blue","green","violet","cyan"][index%5],online:device.online,parentId:device.parentId,urn:device.urn,logicalType:device.logicalType,hardwareRole:inferHardwareRole(device.model,device.name),topology:device.topology,groupMemberIds:device.groupMemberIds,groupIds:device.groupIds,powerControl:device.powerControl??undefined}});
    const nextHomes:XiaomiHome[]=Array.isArray(data.homes)&&data.homes.length?data.homes.map((home:{id:string;name:string})=>({id:String(home.id),name:home.name})):Array.from(new Map(mapped.map(device=>[device.homeId,{id:device.homeId,name:device.home}])).values());
    setHomes(nextHomes);
    const nextHomeId=nextHomes.some(home=>home.id===selectedHome)?selectedHome:(nextHomes[0]?.id||"default");
    setSelectedHome(nextHomeId);
    if(!preserveRoom)setRoom("全屋");
    setDevices(mapped);
    if(notify)message(`已同步 ${nextHomes.length} 个家庭、${mapped.length} 台米家设备`);
    return nextHomeId;
  }

  async function syncDevices(){
    if(syncing)return;
    setSyncing(true);
    message("正在同步米家设备…");
    try{const homeId=await loadDevices(true);await loadScenes(homeId,true);setConnection(state=>({...state,error:undefined}))}
    catch(error){const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";setConnection(state=>({...state,error:reason}));message(`同步失败：${friendlyError(reason)}`)}
    finally{setSyncing(false)}
  }

  function selectHome(homeId:string){
    if(homeId===selectedHome)return;
    specRequest.current++;
    setSelectedHome(homeId);setSelectedScene(null);setSelectedDevice(null);setFocusedMapping(null);setRoom("全屋");
    if(connection.connected)void loadScenes(homeId);
  }

  async function checkSession(){
    try{const response=await fetch("/api/xiaomi/status");const result=await response.json();if(result.connected){setConnection({loading:false,connected:true,region:result.region,userId:result.userId});setRegion(result.region);try{const homeId=await loadDevices();await loadScenes(homeId,true)}catch(error){const reason=error instanceof Error?error.message:"UNKNOWN_ERROR";setConnection(state=>({...state,error:reason}));message(`设备同步失败：${friendlyError(reason)}`)}}else setConnection({loading:false,connected:false})}
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

  async function closeActiveDevice(item:ActiveDeviceItem<Device>){
    if(operating)return;
    const operation=`active:${item.key}`;
    if(!connection.connected){
      setDevices(list=>list.map(device=>item.stateDeviceIds.includes(device.id)?{...device,on:false,status:"已关闭"}:device));
      message(`${item.name} 演示已关闭`);
      return;
    }
    if(!item.powerControl){message(`${item.name} 未公开可写电源属性`);return}
    setOperating(operation);
    try{
      const response=await fetch("/api/xiaomi/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...item.powerControl,value:false})});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error);
      setDevices(list=>list.map(device=>item.stateDeviceIds.includes(device.id)?{...device,on:false,status:"已关闭"}:device));
      message(`${item.name} 已关闭`);
    }catch(error){message(`关闭失败：${friendlyError(error instanceof Error?error.message:"UNKNOWN_ERROR")}`)}
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
    setSelectedDevice(device);setFocusedMapping(mappedDevice??null);setSettingValues(device.on===null?{}:{power:device.on});setDeviceSpec({loading:Boolean(device.did),groups:[]});
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
      const allWireless=switchGroups.length>0&&switchGroups.every(group=>switchGroupConnection(group,groups,values,device.topology)==="wireless");
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

  async function runScene(scene:ManualScene){
    if(!scene.enabled||sceneOperating)return;
    if(!connection.connected){message(`${scene.name} 演示已执行`);if(scene.id==="demo-away")setDevices(list=>list.map(d=>["light","lamp","aircondition","airpurifier","fan"].includes(d.kind)?{...d,on:false,status:"已关闭"}:d));return}
    setSceneOperating(scene.id);
    try{
      const response=await fetch("/api/xiaomi/scenes/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({homeId:selectedHome,sceneId:scene.id})});
      const result=await response.json();
      if(!response.ok||!result.accepted)throw new Error(result.error||"XIAOMI_SCENE_NOT_ACCEPTED");
      message(`${scene.name} 已下发到米家云`);
    }catch(error){message(`场景执行失败：${friendlyError(error instanceof Error?error.message:"UNKNOWN_ERROR")}`)}
    finally{setSceneOperating("")}
  }
  function openLogin(){setAuthOpen(true);if(!connection.connected&&!qr.imageUrl&&!qr.loading)void startLogin()}
  async function logout(){await fetch("/api/xiaomi/status",{method:"DELETE"});polling.current=false;specRequest.current++;sceneGeneration.current++;setConnection({loading:false,connected:false});setDevices(demo);setHomes([{id:"demo",name:"我的家"}]);setSelectedHome("demo");setScenesByHome({demo:{loading:false,items:demoScenes}});setSceneOperating("");setSelectedScene(null);setSelectedDevice(null);setFocusedMapping(null);setDeviceSpec({loading:false,groups:[]});setQr({loading:false});setAuthOpen(false);message("已断开米家云连接")}

  return <main className="shell">
    <aside className="sidebar"><div className="brand"><b>mi</b><div><strong>米家控制台</strong><small>{connection.connected?regionLabels[connection.region||"cn"]:"米家云直连"}</small></div></div><nav>{[["首页","⌂"],["设备","▦"],["场景","✦"],["自动化","⌁"],["能耗","ϟ"]].map(([name,icon])=><button key={name} className={tab===name?"active":""} onClick={()=>setTab(name)}><i>{icon}</i>{name}</button>)}</nav><div className="sidefoot"><div className={`mode ${connection.connected?"connected":""}`}><span/><div><strong>{connection.loading?"检查连接中":connection.connected?"米家云已连接":"演示模式"}</strong><small>{connection.connected?`账号 ${connection.userId}`:"扫码登录以同步真实设备"}</small></div></div><button className="settings" onClick={openLogin}>⚙　账号与连接</button><div className="profile"><b>R</b><div><strong>Ryan</strong><small>家庭管理员</small></div><i>⋯</i></div></div></aside>

    <section className="workspace"><header className="workspace-header"><div className="header-copy"><p>2026年8月25日 · 星期二</p><h1>{tab==="首页"?"早上好，Ryan":tab}</h1></div><div className="header-controls"><HomeSelector homes={homes} selectedHome={selectedHome} devices={devices} onSelect={selectHome}/><div className="actions"><button aria-label="搜索">⌕</button><button aria-label="通知">♢</button><button className="mobile-account" aria-label="账号与连接" onClick={openLogin}>⚙</button><button className="primary" disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"↻ 同步中…":connection.connected?"↻ 同步设备":"＋ 连接米家"}</button></div></div></header>

    {tab==="首页"?<>
      <Title title="当前运行" sub={`${currentHome?.name??"当前家庭"} · ${activeDeviceCount} 台设备正在运行`} action="管理设备 →" onAction={()=>setTab("设备")}/>
      <ActiveDeviceList groups={activeDeviceGroups} connected={connection.connected} operating={operating} onOpen={(device,mappedDevice)=>void openDevice(device,mappedDevice)} onClose={item=>void closeActiveDevice(item)} onManage={()=>setTab("设备")}/>
      <Title title="快捷场景" sub={connection.connected?"当前家庭的真实手动场景":"演示场景 · 连接米家后显示真实数据"} action="管理场景 →" onAction={()=>setTab("场景")}/><SceneStateMessage loading={connection.connected&&sceneState.loading} error={connection.connected?sceneState.error:undefined}/><section className="scenes">{quickScenes.map((scene,index)=><SceneCard key={scene.id} scene={scene} tone={["orange","blue","violet","indigo"][index%4]} connected={connection.connected} running={sceneOperating===scene.id} blocked={Boolean(sceneOperating)} compact onOpen={()=>setSelectedScene(scene)} onRun={item=>void runScene(item)}/>)}</section>{!sceneState.loading&&!sceneState.error&&quickScenes.length===0&&<SceneStateMessage empty/>}
    </>:tab==="设备"?<DeviceManagement key={selectedHome} devices={homeDevices} room={room} connected={connection.connected} onSelectRoom={setRoom} onOpenDevice={(device,mappedDevice)=>void openDevice(device,mappedDevice)}/>:tab==="场景"?<Panel title="场景中心" text={connection.connected?"点击卡片查看详情；仅独立的执行按钮会运行场景。":"当前为演示数据，点击卡片查看详情。"}><SceneStateMessage loading={connection.connected&&sceneState.loading} error={connection.connected?sceneState.error:undefined} empty={!sceneState.loading&&currentScenes.length===0}/><div className="panel-grid scene-list">{currentScenes.map((scene,index)=><SceneCard key={scene.id} scene={scene} tone={["orange","blue","violet","indigo"][index%4]} connected={connection.connected} running={sceneOperating===scene.id} blocked={Boolean(sceneOperating)} onOpen={()=>setSelectedScene(scene)} onRun={item=>void runScene(item)}/>)}</div></Panel>:tab==="自动化"?<Panel title="自动化" text={`${currentHome?.name??"当前家庭"} · 根据时间、环境和设备状态，让家自动响应。`}><Rule a="日落后" b="有人回家" c="打开玄关灯"/><Rule a="每日 23:30" b="门锁已上锁" c="执行晚安"/></Panel>:<Panel title="家庭能耗" text={`${currentHome?.name??"当前家庭"} · 查看设备用电趋势，发现节能空间。`}><div className="chart">{[44,62,52,78,68,90,64].map((height,index)=><i key={index} style={{height:`${height}%`}}/>)}</div><div className="labels">{["周一","周二","周三","周四","周五","周六","今天"].map(day=><span key={day}>{day}</span>)}</div></Panel>}</section>

    <aside className="rightbar"><div className={`api ${connection.connected?"cloud-live":""}`}><div className="api-title"><span>⌁</span><div><strong>米家云</strong><small>{connection.connected?`${regionLabels[connection.region||"cn"]} · 已连接`:"扫码授权 · 直接连接"}</small></div></div><p>{connection.error?`最近同步失败：${friendlyError(connection.error)}`:connection.connected?`已连接小米账号 ${connection.userId}，可以同步家庭、房间与设备。`:"使用米家 App 扫描官方账号二维码登录，无需 Home Assistant，也无需输入账号密码。"}</p><button disabled={syncing} onClick={connection.connected?()=>void syncDevices():openLogin}>{syncing?"正在同步设备…":connection.connected?"立即同步设备":"扫码连接米家"} <b>→</b></button></div><Title title="最近动态" sub={`${currentHome?.name??"当前家庭"} · 设备记录`} action="···"/><div className="timeline"><Activity icon="⌂" tone="orange" title="执行「回家」场景" text="3 台设备已响应" time="2 分钟前"/><Activity icon="✓" tone="green" title="智能门锁已上锁" text="通过指纹 · 家庭成员" time="18 分钟前"/><Activity icon="↗" tone="blue" title="空调已调至 24°C" text="自动化 · 舒适温度" time="1 小时前"/><Activity icon="◎" tone="violet" title="扫拖机器人完成清洁" text="清洁 42㎡ · 用时 38 分钟" time="3 小时前"/></div><button className="all">查看全部动态</button><div className="home-status"><div><strong>{currentHome?.name??"家庭状态"}</strong><span>{connection.connected?"米家云在线":"演示数据"}</span></div><section><Status icon="◈" n={String(homeDevices.length)} label="设备总数"/><Status icon="ϟ" n={String(activeDeviceCount)} label="运行中"/><Status icon="⌁" n={String(rooms.length-1)} label="房间"/></section></div></aside>

    {selectedScene&&<div className="modal-bg" onMouseDown={()=>setSelectedScene(null)}><div className="modal scene-modal" onMouseDown={event=>event.stopPropagation()}>
      <button className="close" aria-label="关闭场景详情" onClick={()=>setSelectedScene(null)}>×</button>
      <div className="scene-modal-scroll"><SceneInformation scene={selectedScene} homeName={homes.find(home=>home.id===selectedScene.homeId)?.name||"当前家庭"}/></div>
      <button className="scene-modal-run" disabled={!selectedScene.enabled||Boolean(sceneOperating)} aria-busy={sceneOperating===selectedScene.id} onClick={()=>void runScene(selectedScene)}>{sceneOperating===selectedScene.id?"执行中…":connection.connected?"执行场景":"执行演示"}</button>
    </div></div>}

    {selectedDevice&&<div className="modal-bg" onMouseDown={()=>{specRequest.current++;setSelectedDevice(null)}}><div className="modal device-modal" onMouseDown={event=>event.stopPropagation()}>
      <button className="close" onClick={()=>{specRequest.current++;setSelectedDevice(null)}}>×</button>
      <div className="device-modal-head"><span className={selectedDevice.color}>{selectedDevice.icon}</span><div><h2>{selectedDevice.name}</h2><p>{selectedDevice.home} · {selectedDevice.room} · {selectedDevice.online?"在线":"离线"}</p></div></div>
      <div className="device-identity"><div><small>设备类型</small><strong>{deviceKindLabel(selectedDevice.kind)}</strong></div><div><small>设备型号</small><strong>{selectedDevice.detail}</strong></div>{selectedDevice.did&&<div><small>设备 ID</small><strong>{selectedDevice.did}</strong></div>}</div>
      {(focusedMapping||selectedDevice.topology&&selectedDevice.topology.role!=="independent"||Boolean(selectedDevice.topology?.controlledBy.length))&&<div className="modal-topology"><div><strong>设备控制拓扑</strong>{selectedDevice.topology?.role&&selectedDevice.topology.role!=="independent"&&<TopologyBadge role={selectedDevice.topology.role} connectionType={selectedDevice.topology.connectionType}/>}</div>{focusedMapping&&<p><b>{selectedDevice.name}</b><span>›</span><b>{focusedMapping.topology?.channelLabel||"关联按键"}</b><span>›</span><b>{focusedMapping.name}</b></p>}{selectedDevice.topology?.parentName&&!focusedMapping&&<p><b>{selectedDevice.topology.parentName}</b><span>›</span><b>{selectedDevice.topology.channelLabel||"关联按键"}</b><span>›</span><b>{selectedDevice.name}</b></p>}{focusedMapping&&Boolean(focusedMapping.topology?.controlledBy.length)&&<ControlSources sources={focusedMapping.topology!.controlledBy} devices={hardwareDevices} onOpen={item=>void openDevice(item)}/>} {!focusedMapping&&Boolean(selectedDevice.topology?.controlledBy.length)&&<ControlSources sources={selectedDevice.topology!.controlledBy} devices={hardwareDevices} onOpen={item=>void openDevice(item)}/>}</div>}
      {isControlDevice(selectedDevice)&&deviceSpec.binding&&!deviceSpec.loading&&<SwitchBindingPanel key={selectedDevice.did??selectedDevice.id} device={selectedDevice} specification={deviceSpec} devices={homeDevices} values={settingValues} operating={operating} onBind={(action,target,sourceKey)=>void applySwitchBinding(selectedDevice,action,target,sourceKey)} onProperty={(property,target)=>void applySetting(selectedDevice,{key:property.key,label:`绑定 ${target.name}`,type:"text",siid:property.siid,piid:property.piid,format:property.format},target.did)} onPair={action=>void applySetting(selectedDevice,{key:action.key,label:action.label,type:"action",siid:action.siid,aiid:action.aiid,inputs:action.inputs})}/>}
      <div className="settings-heading"><strong>型号实际支持的设置</strong><span>{deviceSpec.loading?"读取中…":`${deviceSpec.groups.length?deviceSpec.groups.reduce((count,group)=>count+group.properties.filter(property=>property.writable).length+group.actions.length,0):deviceSettings(selectedDevice).length} 项`}</span></div>
      {deviceSpec.loading?<div className="spec-loading"><span/>正在解析设备公开规格和按键功能</div>:deviceSpec.groups.length?<div className="spec-groups">{deviceSpec.groups.map(group=>{
        const settings=groupSettings(group),readonly=group.properties.filter(property=>property.readable&&!property.writable),mapped=groupRelatedDevices(selectedDevice,group,deviceSpec.groups,homeDevices),bindings=groupBindings(selectedDevice,group,deviceSpec.groups);
        const relatedChannel=findSwitchGroupChannel(group,deviceSpec.groups,selectedDevice.topology);
        const relatedTargets=groupDisplayTargets(relatedChannel,mapped,bindings,homeDevices);
        const relations=new Set(relatedChannel?.edges.map(edge=>edge.relation)??[]);
        const hasWireless=relations.has("wireless-control"),hasPower=relations.has("wired-smart-light-power"),hasWiredLoad=relations.has("wired-load"),hasUnknownRelation=relations.has("unknown");
        const channelConnection=switchGroupConnection(group,deviceSpec.groups,settingValues,selectedDevice.topology),wireless=channelConnection==="wireless",unknownMode=channelConnection==="unknown";
        const unconfigured=relatedChannel?.controlObjects.some(item=>item.targetKind==="unconfigured")??false;
        const controlStatus=relatedChannel?.classification;
        const wirelessUnconfigured=controlStatus==="wireless-unconfigured",controlUnavailable=controlStatus==="control-data-unavailable",controlFailed=controlStatus==="control-data-failed",controlIncomplete=controlStatus==="control-data-incomplete",inferredWired=controlStatus==="inferred-wired";
        const channelRelationLabel=hasWireless&&hasPower?"无线控制 + 有线供电":hasWireless?"无线控制":hasPower?"有线供电":inferredWired?"有线回路（推定）":hasWiredLoad?"有线直连":wirelessUnconfigured?"无线模式未配置":controlUnavailable?"控制设备结果不可用":controlFailed?"控制设备查询失败":controlIncomplete?"控制设备结果不完整":unconfigured?"未配置":hasUnknownRelation||unknownMode?"关系待确认":wireless?"无线控制":"关系待确认";
        const channelTargetLabel=hasWireless&&hasPower?"这个按键无线控制目标，并由继电器提供有线电源":hasWireless?"这个按键无线控制的目标":hasPower?"这个按键继电器供电的智能灯":inferredWired?"由继电器模式和已确认的物理端点推定为有线回路":hasWiredLoad?"这个按键有线连接的普通回路":wirelessUnconfigured?"这个按键处于无线模式，控制对象确认未配置":controlUnavailable?"米家云未提供可确认完整性的控制设备结果":controlFailed?"控制设备查询失败，不能判断为无绑定":controlIncomplete?"控制设备结果不完整，不能判断为无绑定":unconfigured?"这个按键尚未配置控制对象":"这个按键的控制对象或连接关系尚未确认";
        return <details className={`spec-group ${focusedMapping&&mapped.some(device=>device.id===focusedMapping.id)?"focused-group":""}`} key={group.key} open={group.name==="switch"||/panel|binding|relay|wireless|mutual/.test(group.name)||deviceSpec.groups.length<=3}>
          <summary><strong>{group.label}{group.name==="switch"&&<span className={`channel-role ${unconfigured?"unknown":hasWireless&&hasPower?"mixed":hasWireless?"wireless":hasWiredLoad||hasPower?"wired":"unknown"}`}>{channelRelationLabel}</span>}</strong><small>{relatedTargets.length?`${relatedTargets.map(item=>item.name).join("、")} · `:""}{settings.length?`${settings.length} 项设置`:"状态与事件"}{group.events.length?` · ${group.events.length} 个事件`:""}</small></summary>
          {group.name==="switch"&&<div className={`channel-targets ${relatedTargets.length?"":"unbound"}`}><span>{channelTargetLabel}</span>{relatedTargets.length?relatedTargets.map(item=>item.smart&&item.device?<button className="channel-smart-target" key={item.id} type="button" onClick={()=>void openDevice(item.device!)}><strong>{item.name}</strong><small>{item.room} · 查看智能灯具 ›</small></button>:<strong key={item.id}>{item.name}<small>{item.room}</small></strong>):<small>{wirelessUnconfigured?"已确认没有配置控制对象":controlUnavailable?"未获得可验证的控制设备数据":controlFailed?"查询失败，请稍后同步重试":controlIncomplete?"返回内容不足以确认是否绑定":"控制对象尚未确认"}</small>}</div>}
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

function HomeSelector({homes,selectedHome,devices,onSelect}:{homes:XiaomiHome[];selectedHome:string;devices:Device[];onSelect:(homeId:string)=>void}){
  const [open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null);
  const selected=homes.find(home=>home.id===selectedHome)??homes[0],deviceCount=devices.filter(device=>device.homeId===selected?.id).length;
  useEffect(()=>{
    if(!open)return;
    const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false)};
    const escape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};
    document.addEventListener("pointerdown",close);document.addEventListener("keydown",escape);
    return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("keydown",escape)};
  },[open]);
  return <div className={`home-selector ${open?"open":""}`} ref={root}><button type="button" className="home-selector-trigger" aria-label="选择家庭" aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><span className="home-selector-icon">⌂</span><span className="home-selector-copy"><small>当前家庭</small><strong title={selected?.name}>{selected?.name??"选择家庭"}</strong></span><span className="home-selector-meta">{deviceCount} 台</span><span className="home-selector-chevron">⌄</span></button>{open&&<div className="home-selector-menu" role="listbox" aria-label="家庭列表">{homes.map(home=>{const active=home.id===selectedHome,count=devices.filter(device=>device.homeId===home.id).length;return <button type="button" role="option" aria-selected={active} className={active?"selected":""} key={home.id} onClick={()=>{onSelect(home.id);setOpen(false)}}><span className="home-option-icon">{active?"✓":"⌂"}</span><span><strong>{home.name}</strong><small>{count} 台设备</small></span>{active&&<em>当前</em>}</button>})}</div>}</div>
}
function ActiveDeviceList({groups,connected,operating,onOpen,onClose,onManage}:{groups:ActiveDeviceGroup<Device>[];connected:boolean;operating:string;onOpen:(device:Device,mappedDevice?:Device)=>void;onClose:(item:ActiveDeviceItem<Device>)=>void;onManage:()=>void}){
  if(!groups.length)return <div className="active-empty"><span>✓</span><div><strong>当前没有运行中的设备</strong><p>所有已同步设备都已关闭，或暂时没有可确认的开关状态。</p></div><button type="button" onClick={onManage}>查看全部设备</button></div>;
  return <div className="active-room-list">{groups.map(group=><section className="active-room" key={group.room}><header><strong>{group.room}</strong><span>{group.items.length} 台运行中</span></header><div className="active-device-grid">{group.items.map(item=>{
    const operation=`active:${item.key}`,closing=operating===operation,unavailable=connected&&!item.powerControl;
    return <article className="active-device-card" key={item.key}><button type="button" className="active-device-main" onClick={()=>onOpen(item.device,item.mappedDevice)}><span className={item.color}>{item.icon}</span><span><strong>{item.name}</strong><small>{activeKindLabel(item.kind)} · {item.status}</small></span><b>›</b></button><button type="button" className="active-device-close" disabled={Boolean(operating)||unavailable} title={unavailable?"该设备未公开可写电源属性":"关闭设备"} onClick={()=>onClose(item)}>{closing?"关闭中…":unavailable?"不可关闭":"关闭"}</button></article>})}</div></section>)}</div>;
}
function activeKindLabel(kind:string){return kind==="灯光"||kind==="灯组"?kind:deviceKindLabel(kind)}
function Title(p:{title:string;sub:string;action:string;onAction?:()=>void}){return <div className="title"><div><h2>{p.title}</h2><p>{p.sub}</p></div><button onClick={p.onAction}>{p.action}</button></div>}
function Activity(p:{icon:string;tone:string;title:string;text:string;time:string}){return <div className="activity"><span className={p.tone}>{p.icon}</span><div><strong>{p.title}</strong><p>{p.text}</p><small>{p.time}</small></div></div>}
function Status(p:{icon:string;n:string;label:string}){return <span>{p.icon}<b>{p.n}</b><small>{p.label}</small></span>}
function Panel({title,text,children}:{title:string;text:string;children:React.ReactNode}){return <section className="panel"><div className="panel-title"><span>✦</span><div><h2>{title}</h2><p>{text}</p></div></div>{children}</section>}
function SceneCard({scene,tone,connected,running,blocked,compact,onOpen,onRun}:{scene:ManualScene;tone:string;connected:boolean;running:boolean;blocked:boolean;compact?:boolean;onOpen:()=>void;onRun:(scene:ManualScene)=>void}){return <article className={`scene-card${compact?" compact":""}`} aria-busy={running}>
  <button type="button" className="scene-card-open" aria-label={`查看场景 ${scene.name}`} onClick={onOpen}><span className={tone}>{sceneGlyph(scene)}</span><div><strong>{scene.name}</strong><small>{scene.enabled?`${scene.actionCount} 个动作 · 查看详情`:"已停用 · 查看详情"}</small></div><b>›</b></button>
  <button type="button" className="scene-run" aria-label={`${connected?"执行":"演示"}场景 ${scene.name}`} disabled={!scene.enabled||blocked} onClick={()=>onRun(scene)}>{running?"执行中…":connected?"执行":"演示"}</button>
</article>}
function SceneInformation({scene,homeName}:{scene:ManualScene;homeName:string}){const actions=scene.actions??[];return <>
  <div className="scene-modal-head"><span>{sceneGlyph(scene)}</span><div><small>手动场景</small><h2>{scene.name}</h2><p>{homeName}</p></div></div>
  <div className="scene-details"><div><small>动作数量</small><strong>{scene.actionCount}</strong></div><div><small>场景状态</small><strong>{scene.enabled?"可执行":"已停用"}</strong></div>{scene.updatedAt&&<div><small>更新时间</small><strong>{formatSceneTime(scene.updatedAt)}</strong></div>}</div>
  <section className="scene-flow-section"><div className="scene-flow-title"><div><span>DO</span><strong>动作序列</strong></div><small>按米家场景顺序</small></div>
    {actions.length?<ol className="scene-action-list">{actions.map((action,index)=><li key={`${action.order}:${action.deviceName||"scene"}:${index}`}><span>{action.order}</span><div><strong>{action.deviceName||action.label}</strong>{action.deviceName&&<small>{action.label}</small>}{action.details.length>0&&<div className="scene-action-details">{action.details.map((detail,detailIndex)=><em className={`scene-action-detail ${detail.kind}${detail.state?` ${detail.state}`:""}`} style={sceneActionDetailStyle(detail)} key={`${detail.kind}:${detail.label}:${detailIndex}`}><i>{sceneActionDetailGlyph(detail.kind)}</i><span>{detail.label}</span><b>{detail.value}</b></em>)}</div>}</div></li>)}</ol>:<div className="scene-action-empty">米家仅返回了动作数量，未提供可展示的动作明细。</div>}
  </section>
  <p className="scene-submit-note">下发只表示米家云已接收指令，不代表所有设备已经实际执行。</p>
</>}
function SceneStateMessage({loading,error,empty}:{loading?:boolean;error?:string;empty?:boolean}){if(!loading&&!error&&!empty)return null;return <div className={`scene-state${error?" error":""}`}>{loading?"正在读取米家场景…":error?`场景读取失败：${friendlyError(error)}`:"当前家庭没有可用的手动场景"}</div>}
function sceneGlyph(scene:ManualScene){return scene.icon&&scene.icon.length<=2?scene.icon:"✦"}
function sceneActionDetailGlyph(kind:ManualScene["actions"][number]["details"][number]["kind"]){return kind==="power"?"⏻":kind==="brightness"?"☀":kind==="color-temperature"?"◐":kind==="delay"?"◷":"≡"}
type SceneActionDetailStyle=CSSProperties&{"--scene-detail-accent"?:string;"--scene-detail-level"?:string};
function sceneActionDetailStyle(detail:ManualScene["actions"][number]["details"][number]):SceneActionDetailStyle|undefined{
  const numeric=Number.parseFloat(detail.value);
  if(!Number.isFinite(numeric))return undefined;
  if(detail.kind==="brightness"){
    const level=Math.min(100,Math.max(0,numeric));
    return {"--scene-detail-accent":`hsl(43 88% ${Math.round(38+level*.12)}%)`,"--scene-detail-level":`${level}%`};
  }
  if(detail.kind==="color-temperature"){
    const level=Math.min(1,Math.max(0,(numeric-2700)/(6500-2700)));
    const warm=[244,143,55],cool=[67,145,232];
    const accent=warm.map((channel,index)=>Math.round(channel+(cool[index]-channel)*level));
    return {"--scene-detail-accent":`rgb(${accent.join(" ")})`,"--scene-detail-level":`${Math.round(level*100)}%`};
  }
}
function formatSceneTime(value:string){const numeric=Number(value);const timestamp=Number.isFinite(numeric)?numeric<1e12?numeric*1000:numeric:Date.parse(value);if(!Number.isFinite(timestamp))return value;return new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(timestamp))}
function Rule({a,b,c}:{a:string;b:string;c:string}){return <div className="rule"><span>{a}</span><b>如果</b><span>{b}</span><b>就</b><span>{c}</span><i>已启用</i></div>}
function TopologyBadge({role,connectionType}:{role:DeviceTopology["role"];connectionType?:DeviceTopology["connectionType"]}){if(role==="independent")return null;const label=role==="unknown"||connectionType==="unknown"?"关系待确认":role==="primary"?(connectionType==="mixed"?"有线 / 无线":"有线控制器"):role==="secondary-panel"?"无线控制器":"受控回路";return <span className={`topology-badge ${role} ${connectionType||""}`}>{label}</span>}
function ControlSources({sources,devices,onOpen}:{sources:DeviceControlSource[];devices?:Device[];onOpen?:(device:Device)=>void}){
  const ordered=[...sources].sort((left,right)=>Number(left.sourceRole!=="primary")-Number(right.sourceRole!=="primary"));
  return <div className="control-sources"><small>控制来源 · {sources.filter(source=>source.connectionType==="wired").length} 有线 / {sources.filter(source=>source.connectionType==="wireless").length} 无线</small>{ordered.map(source=>{
    const device=devices?findPhysicalDevice(devices,source.sourceId):undefined;
    return <button key={`${source.sourceId}:${source.channelIndex}:${source.channelSiid}`} className="control-source-row" type="button" onClick={event=>{event.stopPropagation();if(device&&onOpen)onOpen(device)}} disabled={!device||!onOpen}><span className={`source-role ${source.sourceRole} ${source.connectionType}`}>{source.connectionType==="wired"?"有线控制":source.connectionType==="wireless"?"无线控制":"关系待确认"}</span><span className="source-identity"><strong>{source.sourceName}</strong>{source.viaName&&<small>经 {source.viaName}</small>}</span><span className="source-channel"><strong>{source.channelIndex!==null?`按键 ${source.channelIndex===0?1:source.channelIndex}`:source.channelSiid!==null?`服务 ${source.channelSiid}`:source.sourceRoom}</strong>{source.targetCount>1&&<small>同时控制 {source.targetCount} 台</small>}</span></button>
  })}</div>
}
function groupChannelMatch(index:number|null,siid:number|null,group:SpecGroup,groups:SpecGroup[]){return switchGroupMatches(index,siid,group,groups)}
function groupRelatedDevices(device:Device,group:SpecGroup,groups:SpecGroup[],devices:Device[]){return devices.filter(item=>samePhysicalDevice(item.parentId,device.did)&&groupChannelMatch(item.topology?.channelIndex??null,item.topology?.channelSiid??null,group,groups))}
function groupBindings(device:Device,group:SpecGroup,groups:SpecGroup[]){return(device.topology?.bindings??[]).filter(binding=>groupChannelMatch(binding.channelIndex,binding.channelSiid,group,groups))}
function groupDisplayTargets(channel:DeviceTopology["channels"][number]|undefined,mapped:Device[],bindings:DeviceTopology["bindings"],devices:Device[]):SwitchChannelTarget<Device>[]{
  const targets=new Map(listSwitchChannelTargets(channel,devices).map(target=>[target.id,target]));
  for(const item of mapped)if(item.did&&!targets.has(item.did))targets.set(item.did,{id:item.did,name:item.name,room:item.room,device:item,smart:isIndependentSmartDevice(item)});
  for(const item of bindings)if(!targets.has(item.targetId)){const device=findPhysicalDevice(devices,item.targetId);targets.set(item.targetId,{id:item.targetId,name:item.targetName,room:item.targetRoom,device,smart:Boolean(device&&isIndependentSmartDevice(device))})}
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
function friendlyError(error:string){if(error==="SESSION_SECRET_NOT_CONFIGURED")return"网站会话加密尚未配置";if(error==="XIAOMI_QR_UNAVAILABLE")return"小米暂未返回登录二维码";if(error==="XIAOMI_QR_EXPIRED")return"二维码已过期，请重新获取";if(error==="XIAOMI_SERVICE_TOKEN_MISSING")return"登录成功，但未能取得米家服务令牌";if(error==="XIAOMI_NOT_CONNECTED")return"登录状态已失效，请重新扫码";if(error==="XIAOMI_CLOUD_TIMEOUT")return"米家云响应超时，请确认服务器区域后重试";if(error==="XIAOMI_CLOUD_RESPONSE_INVALID"||error==="XIAOMI_DEVICE_RESPONSE_INVALID"||error==="XIAOMI_SCENE_RESPONSE_INVALID")return"米家云返回的数据无法识别";if(error==="XIAOMI_SCENE_NOT_FOUND")return"该场景不属于当前家庭或已被删除";if(error==="XIAOMI_SCENE_DISABLED")return"该场景已停用";if(error==="XIAOMI_SCENE_NOT_ACCEPTED")return"米家云未接受场景指令";if(error==="MIOT_SPEC_MODEL_NOT_FOUND")return"该型号尚未公开 MIoT 设备规格";if(error==="MIOT_SPEC_RESPONSE_INVALID"||error==="MIOT_SPEC_UNAVAILABLE")return"设备规格服务暂不可用";if(error==="INVALID_ACTION_PARAMETERS")return"请按要求输入正确数量的 JSON 参数";if(error==="BINDING_ACTION_TARGET_UNSUPPORTED")return"该型号没有公开可写目标设备参数";if(error==="BINDING_ACTION_CHANNEL_UNSUPPORTED"||error==="BINDING_ACTION_CHANNEL_MISSING")return"该型号未公开普通灯所需的有线回路参数";if(error==="BINDING_ACTION_PARAMETERS_UNKNOWN")return"绑定动作包含未公开含义的厂商参数";if(error==="XIAOMI_CLOUD_HTTP_401")return"米家登录已失效，请重新扫码登录";if(error==="XIAOMI_CLOUD_HTTP_403")return"米家云拒绝访问，请重新登录并确认所在区域";if(error.startsWith("XIAOMI_PROPERTY_CODE_"))return`设备未接受该设置，错误码 ${error.slice("XIAOMI_PROPERTY_CODE_".length)}`;if(error.startsWith("MIOT_SPEC_HTTP_"))return`设备规格服务返回 HTTP ${error.split("_").pop()}`;if(error.startsWith("XIAOMI_CLOUD_HTTP_"))return`米家云返回 HTTP ${error.split("_").pop()}`;if(error.startsWith("XIAOMI_CLOUD_CODE_"))return`米家云错误 ${error.split("_").pop()}，请确认服务器区域`;return`连接米家云失败：${error||"未知错误"}`}
