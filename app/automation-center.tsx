"use client";

import { useEffect, useMemo, useState } from "react";
import type { ManagedDevice } from "../lib/device-management";
import { automationPropertyDisplay } from "../lib/xiaomi-automation-action-display";
import type { AutomationEditorDraft } from "../lib/xiaomi-automation-editor";
import type { XiaomiAutomation } from "../lib/xiaomi-automations";
import type { SceneDraftAction, SceneValue } from "../lib/xiaomi-scene-editor";

type Props = { homeId: string; homeName: string; devices: ManagedDevice[]; connected: boolean; onMessage: (message: string) => void };
type CatalogAction = { key:string;kind:"set-property";did:string;deviceName:string;room:string;model:string;serviceLabel:string;siid:number;piid:number;label:string;format:string;range?:{min:number;max:number;step:number};choices?:Array<{value:SceneValue;label:string}> };
type CatalogPropertyDescription = Pick<CatalogAction,"did"|"serviceLabel"|"siid"|"piid"|"label"|"format"|"range"|"choices"> & {editable:boolean};
type TriggerTemplate = { key:string;automationId:string;sourceIndex:number;kind:string;label:string;detail?:string;deviceKey?:string;deviceName?:string;room?:string };
type TriggerKind = { kind:string;label:string;writable:boolean };
type CatalogSource = "tca-v3"|"model-catalog"|"miot-spec";
type TriggerCapability = { key:string;kind:"property"|"event"|"unknown";label:string;detail:string;source:CatalogSource;siid?:number;piid?:number;eiid?:number;value?:SceneValue };
type DiscoveredAction = { key:string;kind:"set-property"|"set-properties"|"action"|"unknown";label:string;detail:string;source:CatalogSource;siid?:number;piid?:number;aiid?:number;value?:SceneValue };
type TriggerDevice = { key:string;deviceName:string;room:string;capabilities:TriggerCapability[];actions:DiscoveredAction[];discovery:"tca-v3"|"model-catalog"|"miot-spec"|"unavailable" };
type Catalog = { actions: CatalogAction[];propertyDescriptions:CatalogPropertyDescription[];triggerKinds:TriggerKind[];triggerTemplates:TriggerTemplate[];triggerDevices:TriggerDevice[] };
type UnsupportedAction = { clientId:string;kind:"unsupported";sourceIndex:number;label:string;deviceName?:string;reason:string };
type EditorState = AutomationEditorDraft & { schedule?:{time:string;weekdays:number[]}; actions:Array<SceneDraftAction|UnsupportedAction> };

const demoAutomations:XiaomiAutomation[]=[
  {id:"demo-sunset",homeId:"demo",name:"傍晚回家亮灯",enabled:true,triggerMode:"all",triggers:[{kind:"weather",label:"日落后",editable:false},{kind:"location",label:"有人回家",editable:false}],actions:[{order:1,label:"打开",deviceName:"玄关灯",details:[{kind:"power",label:"电源",value:"开启",state:"on"}]}],actionCount:1},
  {id:"demo-night",homeId:"demo",name:"深夜自动晚安",enabled:false,triggerMode:"all",triggers:[{kind:"schedule",label:"每天 23:30",time:"23:30",weekdays:[1,2,3,4,5,6,7],editable:true}],actions:[{order:1,label:"关闭",deviceName:"全屋灯具",details:[{kind:"power",label:"电源",value:"关闭",state:"off"}]}],actionCount:1},
];

function friendlyError(error:string){return ({XIAOMI_AUTOMATION_CONFLICT:"自动化已在米家 App 或其他页面中修改，请返回列表后重试。",XIAOMI_AUTOMATION_TRIGGER_READ_ONLY:"这个触发条件由米家或设备插件管理，当前只能原样保留。",XIAOMI_AUTOMATION_ACTIONS_READ_ONLY:"自动化包含暂不支持重建的动作，动作区保持只读。",XIAOMI_AUTOMATION_WRITE_NOT_VISIBLE:"米家云已接收请求，但暂时没有回读到一致结果。",XIAOMI_AUTOMATION_NAME_CONFLICT:"当前家庭已有同名自动化。"} as Record<string,string>)[error]||`自动化操作失败：${error}`}
function actionValue(option:CatalogAction):SceneValue{if(option.format==="bool")return true;if(option.choices?.length)return option.choices[0]!.value;if(option.range)return option.range.min;return ""}
function triggerGlyph(kind:string){return kind==="schedule"?"◷":kind==="device"?"▣":kind==="location"?"⌖":kind==="weather"||kind==="sun"?"☀":"◇"}
function catalogSourceLabel(source:CatalogSource){return source==="tca-v3"?"当前设备已确认":source==="model-catalog"?"官方型号目录":"MIoT 规格"}
function discoverySummary(device:TriggerDevice){if(device.discovery==="unavailable")return "自动化目录暂不可用";const counts=[device.capabilities.length?`${device.capabilities.length} 个条件`:"",device.actions.length?`${device.actions.length} 个动作`:""].filter(Boolean).join(" · ");return counts||"没有声明自动化能力"}
function triggerCategory(template:TriggerTemplate){return template.kind==="weather"&&/日出|日落|sunrise|sunset/i.test(template.label)?"sun":template.kind}
function selectedTemplate(draft:EditorState,template:TriggerTemplate){return Boolean(draft.triggerSelections?.some(item=>item.automationId===template.automationId&&item.sourceIndex===template.sourceIndex))}
function scheduleLabel(schedule:NonNullable<EditorState["schedule"]>){return `${schedule.time} · ${schedule.weekdays.length===7?"每天":`每周 ${schedule.weekdays.map(day=>"一二三四五六日"[day-1]).join("、")}`}`}
function draftReady(draft:EditorState){return Boolean(draft.name.trim()&&draft.actions.length&&(draft.schedule||draft.triggerSelections?.length)&&(!draft.schedule||draft.schedule.weekdays.length))}
function actionPropertySummary(action:SceneDraftAction|UnsupportedAction,catalog:CatalogPropertyDescription[],includeValues=false){if(action.kind==="unsupported")return action.reason;return action.properties?.map(property=>{const display=automationPropertyDisplay(action,property,catalog);return includeValues?`${display.label}：${display.valueLabel}`:display.label}).join(" · ")||action.label}
function choiceKey(value:SceneValue){return `${typeof value}:${String(value)}`}

export default function AutomationCenter({homeId,homeName,connected,onMessage}:Props){
  const [items,setItems]=useState<XiaomiAutomation[]>(connected?[]:demoAutomations);
  const [loading,setLoading]=useState(connected),[error,setError]=useState("");
  const [selected,setSelected]=useState<XiaomiAutomation|null>(null);
  const [editorId,setEditorId]=useState<string|undefined|null>(null),[draft,setDraft]=useState<EditorState>();
  const [catalog,setCatalog]=useState<Catalog>({actions:[],propertyDescriptions:[],triggerKinds:[],triggerTemplates:[],triggerDevices:[]});
  const [saving,setSaving]=useState(false),[dirty,setDirty]=useState(false),[reviewing,setReviewing]=useState(false);
  const [actionKey,setActionKey]=useState(""),[actionRoom,setActionRoom]=useState("");
  const rooms=useMemo(()=>Array.from(new Set(catalog.actions.map(item=>item.room))),[catalog.actions]);
  const actionOptions=useMemo(()=>catalog.actions.filter(item=>!actionRoom||item.room===actionRoom),[actionRoom,catalog.actions]);

  async function load(){if(!connected||!homeId||homeId==="demo"){setItems(demoAutomations);setLoading(false);return}setLoading(true);setError("");try{const response=await fetch(`/api/xiaomi/automations?homeId=${encodeURIComponent(homeId)}`),data=await response.json();if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SYNC_FAILED");setItems(Array.isArray(data.automations)?data.automations:[]);setSelected(current=>current?(data.automations as XiaomiAutomation[]).find(item=>item.id===current.id)??null:null)}catch(reason){setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR")}finally{setLoading(false)}}
  useEffect(()=>{if(!connected||!homeId||homeId==="demo")return;let active=true;void fetch(`/api/xiaomi/automations?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SYNC_FAILED");if(active){setItems(Array.isArray(data.automations)?data.automations:[]);setLoading(false)}}).catch(reason=>{if(active){setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR");setLoading(false)}});return()=>{active=false}},[homeId,connected]);

  async function openEditor(id?:string){
    if(!connected)return;
    setEditorId(id??"");setDraft(undefined);setDirty(false);setReviewing(false);setError("");setActionKey("");setActionRoom("");
    try{
      const catalogRequest=fetch(`/api/xiaomi/automations/catalog?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data as Catalog});
      const next=id?fetch(`/api/xiaomi/automations/${encodeURIComponent(id)}?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data.draft as EditorState}):Promise.resolve({sceneId:"",homeId,name:"",enabled:false,revision:"",actionsEditable:true,actions:[],triggerEditable:true,triggerLabel:"尚未选择条件",triggerMode:"any",triggerSelections:[]} as EditorState);
      const [loadedCatalog,loadedDraft]=await Promise.all([catalogRequest,next]);
      setCatalog({...loadedCatalog,propertyDescriptions:loadedCatalog.propertyDescriptions??[],triggerTemplates:loadedCatalog.triggerTemplates??[],triggerDevices:(loadedCatalog.triggerDevices??[]).map(device=>({...device,actions:device.actions??[]}))});setDraft(loadedDraft);
    }catch(reason){setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR")}
  }
  function closeEditor(){if(!dirty||window.confirm("放弃尚未保存的自动化修改？")){setEditorId(null);setDraft(undefined);setReviewing(false)}}
  function update(patch:Partial<EditorState>){if(!draft)return;setDraft({...draft,...patch});setDirty(true)}
  function toggleDay(day:number){if(!draft?.schedule)return;const days=draft.schedule.weekdays.includes(day)?draft.schedule.weekdays.filter(item=>item!==day):[...draft.schedule.weekdays,day].sort();if(days.length)update({schedule:{...draft.schedule,weekdays:days}})}
  function toggleSchedule(){if(!draft)return;update({schedule:draft.schedule?undefined:{time:"08:00",weekdays:[1,2,3,4,5,6,7]}})}
  function toggleTriggerTemplate(template:TriggerTemplate){if(!draft)return;const selections=draft.triggerSelections??[],selected=selectedTemplate(draft,template);update({triggerSelections:selected?selections.filter(item=>item.automationId!==template.automationId||item.sourceIndex!==template.sourceIndex):[...selections,{automationId:template.automationId,sourceIndex:template.sourceIndex}]})}
  function addAction(){if(!draft)return;const option=catalog.actions.find(item=>item.key===actionKey);if(!option)return;const action:SceneDraftAction={clientId:crypto.randomUUID(),kind:"set-properties",did:option.did,deviceName:option.deviceName,model:option.model,label:`设置${option.label}`,properties:[{siid:option.siid,piid:option.piid,value:actionValue(option),label:option.label}]};update({actions:[...draft.actions,action]});setActionKey("")}
  function removeAction(index:number){if(draft?.actionsEditable)update({actions:draft.actions.filter((_,item)=>item!==index)})}
  function setPropertyValue(index:number,value:SceneValue){if(!draft)return;const actions=draft.actions.map((action,item)=>item===index&&action.kind==="set-properties"?{...action,properties:action.properties?.map((property,propertyIndex)=>propertyIndex?property:{...property,value})}:action);update({actions})}
  async function save(){
    if(!draft||!draftReady(draft))return;
    setSaving(true);setError("");
    try{
      const editing=Boolean(editorId),body={homeId,name:draft.name.trim(),enabled:draft.enabled,schedule:draft.schedule,triggerSelections:draft.triggerSelections,triggerMode:draft.triggerMode,...(editing?{revision:draft.revision}:{}),...(draft.actionsEditable?{actions:draft.actions.filter((action):action is SceneDraftAction=>action.kind!=="unsupported")}:{})};
      const response=await fetch(editing?`/api/xiaomi/automations/${encodeURIComponent(editorId!)}?homeId=${encodeURIComponent(homeId)}`:"/api/xiaomi/automations",{method:editing?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),data=await response.json();
      if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SAVE_FAILED");
      setDirty(false);setEditorId(null);setDraft(undefined);setReviewing(false);setSelected(data.automation as XiaomiAutomation);await load();onMessage(`${data.automation.name}${editing?"已更新":"已创建"}`);
    }catch(reason){setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR")}finally{setSaving(false)}
  }

  if(editorId!==null&&reviewing&&draft)return <AutomationReview draft={draft} templates={catalog.triggerTemplates} actionCatalog={catalog.propertyDescriptions} saving={saving} error={error} onBack={()=>{setError("");setReviewing(false)}} onCancel={closeEditor} onSave={()=>void save()}/>;
  if(editorId!==null)return <AutomationEditor draft={draft} error={error} triggerKinds={catalog.triggerKinds} triggerTemplates={catalog.triggerTemplates} triggerDevices={catalog.triggerDevices} rooms={rooms} actionRoom={actionRoom} actionOptions={actionOptions} actionCatalog={catalog.propertyDescriptions} actionKey={actionKey} onClose={closeEditor} onUpdate={update} onToggleSchedule={toggleSchedule} onToggleTriggerTemplate={toggleTriggerTemplate} onToggleDay={toggleDay} onActionRoom={setActionRoom} onActionKey={setActionKey} onAddAction={addAction} onRemoveAction={removeAction} onPropertyValue={setPropertyValue} onReview={()=>{setError("");setReviewing(true)}}/>;
  if(selected)return <AutomationDetail automation={selected} homeName={homeName} connected={connected} onBack={()=>setSelected(null)} onEdit={()=>void openEditor(selected.id)}/>;
  const active=items.filter(item=>item.enabled),inactive=items.filter(item=>!item.enabled);
  return <section className="automation-center" aria-label="自动化中心"><header><div><span>AUTOMATION</span><h2>智能自动化</h2><p>{homeName} · 让设备按条件自动响应</p></div><button type="button" disabled={!connected||homeId==="demo"} onClick={()=>void openEditor()}>＋ 新建自动化</button></header>{!connected&&<div className="automation-notice">当前展示米家风格演示数据；扫码连接后会读取当前家庭的真实自动化。</div>}{loading&&<div className="automation-state">正在读取米家自动化…</div>}{error&&<div className="automation-state error" role="alert">{friendlyError(error)} <button onClick={()=>void load()}>重试</button></div>}{!loading&&!error&&!items.length&&<div className="automation-empty"><span>⌁</span><strong>还没有自动化</strong><p>添加条件与动作，让家在合适的时间自动响应。</p></div>}<AutomationGroup title="正在运行" items={active} onOpen={setSelected}/><AutomationGroup title="已停用" items={inactive} onOpen={setSelected}/></section>
}

function AutomationGroup({title,items,onOpen}:{title:string;items:XiaomiAutomation[];onOpen:(item:XiaomiAutomation)=>void}){if(!items.length)return null;return <section className="automation-group"><header><strong>{title}</strong><small>{items.length} 条</small></header><div>{items.map(item=><button type="button" className="automation-card" key={item.id} onClick={()=>onOpen(item)}><span className={`automation-status ${item.enabled?"on":"off"}`}><i/></span><div><strong>{item.name}</strong><small>{item.triggers.map(trigger=>trigger.label).join(item.triggerMode==="all"?" 且 ":" 或 ")}</small><p>{item.actions.slice(0,2).map(action=>action.deviceName||action.label).join("、")||`${item.actionCount} 个动作`}</p></div><b>›</b></button>)}</div></section>}
function AutomationDetail({automation,homeName,connected,onBack,onEdit}:{automation:XiaomiAutomation;homeName:string;connected:boolean;onBack:()=>void;onEdit:()=>void}){return <section className="automation-detail"><header><button onClick={onBack}>← 返回自动化</button>{connected&&<button className="primary" onClick={onEdit}>编辑自动化</button>}</header><div className="automation-detail-title"><span>⌁</span><div><small>{automation.enabled?"正在运行":"已停用"}</small><h2>{automation.name}</h2><p>{homeName}</p></div></div><AutomationFlow automation={automation}/></section>}
function AutomationFlow({automation}:{automation:XiaomiAutomation}){return <div className="automation-flow"><section><header><span>IF</span><div><strong>满足以下条件</strong><small>{automation.triggerMode==="all"?"全部满足":"任一满足"}</small></div></header>{automation.triggers.map((trigger,index)=><div className="automation-flow-row" key={`${trigger.kind}:${index}`}><i>{triggerGlyph(trigger.kind)}</i><div><strong>{trigger.label}</strong>{trigger.detail&&<small>{trigger.detail}</small>}</div>{!trigger.editable&&<em>只读</em>}</div>)}</section><b className="automation-flow-link">↓</b><section><header><span>THEN</span><div><strong>执行以下动作</strong><small>按顺序执行</small></div></header>{automation.actions.map((action,index)=><div className="automation-flow-row" key={index}><i>{index+1}</i><div><strong>{action.deviceName||action.label}</strong><small>{action.details.map(detail=>`${detail.label} ${detail.value}`).join(" · ")||action.label}</small></div></div>)}</section></div>}

function AutomationEditor({
  draft,error,triggerKinds,triggerTemplates,triggerDevices,rooms,actionRoom,actionOptions,actionCatalog,actionKey,onClose,onUpdate,onToggleSchedule,onToggleTriggerTemplate,onToggleDay,onActionRoom,onActionKey,onAddAction,onRemoveAction,onPropertyValue,onReview,
}:{
  draft?:EditorState;error:string;triggerKinds:TriggerKind[];triggerTemplates:TriggerTemplate[];triggerDevices:TriggerDevice[];rooms:string[];actionRoom:string;actionOptions:CatalogAction[];actionCatalog:CatalogPropertyDescription[];actionKey:string;
  onClose:()=>void;onUpdate:(patch:Partial<EditorState>)=>void;onToggleSchedule:()=>void;onToggleTriggerTemplate:(template:TriggerTemplate)=>void;onToggleDay:(day:number)=>void;onActionRoom:(room:string)=>void;
  onActionKey:(key:string)=>void;onAddAction:()=>void;onRemoveAction:(index:number)=>void;onPropertyValue:(index:number,value:SceneValue)=>void;onReview:()=>void;
}){
  const [activeKind,setActiveKind]=useState(""),[deviceKey,setDeviceKey]=useState(""),[showTriggerPicker,setShowTriggerPicker]=useState(false);
  if(!draft)return <section className="automation-editor"><div className="automation-state">正在准备自动化编辑器…</div>{error&&<div className="automation-state error">{friendlyError(error)}</div>}</section>;
  const templatesForKind=triggerTemplates.filter(template=>triggerCategory(template)===activeKind);
  const deviceTemplates=triggerTemplates.filter(template=>template.kind==="device"&&template.deviceKey);
  const templateDevices:TriggerDevice[]=deviceTemplates.map(template=>({key:template.deviceKey!,deviceName:template.deviceName||"未命名设备",room:template.room||"未分配",capabilities:[],actions:[],discovery:"unavailable"}));
  const visibleTriggerDevices=Array.from(new Map<string,TriggerDevice>([
    ...templateDevices.map(device=>[device.key,device] as [string,TriggerDevice]),
    ...triggerDevices.map(device=>[device.key,device] as [string,TriggerDevice]),
  ]).values());
  const activeDeviceTemplates=deviceTemplates.filter(template=>template.deviceKey===deviceKey);
  const activeDevice=visibleTriggerDevices.find(device=>device.key===deviceKey);
  const selectedTemplates=triggerTemplates.filter(template=>selectedTemplate(draft,template));
  const triggerCount=(draft.schedule?1:0)+(draft.triggerSelections?.length??0);
  function closeTriggerPicker(){setShowTriggerPicker(false);setActiveKind("");setDeviceKey("")}
  return <section className="automation-editor automation-editor-single" aria-label={draft.sceneId?"修改自动化":"新建自动化"}>
    <header><button onClick={onClose}>← 返回自动化</button><div><span>AUTOMATION</span><h2>{draft.sceneId?"编辑自动化":"新建自动化"}</h2></div></header>
    <div className="automation-editor-body">
      <section className="automation-editor-section">
        <div className="automation-section-copy"><b>01</b><div><strong>基本信息</strong><p>设置名称与启用状态。新建规则默认关闭。</p></div></div>
        <label className="automation-field"><span>自动化名称</span><input maxLength={50} value={draft.name} placeholder="例如：回家后打开玄关灯" onChange={event=>onUpdate({name:event.target.value})}/></label>
        <label className="automation-enable"><div><strong>启用自动化</strong><small>确认条件和动作无误后再开启</small></div><button type="button" role="switch" aria-label="启用自动化" aria-checked={draft.enabled} className={draft.enabled?"on":""} onClick={()=>onUpdate({enabled:!draft.enabled})}><i/></button></label>
      </section>
      <section className="automation-editor-section">
        <div className="automation-section-copy"><b>02</b><div><strong>触发条件</strong><p>先确认已选条件，需要更多条件时再添加。</p></div></div>
        <div className="automation-selected-panel">
          <div className="automation-selected-heading"><div><strong>已选条件</strong><small>{triggerCount?`共 ${triggerCount} 个条件`:"尚未添加条件"}</small></div><button type="button" aria-expanded={showTriggerPicker} aria-controls="automation-trigger-picker" onClick={()=>showTriggerPicker?closeTriggerPicker():setShowTriggerPicker(true)}>{showTriggerPicker?"完成":"＋ 添加条件"}</button></div>
          {triggerCount>1&&<div className="automation-trigger-mode" role="radiogroup" aria-label="条件关系"><button type="button" role="radio" className={draft.triggerMode==="any"?"selected":""} aria-checked={draft.triggerMode==="any"} onClick={()=>onUpdate({triggerMode:"any"})}>任一条件满足</button><button type="button" role="radio" className={draft.triggerMode==="all"?"selected":""} aria-checked={draft.triggerMode==="all"} onClick={()=>onUpdate({triggerMode:"all"})}>全部条件满足</button></div>}
          {triggerCount?<ul className="automation-selected-triggers">{draft.schedule&&<li className="automation-selected-trigger"><i aria-hidden="true">{triggerGlyph("schedule")}</i><span><strong>{scheduleLabel(draft.schedule)}</strong><small>指定时间</small></span><button type="button" aria-label="移除指定时间条件" onClick={onToggleSchedule}>移除</button></li>}{selectedTemplates.map(template=><li className="automation-selected-trigger" key={template.key}><i aria-hidden="true">{triggerGlyph(triggerCategory(template))}</i><span><strong>{template.deviceName&&`${template.deviceName} · `}{template.label}</strong><small>{template.detail||triggerKinds.find(kind=>kind.kind===triggerCategory(template))?.label||"设备状态变化"}</small></span><button type="button" aria-label={`移除条件：${template.label}`} onClick={()=>onToggleTriggerTemplate(template)}>移除</button></li>)}</ul>:<div className="automation-condition-empty">点击“添加条件”选择触发方式</div>}
        </div>
        {showTriggerPicker&&<div className="automation-trigger-builder" id="automation-trigger-picker">
          <div className="automation-builder-heading"><strong>添加条件</strong><small>先选择类别，再选择具体条件</small></div>
          <div className="automation-trigger-kinds" aria-label="触发条件类别">{triggerKinds.map(kind=>{const count=kind.kind==="schedule"?(draft.schedule?1:0):triggerTemplates.filter(template=>triggerCategory(template)===kind.kind&&selectedTemplate(draft,template)).length;return <button type="button" key={kind.kind} className={activeKind===kind.kind?"selected":""} aria-pressed={activeKind===kind.kind} onClick={()=>{setActiveKind(kind.kind);if(kind.kind!=="device")setDeviceKey("")}}><i aria-hidden="true">{triggerGlyph(kind.kind)}</i><span><strong>{kind.label}</strong><small>{count?`已选择 ${count} 项`:kind.kind==="device"?"先选择设备":"选择具体条件"}</small></span><b aria-hidden="true">›</b></button>})}</div>
          {activeKind&&<div className="automation-trigger-config">
            {activeKind==="schedule"&&<><div className="automation-config-title"><div><strong>指定时间</strong><small>按指定时间和星期触发</small></div><button type="button" className={draft.schedule?"selected":""} aria-pressed={Boolean(draft.schedule)} onClick={onToggleSchedule}>{draft.schedule?"移除":"选择"}</button></div>{draft.schedule&&<label className="automation-time"><span>指定时间</span><input type="time" value={draft.schedule.time} onChange={event=>onUpdate({schedule:{...draft.schedule!,time:event.target.value}})}/></label>}</>}
            {activeKind==="device"&&<><div className="automation-config-title"><div><strong>{deviceKey?"选择状态变化与动作":"选择设备"}</strong><small>{deviceKey?"优先来自米家当前设备的私有自动化目录":"显示当前家庭已同步的物理设备"}</small></div>{deviceKey&&<button type="button" onClick={()=>setDeviceKey("")}>重新选设备</button>}</div>{!deviceKey&&<div className="automation-device-picker">{visibleTriggerDevices.map(device=><button type="button" key={device.key} onClick={()=>setDeviceKey(device.key)}><i>▣</i><span><strong>{device.deviceName}</strong><small>{device.room} · {discoverySummary(device)}</small></span><b>›</b></button>)}</div>}{!deviceKey&&!visibleTriggerDevices.length&&<div className="automation-readonly"><strong>当前家庭暂无已同步设备</strong><p>请返回设备页重新同步后再试。</p></div>}{deviceKey&&<>{activeDeviceTemplates.length>0&&<div className="automation-capability-group"><strong>可直接使用的真实条件</strong><TriggerTemplatePicker templates={activeDeviceTemplates} draft={draft} onToggle={onToggleTriggerTemplate}/></div>}<div className="automation-capability-group"><strong>米家支持的状态变化</strong>{activeDevice?.capabilities.length?<div className="automation-discovered-capabilities">{activeDevice.capabilities.map(capability=><div key={capability.key}><span><strong>{capability.label}</strong><small>{capability.detail}</small></span><em>{catalogSourceLabel(capability.source)}</em></div>)}</div>:<div className="automation-readonly"><strong>{activeDevice?.discovery==="unavailable"?"自动化目录暂时不可用":"米家目录未声明设备条件"}</strong><p>{activeDeviceTemplates.length?"仍可使用从已有自动化确认的真实条件。":"目前没有可展示的状态变化。"}</p></div>}</div>{Boolean(activeDevice?.actions.length)&&<div className="automation-capability-group"><strong>米家支持的执行动作</strong><div className="automation-discovered-capabilities">{activeDevice!.actions.map(action=><div key={action.key}><span><strong>{action.label}</strong><small>{action.detail}</small></span><em>{catalogSourceLabel(action.source)}</em></div>)}</div></div>}{!activeDeviceTemplates.length&&Boolean(activeDevice?.capabilities.length)&&<div className="automation-capability-note">这些条件已由米家自动化目录或 MIoT 规格确认。条件详情可以查看；新建时仍只提交已经从真实自动化验证过完整节点的数据。</div>}</>}</>}
            {activeKind!=="schedule"&&activeKind!=="device"&&<><div className="automation-config-title"><div><strong>{triggerKinds.find(kind=>kind.kind===activeKind)?.label}</strong><small>来自当前家庭已有自动化的安全模板</small></div></div>{templatesForKind.length?<TriggerTemplatePicker templates={templatesForKind} draft={draft} onToggle={onToggleTriggerTemplate}/>:<div className="automation-readonly"><strong>暂无可配置条件</strong><p>米家云尚未返回这个类别的可安全复用参数。</p></div>}</>}
          </div>}
        </div>}
      </section>
      <section className="automation-editor-section">
        <div className="automation-section-copy"><b>03</b><div><strong>生效日期</strong><p>设置指定时间条件在哪些星期生效。</p></div></div>
        {draft.schedule?<><div className="automation-weekdays">{["一","二","三","四","五","六","日"].map((label,index)=><button type="button" className={draft.schedule!.weekdays.includes(index+1)?"selected":""} aria-pressed={draft.schedule!.weekdays.includes(index+1)} onClick={()=>onToggleDay(index+1)} key={label}>周{label}</button>)}</div><div className="automation-period"><span>生效时段</span><strong>全天</strong><small>使用中国标准时间（Asia/Shanghai）</small></div></>:<div className="automation-date-empty"><span>不使用指定时间</span><small>设备、天气和位置条件会沿用其米家原始参数。</small></div>}
      </section>
      <section className="automation-editor-section">
        <div className="automation-section-copy"><b>04</b><div><strong>执行动作</strong><p>动作按顺序执行，只提供规格明确公开的安全设置。</p></div></div>
        <div className="automation-action-list">{draft.actions.map((action,index)=><div key={action.clientId} className={action.kind==="unsupported"?"readonly":""}><b>{index+1}</b><div><strong>{action.deviceName||action.label}</strong><small>{actionPropertySummary(action,actionCatalog)}</small>{action.kind==="set-properties"&&action.properties?.[0]&&<SimpleValue action={action} catalog={actionCatalog} index={index} onChange={onPropertyValue}/>}</div>{draft.actionsEditable&&<button aria-label={`删除动作 ${index+1}：${action.deviceName||action.label}，${actionPropertySummary(action,actionCatalog)}`} onClick={()=>onRemoveAction(index)}>删除</button>}</div>)}</div>
        {draft.actionsEditable&&<div className="automation-add-action"><select aria-label="筛选动作房间" value={actionRoom} onChange={event=>onActionRoom(event.target.value)}><option value="">全部房间</option>{rooms.map(room=><option value={room} key={room}>{room}</option>)}</select><select aria-label="选择设备动作" value={actionKey} onChange={event=>onActionKey(event.target.value)}><option value="">选择设备和设置</option>{actionOptions.map(option=><option value={option.key} key={option.key}>{option.room} · {option.deviceName} · {option.label}</option>)}</select><button type="button" disabled={!actionKey} onClick={onAddAction}>加入动作</button></div>}
      </section>
      {error&&<div className="automation-state error" role="alert">{friendlyError(error)}</div>}
    </div>
    <footer><button onClick={onClose}>取消</button><button className="primary" disabled={!draftReady(draft)} onClick={onReview}>下一步：检查</button></footer>
  </section>
}

function TriggerTemplatePicker({templates,draft,onToggle}:{templates:TriggerTemplate[];draft:EditorState;onToggle:(template:TriggerTemplate)=>void}){return <div className="automation-trigger-templates">{templates.map(template=>{const selected=selectedTemplate(draft,template);return <button type="button" key={template.key} className={selected?"selected":""} aria-pressed={selected} onClick={()=>onToggle(template)}><span>{template.label}</span>{template.detail&&<small>{template.detail}</small>}<b>{selected?"✓":"＋"}</b></button>})}</div>}

function AutomationReview({draft,templates,actionCatalog,saving,error,onBack,onCancel,onSave}:{draft:EditorState;templates:TriggerTemplate[];actionCatalog:CatalogPropertyDescription[];saving:boolean;error:string;onBack:()=>void;onCancel:()=>void;onSave:()=>void}){
  const selected=templates.filter(template=>selectedTemplate(draft,template));
  const conditions=[...(draft.schedule?[scheduleLabel(draft.schedule)]:[]),...selected.map(template=>`${template.deviceName?`${template.deviceName} · `:""}${template.label}`)];
  return <section className="automation-editor automation-review-page" aria-label="检查自动化">
    <header><button onClick={onBack}>← 返回编辑</button><div><span>REVIEW</span><h2>检查自动化</h2></div></header>
    <div className="automation-editor-body">
      <div className="automation-review-heading"><span>✓</span><div><h3>{draft.name}</h3><p>{draft.enabled?"保存后启用":"保存后保持停用"}</p></div></div>
      <div className="automation-review-flow"><section><header><b>IF</b><div><strong>{draft.triggerMode==="all"?"全部条件满足":"任一条件满足"}</strong><small>{conditions.length} 个条件</small></div></header>{conditions.map((condition,index)=><div className="automation-review-row" key={`${condition}:${index}`}><i>{index+1}</i><strong>{condition}</strong></div>)}</section><section><header><b>THEN</b><div><strong>按顺序执行</strong><small>{draft.actions.length} 个动作</small></div></header>{draft.actions.map((action,index)=><div className="automation-review-row" key={action.clientId}><i>{index+1}</i><div><strong>{action.deviceName||action.label}</strong><small>{actionPropertySummary(action,actionCatalog,true)}</small></div></div>)}</section></div>
      <div className="automation-save-note">提交后会从米家云重新读取；只有名称、条件与动作回读一致才会报告成功。</div>
      {error&&<div className="automation-state error" role="alert">{friendlyError(error)}</div>}
    </div>
    <footer><button onClick={onCancel}>取消</button><button className="primary" disabled={saving} onClick={onSave}>{saving?"正在保存并回读…":draft.sceneId?"确认保存修改":"确认创建自动化"}</button></footer>
  </section>
}

function SimpleValue({action,catalog,index,onChange}:{action:SceneDraftAction;catalog:CatalogPropertyDescription[];index:number;onChange:(index:number,value:SceneValue)=>void}){const property=action.properties?.[0];if(!property)return null;const display=automationPropertyDisplay(action,property,catalog),choices=display.descriptor?.choices;if(display.descriptor?.editable===false)return <span className="automation-value-readonly">当前值：{display.valueLabel}</span>;if(choices?.length)return <select aria-label={`设置${action.deviceName||action.label}的${display.label}`} className="automation-value-input" value={choiceKey(property.value)} onChange={event=>{const choice=choices.find(item=>choiceKey(item.value)===event.target.value);if(choice)onChange(index,choice.value)}}>{choices.map(choice=><option value={choiceKey(choice.value)} key={choiceKey(choice.value)}>{choice.label}</option>)}</select>;if(typeof property.value==="boolean")return <button type="button" aria-label={`设置${action.deviceName||action.label}的${display.label}，当前为${display.valueLabel}`} className={`automation-value-switch ${property.value?"on":""}`} onClick={()=>onChange(index,!property.value)}>{display.valueLabel}</button>;return <input aria-label={`设置${action.deviceName||action.label}的${display.label}`} className="automation-value-input" type={display.descriptor?.range?"number":"text"} min={display.descriptor?.range?.min} max={display.descriptor?.range?.max} step={display.descriptor?.range?.step} value={String(property.value)} onChange={event=>onChange(index,typeof property.value==="number"?Number(event.target.value):event.target.value)}/>}
