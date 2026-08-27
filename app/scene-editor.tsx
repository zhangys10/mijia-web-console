"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagedDevice } from "../lib/device-management";
import type { ManualScene } from "../lib/xiaomi-scenes";
import type { SceneDraftAction, SceneEditorDraft, SceneValue } from "../lib/xiaomi-scene-editor";
import { parseDerivedDeviceId } from "../lib/device-topology";

type SpecProperty = { key:string;name:string;label:string;siid:number;piid:number;format:string;writable:boolean;unit?:string;choices?:Array<{value:SceneValue;label:string}>;range?:{min:number;max:number;step:number} };
type SpecGroup = { key:string;name:string;label:string;properties:SpecProperty[] };
type Specification = { loading:boolean;groups:SpecGroup[];error?:string };
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

function editableDevices(devices: ManagedDevice[], homeId: string) {
  return devices.filter(device => device.homeId === homeId && device.did && !parseDerivedDeviceId(device.did) && !/^group\./i.test(device.did));
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
  const [workingIndex,setWorkingIndex]=useState<number|undefined>();
  const [spec,setSpec]=useState<Specification>({loading:false,groups:[]});
  const [addPropertyKey,setAddPropertyKey]=useState("");
  const requestId=useRef(0);
  const candidates=useMemo(()=>editableDevices(devices,homeId),[devices,homeId]);
  const writable=spec.groups.flatMap(group=>group.properties.filter(property=>property.writable));

  useEffect(()=>{
    let active=true;
    if(!sceneId)return()=>{active=false};
    void fetch(`/api/xiaomi/scenes/${encodeURIComponent(sceneId)}?homeId=${encodeURIComponent(homeId)}`).then(async response=>{
      const data=await response.json();if(!response.ok)throw new Error(data.error||"XIAOMI_SCENE_SYNC_FAILED");
      if(active)setDraft(data.draft as SceneEditorDraft);
    }).catch(reason=>{if(active)setError(errorText(reason instanceof Error?reason.message:"UNKNOWN_ERROR"))}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[homeId,sceneId]);

  async function loadSpecification(device:ManagedDevice){
    const id=++requestId.current;
    setSpec({loading:true,groups:[]});setAddPropertyKey("");
    try{
      const query=new URLSearchParams({model:device.detail});if(device.urn)query.set("urn",device.urn);
      const response=await fetch(`/api/xiaomi/spec?${query}`);const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||"MIOT_SPEC_UNAVAILABLE");
      if(id===requestId.current)setSpec({loading:false,groups:Array.isArray(data.groups)?data.groups:[]});
    }catch(reason){if(id===requestId.current)setSpec({loading:false,groups:[],error:reason instanceof Error?reason.message:"MIOT_SPEC_UNAVAILABLE"})}
  }

  function selectDevice(did:string){
    const device=candidates.find(item=>item.did===did);if(!device?.did)return;
    const next:SceneDraftAction={clientId:working?.clientId||newActionId(),kind:"set-properties",did:device.did,deviceName:device.name,model:device.detail,label:"设置设备属性",properties:[]};
    setWorking(next);void loadSpecification(device);
  }

  function startAdd(){
    setComposerOpen(true);setWorkingIndex(undefined);setWorking(undefined);setSpec({loading:false,groups:[]});setAddPropertyKey("");
  }

  function startEdit(action:SceneDraftAction,index:number){
    const device=candidates.find(item=>item.did===action.did);
    setComposerOpen(true);setWorkingIndex(index);setWorking({...structuredClone(action),...(device?{deviceName:device.name,model:device.detail}:{})});setAddPropertyKey("");
    if(device)void loadSpecification(device);
  }

  function addProperty(){
    if(!working||working.kind!=="set-properties")return;
    const property=writable.find(item=>item.key===addPropertyKey);if(!property)return;
    if(working.properties?.some(item=>item.siid===property.siid&&item.piid===property.piid))return;
    setWorking({...working,properties:[...(working.properties??[]),{siid:property.siid,piid:property.piid,value:firstValue(property),label:property.label}]});setAddPropertyKey("");
  }

  function setPropertyValue(index:number,value:SceneValue){
    if(!working||working.kind!=="set-properties")return;
    setWorking({...working,properties:(working.properties??[]).map((property,itemIndex)=>itemIndex===index?{...property,value}:property)});
  }

  function commitWorking(){
    if(!draft||!working)return;
    if(working.kind!=="set-properties"||!working.properties?.length)return;
    const actions=[...draft.actions];
    if(workingIndex===undefined)actions.push(working);else actions[workingIndex]=working;
    setDraft({...draft,actions});setComposerOpen(false);setWorking(undefined);setWorkingIndex(undefined);setDirty(true);setActionsDirty(true);
  }

  function removeAction(index:number){if(!draft)return;setDraft({...draft,actions:draft.actions.filter((_,item)=>item!==index)});setDirty(true);setActionsDirty(true)}
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
        <section className="scene-editor-actions"><div className="scene-editor-section-title"><div><span>DO</span><div><strong>动作序列</strong><small>{draft.actions.length} 个动作</small></div></div>{draft.actionsEditable&&<button type="button" onClick={startAdd}>＋ 添加动作</button>}</div>
          <ol>{draft.actions.map((action,index)=><li key={action.clientId}><b>{index+1}</b><div><strong>{action.deviceName||action.label}</strong><small>{actionSummary(action)}</small></div>{draft.actionsEditable&&action.kind!=="unsupported"&&<div className="scene-action-tools"><button type="button" disabled={index===0} onClick={()=>moveAction(index,-1)}>↑</button><button type="button" disabled={index===draft.actions.length-1} onClick={()=>moveAction(index,1)}>↓</button><button type="button" onClick={()=>startEdit(action,index)}>修改</button><button type="button" onClick={()=>removeAction(index)}>删除</button></div>}</li>)}</ol>
          {!draft.actions.length&&<div className="scene-editor-empty">还没有动作。选择设备并加入至少一个动作后才能创建场景。</div>}
        </section>
        {draft.actionsEditable&&composerOpen&&<section className={`scene-action-composer ${working?"active":""}`}><div className="scene-editor-section-title"><div><span>＋</span><div><strong>{workingIndex===undefined?"添加动作":"修改动作"}</strong><small>仅展示设备公开且可安全写入的能力</small></div></div></div>
          <label><span>目标设备</span><select value={working?.did??""} onChange={event=>selectDevice(event.target.value)}><option value="">选择设备</option>{Array.from(new Set(candidates.map(item=>item.room))).map(room=><optgroup key={room} label={room}>{candidates.filter(item=>item.room===room).map(device=><option key={device.did} value={device.did}>{device.name}{device.online===false?" · 离线":""}</option>)}</optgroup>)}</select></label>
          {spec.loading&&<div className="scene-composer-state">正在读取设备能力…</div>}{spec.error&&<div className="scene-composer-state error">该设备能力暂不可用：{spec.error}</div>}
          {working&&!spec.loading&&!spec.error&&working.kind==="set-properties"&&<><div className="scene-kind-tabs"><button type="button" className="selected" disabled={!writable.length}>设置属性</button></div>
            <><div className="scene-property-list">{(working.properties??[]).map((property,index)=>{const capability=writable.find(item=>item.siid===property.siid&&item.piid===property.piid);return <div key={`${property.siid}.${property.piid}`}><div><strong>{capability?.label||property.label||`属性 ${property.siid}.${property.piid}`}</strong><button type="button" onClick={()=>setWorking({...working,properties:working.properties?.filter((_,item)=>item!==index)})}>移除</button></div><PropertyValueEditor property={capability} value={property.value} onChange={value=>setPropertyValue(index,value)}/></div>})}</div><div className="scene-add-property"><select value={addPropertyKey} onChange={event=>setAddPropertyKey(event.target.value)}><option value="">选择要设置的属性</option>{spec.groups.map(group=><optgroup key={group.key} label={group.label}>{group.properties.filter(property=>property.writable&&!working.properties?.some(item=>item.siid===property.siid&&item.piid===property.piid)).map(property=><option key={property.key} value={property.key}>{property.label}</option>)}</optgroup>)}</select><button type="button" disabled={!addPropertyKey} onClick={addProperty}>加入</button></div></>
            <div className="scene-composer-actions"><button type="button" onClick={()=>{setComposerOpen(false);setWorking(undefined);setWorkingIndex(undefined)}}>取消</button><button type="button" className="primary" disabled={!working.properties?.length} onClick={commitWorking}>{workingIndex===undefined?"加入序列":"保存动作"}</button></div></>}
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
