"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagedDevice } from "../lib/device-management";
import type { ManualScene } from "../lib/xiaomi-scenes";
import type { SceneDraftAction, SceneEditorDraft, SceneValue } from "../lib/xiaomi-scene-editor";
import { isSceneWritableProperty, mapScenePropertySemantics, scenePropertySemantics, type ScenePropertySemantic } from "../lib/xiaomi-scene-properties";
import { parseDerivedDeviceId } from "../lib/device-topology";
import { groupSceneDraftActions } from "../lib/scene-action-groups";

type SpecProperty = { key:string;name:string;label:string;siid:number;piid:number;format:string;readable:boolean;writable:boolean;unit?:string;choices?:Array<{value:SceneValue;label:string}>;range?:{min:number;max:number;step:number} };
type SpecGroup = { key:string;name:string;label:string;properties:SpecProperty[] };
type Specification = { loading:boolean;groups:SpecGroup[];error?:string };
type SelectedProperty = ScenePropertySemantic & { key:string;groupLabel:string;capability:SpecProperty };
type Props = {
  homeId: string;
  homeName: string;
  devices: ManagedDevice[];
  sceneId?: string;
  onClose: () => void;
  onSaved: (scene: ManualScene) => void;
};

function newActionId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `scene-${Date.now()}-${Math.random()}`;
}

function firstValue(property: SpecProperty): SceneValue {
  if (property.choices?.length) return property.choices[0].value;
  if (property.format === "bool") return true;
  if (property.range) return property.range.min;
  if (["float", "int8", "int16", "int32", "uint8", "uint16", "uint32"].includes(property.format)) return 0;
  return "";
}

function errorText(error: string) {
  if (error === "XIAOMI_SCENE_CONFLICT") return "场景已在米家 App 或其他页面中修改，请关闭编辑器后重新打开。";
  if (error === "XIAOMI_SCENE_ACTIONS_READ_ONLY") return "该场景包含暂不支持的动作，本次只能修改名称。";
  if (error === "XIAOMI_SCENE_NAME_CONFLICT") return "当前家庭已有同名场景，请换一个名称。";
  if (error === "XIAOMI_SCENE_WRITE_NOT_VISIBLE") return "米家云已收到请求，但暂时没有返回写入后的场景。请同步后确认。";
  if (error === "XIAOMI_SCENE_PROPERTY_UNSUPPORTED") return "选择的属性或数值不受该设备支持。";
  if (error === "XIAOMI_SCENE_ACTION_UNSUPPORTED") return "选择的设备动作不支持加入场景。";
  if (error === "XIAOMI_SCENE_DEVICE_NOT_FOUND") return "目标设备不属于当前家庭或不是可直接控制的设备。";
  return `场景保存失败：${error || "未知错误"}`;
}

function editableDevices(devices: ManagedDevice[], homeId: string): Array<ManagedDevice & { did:string }> {
  return devices.filter((device):device is ManagedDevice & { did:string } => Boolean(device.homeId === homeId && device.did && !parseDerivedDeviceId(device.did)));
}

function deviceKindLabel(kind:string) {
  return ({light:"灯光",lamp:"灯光",aircondition:"空调",acpartner:"空调伴侣",airpurifier:"空气净化器",vacuum:"扫拖机器人",fan:"风扇",lock:"智能门锁",curtain:"窗帘",humidifier:"加湿器",plug:"智能插座",switch:"智能开关",camera:"摄像头",sensor:"传感器",gateway:"网关"} as Record<string,string>)[kind]||"智能设备";
}

function deviceKindGroup(kind:string) {
  if(kind==="lamp")return "light";
  if(kind==="acpartner")return "aircondition";
  return kind;
}

function isLightGroup(device:ManagedDevice|undefined){return Boolean(device?.did&&/^group\./i.test(device.did))}
function targetKindLabel(device:ManagedDevice){return isLightGroup(device)?"灯组":deviceKindLabel(device.kind)}

async function fetchDeviceSpecification(device:ManagedDevice):Promise<Specification>{
  try{
    const query=new URLSearchParams({model:device.detail});if(device.urn)query.set("urn",device.urn);
    const response=await fetch(`/api/xiaomi/spec?${query}`);const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||"MIOT_SPEC_UNAVAILABLE");
    return {loading:false,groups:Array.isArray(data.groups)?data.groups:[]};
  }catch(reason){return {loading:false,groups:[],error:reason instanceof Error?reason.message:"MIOT_SPEC_UNAVAILABLE"}}
}

function supportsSemantics(specification:Specification|undefined,semantics:ScenePropertySemantic[]){
  if(!specification||specification.error)return false;
  if(!semantics.length)return specification.groups.some(group=>group.properties.some(property=>isSceneWritableProperty(group.name,property)));
  return Boolean(mapScenePropertySemantics(semantics,specification.groups));
}

function actionSummary(action: SceneEditorDraft["actions"][number]) {
  if (action.kind === "set-properties") return `${action.properties?.length ?? 0} 个设备属性`;
  if (action.kind === "invoke-action") return action.label;
  return "reason" in action ? action.reason : "暂不支持的动作";
}

export default function SceneEditor({ homeId, homeName, devices, sceneId, onClose, onSaved }: Props) {
  const [draft,setDraft]=useState<SceneEditorDraft|undefined>(()=>sceneId?undefined:{sceneId:"",homeId,name:"",enabled:true,revision:"",actionsEditable:true,actions:[]});
  const [loading,setLoading]=useState(Boolean(sceneId));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [dirty,setDirty]=useState(false);
  const [actionsDirty,setActionsDirty]=useState(false);
  const [composerOpen,setComposerOpen]=useState(!sceneId);
  const [working,setWorking]=useState<SceneDraftAction|undefined>();
  const [workingIndices,setWorkingIndices]=useState<number[]>([]);
  const [selectedDids,setSelectedDids]=useState<string[]>([]);
  const [selectedProperties,setSelectedProperties]=useState<SelectedProperty[]>([]);
  const [pendingProperties,setPendingProperties]=useState<SceneDraftAction["properties"]>();
  const [deviceSpecs,setDeviceSpecs]=useState<Record<string,Specification>>({});
  const [specsLoading,setSpecsLoading]=useState(composerOpen);
  const [specReload,setSpecReload]=useState(0);
  const [specsError,setSpecsError]=useState("");
  const [composerError,setComposerError]=useState("");
  const [addPropertyKey,setAddPropertyKey]=useState("");
  const [deviceRoom,setDeviceRoom]=useState("");
  const [deviceKind,setDeviceKind]=useState("");
  const requestId=useRef(0);
  const candidates=useMemo(()=>editableDevices(devices,homeId),[devices,homeId]);
  const deviceRooms=useMemo(()=>Array.from(new Set(candidates.map(device=>device.room))).sort((left,right)=>left.localeCompare(right,"zh-CN")),[candidates]);
  const deviceKinds=useMemo(()=>Array.from(new Set(candidates.map(device=>deviceKindGroup(device.kind)))).sort((left,right)=>deviceKindLabel(left).localeCompare(deviceKindLabel(right),"zh-CN")),[candidates]);
  const selectedSemantics=useMemo(()=>selectedProperties.map(({serviceName,propertyName,label,value})=>({serviceName,propertyName,label,value})),[selectedProperties]);
  const propertyCatalog=useMemo(()=>{const catalog=new Map<string,{key:string;serviceName:string;propertyName:string;groupLabel:string;label:string;capability:SpecProperty}>();for(const device of candidates){const specification=deviceSpecs[device.did];for(const group of specification?.groups??[]){for(const property of group.properties){if(!isSceneWritableProperty(group.name,property))continue;const key=`${group.name}:${property.name}`;if(!catalog.has(key))catalog.set(key,{key,serviceName:group.name,propertyName:property.name,groupLabel:group.label,label:property.label,capability:property})}}}return [...catalog.values()].sort((left,right)=>left.groupLabel.localeCompare(right.groupLabel,"zh-CN")||left.label.localeCompare(right.label,"zh-CN"))},[candidates,deviceSpecs]);
  const capableCandidates=useMemo(()=>candidates.filter(device=>supportsSemantics(deviceSpecs[device.did],selectedSemantics)),[candidates,deviceSpecs,selectedSemantics]);
  const filteredCandidates=useMemo(()=>capableCandidates.filter(device=>(!deviceRoom||device.room===deviceRoom)&&(!deviceKind||deviceKindGroup(device.kind)===deviceKind)),[capableCandidates,deviceKind,deviceRoom]);
  const actionRooms=useMemo(()=>groupSceneDraftActions(draft?.actions??[],devices.filter(device=>device.homeId===homeId)),[devices,draft?.actions,homeId]);

  useEffect(()=>{
    let active=true;
    if(!sceneId)return()=>{active=false};
    void fetch(`/api/xiaomi/scenes/${encodeURIComponent(sceneId)}?homeId=${encodeURIComponent(homeId)}`).then(async response=>{
      const data=await response.json();if(!response.ok)throw new Error(data.error||"XIAOMI_SCENE_SYNC_FAILED");
      if(active)setDraft(data.draft as SceneEditorDraft);
    }).catch(reason=>{if(active)setError(errorText(reason instanceof Error?reason.message:"UNKNOWN_ERROR"))}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[homeId,sceneId]);

  useEffect(()=>{
    if(!composerOpen)return;
    let active=true;const id=++requestId.current;
    const byModel=new Map<string,Promise<Specification>>();
    for(const device of candidates){const key=`${device.detail}:${device.urn??""}`;if(!byModel.has(key))byModel.set(key,fetchDeviceSpecification(device))}
    void Promise.all(candidates.map(async device=>{const specification=await byModel.get(`${device.detail}:${device.urn??""}`)!;return [device.did,specification] as const})).then(entries=>{if(active&&id===requestId.current){setDeviceSpecs(Object.fromEntries(entries));if(!entries.some(([,item])=>!item.error))setSpecsError("暂时无法读取可用于场景的设备能力。")}}).finally(()=>{if(active&&id===requestId.current)setSpecsLoading(false)});
    return()=>{active=false};
  },[candidates,composerOpen,specReload]);

  useEffect(()=>{
    if(!pendingProperties||!working||specsLoading)return;
    let active=true;void Promise.resolve().then(()=>{if(!active)return;const specification=deviceSpecs[working.did];const semantics=specification&&scenePropertySemantics(pendingProperties,specification.groups);if(!specification||!semantics){setComposerError("无法识别原动作中的属性，该动作暂不能批量修改。");setPendingProperties(undefined);return}const selections=semantics.flatMap(semantic=>{const group=specification.groups.find(item=>item.name===semantic.serviceName),property=group?.properties.find(item=>item.name===semantic.propertyName);return group&&property?[{...semantic,key:`${semantic.serviceName}:${semantic.propertyName}`,groupLabel:group.label,capability:property}]:[]});setSelectedProperties(selections);setSelectedDids(current=>current.filter(did=>supportsSemantics(deviceSpecs[did],semantics)));setPendingProperties(undefined)});return()=>{active=false};
  },[deviceSpecs,pendingProperties,specsLoading,working]);

  function selectDevice(did:string){
    const device=candidates.find(item=>item.did===did);if(!device?.did)return;
    setSelectedDids(current=>current.includes(did)?current.filter(item=>item!==did):[...current,did]);setComposerError("");
  }

  function startAdd(){
    setComposerOpen(true);setSpecsLoading(true);setSpecReload(current=>current+1);setSpecsError("");setWorkingIndices([]);setSelectedDids([]);setSelectedProperties([]);setPendingProperties(undefined);setWorking(undefined);setAddPropertyKey("");setDeviceRoom("");setDeviceKind("");setComposerError("");
  }

  function startEdit(action:SceneDraftAction,indices:number[]){
    const device=candidates.find(item=>item.did===action.did);
    const dids=indices.flatMap(index=>{const item=draft?.actions[index];return item&&item.kind!=="unsupported"?[item.did]:[]});
    setComposerOpen(true);setSpecsLoading(true);setSpecReload(current=>current+1);setSpecsError("");setWorkingIndices(indices);setSelectedDids(Array.from(new Set(dids)));setSelectedProperties([]);setPendingProperties(structuredClone(action.properties));setWorking({...structuredClone(action),...(device?{deviceName:device.name,model:device.detail}:{})});setAddPropertyKey("");setComposerError("");
    if(device){setDeviceRoom(device.room);setDeviceKind(deviceKindGroup(device.kind))}
  }

  function addProperty(){
    const entry=propertyCatalog.find(item=>item.key===addPropertyKey);if(!entry)return;
    updateSelectedProperties([...selectedProperties,{key:entry.key,serviceName:entry.serviceName,propertyName:entry.propertyName,groupLabel:entry.groupLabel,label:entry.label,value:firstValue(entry.capability),capability:entry.capability}]);setAddPropertyKey("");
  }

  function setPropertyValue(index:number,value:SceneValue){
    updateSelectedProperties(selectedProperties.map((property,itemIndex)=>itemIndex===index?{...property,value}:property));
  }

  function updateSelectedProperties(next:SelectedProperty[]){
    const semantics=next.map(({serviceName,propertyName,label,value})=>({serviceName,propertyName,label,value}));
    const compatible=selectedDids.filter(did=>supportsSemantics(deviceSpecs[did],semantics));
    setSelectedProperties(next);setSelectedDids(compatible);setComposerError(compatible.length<selectedDids.length?`已取消 ${selectedDids.length-compatible.length} 个不支持当前属性或数值的目标。`:"");
  }

  async function commitWorking(){
    if(!draft||saving||!selectedProperties.length)return;
    const targets=selectedDids.flatMap(did=>{const device=candidates.find(item=>item.did===did);return device?[device]:[]});
    if(!targets.length)return;
    const semantics=selectedProperties.map(({serviceName,propertyName,label,value})=>({serviceName,propertyName,label,value}));
    const nextCount=draft.actions.length-workingIndices.length+targets.length;
    if(nextCount>64){setComposerError("场景最多支持 64 个真实动作，请减少目标设备。");return}
    setSaving(true);setComposerError("");
    try{
      const existing=new Map(workingIndices.flatMap(index=>{const action=draft.actions[index];return action&&action.kind!=="unsupported"?[[action.did,action] as const]:[]}));
      const expanded:SceneDraftAction[]=targets.map(device=>{
        const specification=deviceSpecs[device.did];
        if(!specification||specification.error)throw new Error(`${device.name} 的设备能力暂不可用`);
        const properties=mapScenePropertySemantics(semantics,specification.groups);
        if(!properties)throw new Error(`${device.name} 不支持全部所选属性`);
        const source=existing.get(device.did!);
        return {clientId:source?.clientId||newActionId(),...(source?.sourceIndex===undefined?{}:{sourceIndex:source.sourceIndex}),kind:"set-properties",did:device.did!,deviceName:device.name,model:device.detail,label:"设置设备属性",properties};
      });
      const removed=new Set(workingIndices),actions=draft.actions.filter((_,index)=>!removed.has(index));
      const insertion=workingIndices.length?Math.min(...workingIndices):actions.length;
      actions.splice(insertion,0,...expanded);
      setDraft({...draft,actions});setComposerOpen(false);setWorking(undefined);setWorkingIndices([]);setSelectedDids([]);setSelectedProperties([]);setDirty(true);setActionsDirty(true);
    }catch(reason){setComposerError(reason instanceof Error?reason.message:"批量动作生成失败")}
    finally{setSaving(false)}
  }

  function removeActions(indices:number[]){if(!draft)return;const removed=new Set(indices);setDraft({...draft,actions:draft.actions.filter((_,item)=>!removed.has(item))});setDirty(true);setActionsDirty(true)}
  function moveAction(index:number,direction:-1|1){if(!draft)return;const target=index+direction;if(target<0||target>=draft.actions.length)return;const actions=[...draft.actions];[actions[index],actions[target]]=[actions[target],actions[index]];setDraft({...draft,actions});setDirty(true);setActionsDirty(true)}
  function close(){if(!dirty||window.confirm("放弃尚未保存的场景修改？"))onClose()}

  async function save(){
    if(!draft||saving)return;
    const name=draft.name.trim();if(!name){setError("请输入场景名称。");return}
    const supported=draft.actions.filter((action):action is SceneDraftAction=>action.kind!=="unsupported");
    if(!sceneId&&supported.length===0){setError("请至少添加一个场景动作。");return}
    setSaving(true);setError("");
    try{
      const body={homeId,name,enabled:draft.enabled,...(sceneId?{revision:draft.revision}:{}),...(draft.actionsEditable&&(!sceneId||actionsDirty)?{actions:supported}: {})};
      const url=sceneId?`/api/xiaomi/scenes/${encodeURIComponent(sceneId)}?homeId=${encodeURIComponent(homeId)}`:"/api/xiaomi/scenes";
      const response=await fetch(url,{method:sceneId?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||"XIAOMI_SCENE_WRITE_FAILED");
      setDirty(false);onSaved(data.scene as ManualScene);
    }catch(reason){setError(errorText(reason instanceof Error?reason.message:"UNKNOWN_ERROR"))}
    finally{setSaving(false)}
  }

  return <div className="modal-bg scene-editor-bg" onMouseDown={close}><section className="scene-editor" role="dialog" aria-modal="true" aria-label={sceneId?"编辑场景":"新建场景"} onMouseDown={event=>event.stopPropagation()}>
    <header><div><span>{sceneId?"EDIT SCENE":"NEW SCENE"}</span><h2>{sceneId?"编辑手动场景":"新建手动场景"}</h2><p>{homeName} · 保存后同步到米家云</p></div><button type="button" aria-label="关闭场景编辑器" onClick={close}>×</button></header>
    {loading?<div className="scene-editor-state">正在读取可编辑场景…</div>:!draft?<div className="scene-editor-state error">{error||"场景读取失败"}</div>:<>
      <div className="scene-editor-scroll">
        <section className="scene-editor-basics"><label><span>场景名称</span><input maxLength={50} value={draft.name} placeholder="例如：回家模式" onChange={event=>{setDraft({...draft,name:event.target.value});setDirty(true)}}/></label></section>
        {!draft.actionsEditable&&<div className="scene-editor-warning"><strong>动作保持只读</strong><p>这个场景包含当前版本无法安全重建的动作。你仍可修改名称，原始动作会完整保留。</p></div>}
        <section className="scene-editor-actions"><div className="scene-editor-section-title"><div><span>DO</span><div><strong>动作序列</strong><small>{draft.actions.length} 个真实动作</small></div></div>{draft.actionsEditable&&<button type="button" onClick={startAdd}>＋ 添加动作</button>}</div>
          <div className="scene-editor-action-rooms">{actionRooms.map(room=><section key={room.room}><header><strong>{room.room}</strong><small>{room.actionCount} 个动作</small></header><ol>{room.items.map(item=>{const action=item.actions[0],index=item.indices[0],editable=item.actions.every(candidate=>candidate.kind!=="unsupported"&&candidates.some(device=>device.did===candidate.did));if(!action||index===undefined)return null;return <li className={item.collapsible?"batch":""} key={item.actions.map(candidate=>candidate.clientId).join(":")}><b>{item.collapsible?item.actions.length:index+1}</b><div><strong>{item.collapsible?item.state?`${item.state==="on"?"打开":"关闭"} ${item.actions.length} 盏灯`:`批量设置 ${item.actions.length} 盏灯`:action.deviceName||action.label}</strong><small>{item.collapsible?`${item.actions.map(candidate=>candidate.deviceName).filter(Boolean).join("、")}`:actionSummary(action)}{!editable&&action.kind!=="unsupported"?" · 仅可保留或删除":""}</small></div>{draft.actionsEditable&&action.kind!=="unsupported"&&<div className="scene-action-tools">{editable&&!item.collapsible&&<><button type="button" disabled={index===0} onClick={()=>moveAction(index,-1)}>↑</button><button type="button" disabled={index===draft.actions.length-1} onClick={()=>moveAction(index,1)}>↓</button></>}{editable&&<button type="button" onClick={()=>startEdit(action,item.indices)}>修改</button>}<button type="button" onClick={()=>removeActions(item.indices)}>删除</button></div>}</li>})}</ol></section>)}</div>
          {!draft.actions.length&&<div className="scene-editor-empty">还没有动作。选择设备并加入至少一个动作后才能创建场景。</div>}
        </section>
        {draft.actionsEditable&&composerOpen&&<section className={`scene-action-composer ${selectedProperties.length||selectedDids.length?"active":""}`}><div className="scene-editor-section-title"><div><span>＋</span><div><strong>{workingIndices.length?"修改批量动作":"添加批量动作"}</strong><small>先设置属性与状态，再选择所有支持的设备或灯组</small></div></div></div>
          {specsLoading&&<div className="scene-composer-state">正在汇总当前家庭的可写设备能力…</div>}{specsError&&<div className="scene-composer-state error">{specsError}</div>}
          {!specsLoading&&<><div className="scene-kind-tabs"><button type="button" className="selected" disabled={!propertyCatalog.length}>设置批量属性</button><small>共发现 {propertyCatalog.length} 项标准可写属性</small></div>{!propertyCatalog.length&&<div className="scene-composer-state">当前设备没有适合加入手动场景的标准可写属性。</div>}
            <div className="scene-property-list">{selectedProperties.map((property,index)=><div key={property.key}><div><strong>{property.groupLabel} · {property.label}</strong><button type="button" onClick={()=>updateSelectedProperties(selectedProperties.filter((_,item)=>item!==index))}>移除</button></div><PropertyValueEditor property={property.capability} value={property.value} onChange={value=>setPropertyValue(index,value)}/></div>)}</div>
            <div className="scene-add-property"><select value={addPropertyKey} onChange={event=>setAddPropertyKey(event.target.value)}><option value="">选择要批量设置的属性</option>{Array.from(new Set(propertyCatalog.map(item=>item.groupLabel))).map(groupLabel=>{const properties=propertyCatalog.filter(item=>item.groupLabel===groupLabel&&!selectedProperties.some(selected=>selected.key===item.key));return properties.length?<optgroup key={groupLabel} label={groupLabel}>{properties.map(property=>{const count=candidates.filter(device=>supportsSemantics(deviceSpecs[device.did],[{serviceName:property.serviceName,propertyName:property.propertyName,label:property.label,value:firstValue(property.capability)}])).length;return <option key={property.key} value={property.key}>{property.label} · {count} 台支持</option>})}</optgroup>:null})}</select><button type="button" disabled={!addPropertyKey} onClick={addProperty}>加入</button></div>
            <p className="scene-device-help">属性变化后，下方仅保留同时支持全部已选属性和当前数值的目标。</p>
            <div className="scene-device-picker"><div className="scene-device-filters"><label><span>按房间筛选</span><select value={deviceRoom} onChange={event=>setDeviceRoom(event.target.value)}><option value="">全部房间</option>{deviceRooms.map(room=><option key={room} value={room}>{room}</option>)}</select></label><label><span>按类型筛选</span><select value={deviceKind} onChange={event=>setDeviceKind(event.target.value)}><option value="">全部类型</option>{deviceKinds.map(kind=><option key={kind} value={kind}>{deviceKindLabel(kind)}</option>)}</select></label></div><div className="scene-device-result-title"><span>目标设备与灯组</span><small>{selectedDids.length?`已选 ${selectedDids.length} 个目标`:`${filteredCandidates.length} 个目标支持当前设置`}</small></div><div className="scene-device-options" role="listbox" aria-label="目标设备与灯组" aria-multiselectable="true">{filteredCandidates.map(device=>{const selected=selectedDids.includes(device.did);return <button type="button" role="option" aria-selected={selected} className={selected?"selected":""} key={device.did} onClick={()=>selectDevice(device.did)}><span className="scene-device-icon">{device.icon}</span><span><strong>{device.name}</strong><small>{device.room} · {targetKindLabel(device)}{device.online===false?" · 离线":""}</small></span><i>{selected?"✓":"＋"}</i></button>})}</div>{!filteredCandidates.length&&<div className="scene-device-empty">没有设备或灯组同时支持当前属性和值，请调整设置。</div>}</div>
            {composerError&&<div className="scene-composer-state error" role="alert">{composerError}</div>}<div className="scene-composer-actions"><button type="button" onClick={()=>{setComposerOpen(false);setWorking(undefined);setWorkingIndices([]);setSelectedDids([]);setSelectedProperties([])}}>取消</button><button type="button" className="primary" disabled={saving||!selectedProperties.length||!selectedDids.length} onClick={()=>void commitWorking()}>{saving?"正在校验设备…":workingIndices.length?`保存 ${selectedDids.length} 个目标动作`:`加入 ${selectedDids.length} 个目标`}</button></div></>}
        </section>}
      </div>
      {error&&<div className="scene-editor-error" role="alert">{error}</div>}
      <footer><p>保存表示米家云已返回成功并能重新读取到场景。</p><div><button type="button" onClick={close}>取消</button><button type="button" className="primary" disabled={saving||!draft.name.trim()||!sceneId&&!draft.actions.length} onClick={()=>void save()}>{saving?"正在保存…":sceneId?"保存修改":"创建场景"}</button></div></footer>
    </>}
  </section></div>
}

function PropertyValueEditor({property,value,onChange}:{property?:SpecProperty;value:SceneValue;onChange:(value:SceneValue)=>void}){
  if(property?.choices?.length)return <select value={String(value)} onChange={event=>{const choice=property.choices?.find(item=>String(item.value)===event.target.value);if(choice)onChange(choice.value)}}>{property.choices.map(choice=><option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}</select>;
  if(property?.format==="bool")return <select value={String(value)} onChange={event=>onChange(event.target.value==="true")}><option value="true">开启</option><option value="false">关闭</option></select>;
  if(property?.range)return <div className="scene-range-value"><input type="range" min={property.range.min} max={property.range.max} step={property.range.step} value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/><input type="number" min={property.range.min} max={property.range.max} step={property.range.step} value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/><span>{property.unit||""}</span></div>;
  if(property&&["float","int8","int16","int32","uint8","uint16","uint32"].includes(property.format))return <input type="number" value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/>;
  return <input value={String(value)} onChange={event=>onChange(event.target.value)}/>;
}
