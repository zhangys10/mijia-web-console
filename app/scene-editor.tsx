"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ManagedDevice } from "../lib/device-management";
import type { MiotCapabilityGroup, MiotCapabilityProperty } from "../lib/miot-spec";
import type { ManualScene } from "../lib/xiaomi-scenes";
import type { SceneDraftAction, SceneEditorDraft, SceneValue } from "../lib/xiaomi-scene-editor";
import { listSceneWritableProperties, mapScenePropertySemantics, mapScenePropertySemanticsResult, scenePropertySemantic, scenePropertySemantics, type ScenePropertySemantic, type ScenePropertyMappingFailure } from "../lib/xiaomi-scene-properties";
import { parseDerivedDeviceId } from "../lib/device-topology";
import { groupSceneDraftActions } from "../lib/scene-action-groups";
import type { SceneActionCatalogDevice, SceneActionCatalogProperty, SceneActionCatalogTemplate } from "../lib/xiaomi-scene-action-catalog";

type Specification = { loading:boolean;groups:MiotCapabilityGroup[];error?:string };
type SelectedProperty = ScenePropertySemantic & { key:string;groupLabel:string;capability:MiotCapabilityProperty };
type TargetOption = { key:string;device:ManagedDevice & {did:string};preferredService?:{name:string;siid:number};groupLabel?:string };
type ComposerMode = "single"|"batch";
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

function firstValue(property: MiotCapabilityProperty): SceneValue {
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
  if (error === "XIAOMI_SCENE_ACTION_CATALOG_MISMATCH") return "该动作已不在设备当前官方目录中，请重新选择。";
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
function targetOptionKey(did:string,preferredService?:{name:string;siid:number}){return preferredService?`${did}::${preferredService.name}:${preferredService.siid}`:did}

async function fetchDeviceSpecification(device:ManagedDevice):Promise<Specification>{
  try{
    const query=new URLSearchParams({model:device.detail});if(device.urn)query.set("urn",device.urn);
    const response=await fetch(`/api/xiaomi/spec?${query}`);const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||"MIOT_SPEC_UNAVAILABLE");
    return {loading:false,groups:Array.isArray(data.groups)?data.groups:[]};
  }catch(reason){return {loading:false,groups:[],error:reason instanceof Error?reason.message:"MIOT_SPEC_UNAVAILABLE"}}
}

function supportsSemantics(specification:Specification|undefined,semantics:ScenePropertySemantic[],targetDid?:string){
  if(!specification||specification.error)return false;
  if(!semantics.length)return specification.groups.some(group=>listSceneWritableProperties(group).length>0);
  return Boolean(mapScenePropertySemantics(semantics,specification.groups,undefined,targetDid));
}

function semanticOnly(property:SelectedProperty):ScenePropertySemantic{return {serviceName:property.serviceName,propertyName:property.propertyName,label:property.label,kind:property.kind,value:property.value,...(property.choice?{choice:property.choice}:{}),...(property.source?{source:property.source}:{})}}

function mappingFailureText(reason:ScenePropertyMappingFailure){
  return ({"property-unavailable":"缺少所选属性","property-not-writable":"属性不可写","choice-label-missing":"没有对应的枚举选项","choice-label-ambiguous":"枚举选项名称不唯一","value-unsupported":"不支持所选数值"} as const)[reason];
}

function actionSummary(action: SceneEditorDraft["actions"][number]) {
  if (action.kind === "set-properties") return `${action.properties?.length ?? 0} 个设备属性`;
  if (action.kind === "invoke-action") return action.label;
  return "reason" in action ? action.reason : "暂不支持的动作";
}

function catalogTemplateMatchesAction(template:SceneActionCatalogTemplate,action:SceneDraftAction){
  if(template.kind!==action.kind)return false;
  if(action.kind==="invoke-action")return template.siid===action.siid&&template.aiid===action.aiid;
  const properties=template.properties;if(!properties||properties.length!==action.properties?.length)return false;
  return properties.every((property,index)=>{const current=action.properties?.[index];return current?.siid===property.siid&&current.piid===property.piid&&(property.configurable||current.value===property.value)});
}

function catalogAction(template:SceneActionCatalogTemplate,device:SceneActionCatalogDevice,current?:SceneDraftAction):SceneDraftAction{
  const base={clientId:current?.clientId||newActionId(),...(current?.sourceIndex===undefined||current.kind!==template.kind?{}:{sourceIndex:current.sourceIndex}),kind:template.kind,did:device.did,deviceName:device.deviceName,model:device.model,label:template.label,templateKey:template.key};
  if(template.kind==="invoke-action")return {...base,kind:"invoke-action",siid:template.siid,aiid:template.aiid};
  return {...base,kind:"set-properties",properties:(template.properties??[]).map((property,index)=>({siid:property.siid,piid:property.piid,value:property.configurable&&current?.kind==="set-properties"&&current.properties?.[index]?.siid===property.siid&&current.properties[index].piid===property.piid?current.properties[index].value:property.value??(property.format==="bool"?true:property.range?.min??property.choices?.[0]?.value??""),label:property.label}))};
}

function catalogSourceLabel(source:SceneActionCatalogDevice["source"]){return source==="tca-v3"?"Device catalog":source==="model-catalog"?"Model catalog":source==="miot-spec"?"MIoT Spec":"Unavailable"}
function catalogSpecProperty(property:SceneActionCatalogProperty):MiotCapabilityProperty{return {key:`${property.siid}.${property.piid}`,name:property.name,label:property.label,siid:property.siid,piid:property.piid,format:property.format,readable:true,writable:true,notify:false,...(property.unit?{unit:property.unit}:{}),...(property.choices?{choices:property.choices}:{}),...(property.range?{range:property.range}:{})}}
function catalogValueLabel(property:SceneActionCatalogProperty,value:SceneValue|undefined){return property.choices?.find(choice=>choice.value===value)?.label??String(value)}

export default function SceneEditor({ homeId, homeName, devices, sceneId, onClose, onSaved }: Props) {
  const [draft,setDraft]=useState<SceneEditorDraft|undefined>(()=>sceneId?undefined:{sceneId:"",homeId,name:"",enabled:true,revision:"",actionsEditable:true,actions:[]});
  const [loading,setLoading]=useState(Boolean(sceneId));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [dirty,setDirty]=useState(false);
  const [actionsDirty,setActionsDirty]=useState(false);
  const [composerOpen,setComposerOpen]=useState(false);
  const [composerMode,setComposerMode]=useState<ComposerMode>("single");
  const [working,setWorking]=useState<SceneDraftAction|undefined>();
  const [workingIndices,setWorkingIndices]=useState<number[]>([]);
  const [selectedTargetKeys,setSelectedTargetKeys]=useState<string[]>([]);
  const [selectedProperties,setSelectedProperties]=useState<SelectedProperty[]>([]);
  const [pendingProperties,setPendingProperties]=useState<SceneDraftAction["properties"]>();
  const [deviceSpecs,setDeviceSpecs]=useState<Record<string,Specification>>({});
  const [specsLoading,setSpecsLoading]=useState(false);
  const [specReload,setSpecReload]=useState(0);
  const [specsError,setSpecsError]=useState("");
  const [composerError,setComposerError]=useState("");
  const [addPropertyKey,setAddPropertyKey]=useState("");
  const [deviceRoom,setDeviceRoom]=useState("");
  const [deviceKind,setDeviceKind]=useState("");
  const [actionCatalog,setActionCatalog]=useState<SceneActionCatalogDevice[]>([]);
  const [catalogLoading,setCatalogLoading]=useState(false);
  const [catalogError,setCatalogError]=useState("");
  const [singleDeviceDid,setSingleDeviceDid]=useState("");
  const [singleDeviceRoom,setSingleDeviceRoom]=useState("");
  const [singleDeviceKind,setSingleDeviceKind]=useState("");
  const [singleAction,setSingleAction]=useState<SceneDraftAction|undefined>();
  const requestId=useRef(0);
  const candidates=useMemo(()=>editableDevices(devices,homeId),[devices,homeId]);
  const deviceRooms=useMemo(()=>Array.from(new Set(candidates.map(device=>device.room))).sort((left,right)=>left.localeCompare(right,"zh-CN")),[candidates]);
  const deviceKinds=useMemo(()=>Array.from(new Set(candidates.map(device=>deviceKindGroup(device.kind)))).sort((left,right)=>deviceKindLabel(left).localeCompare(deviceKindLabel(right),"zh-CN")),[candidates]);
  const singleDeviceRooms=useMemo(()=>Array.from(new Set(actionCatalog.map(device=>device.room))).sort((left,right)=>left.localeCompare(right,"zh-CN")),[actionCatalog]);
  const singleDeviceKinds=useMemo(()=>Array.from(new Set(actionCatalog.flatMap(device=>{const kind=candidates.find(candidate=>candidate.did===device.did)?.kind;return kind?[deviceKindGroup(kind)]:[]}))).sort((left,right)=>deviceKindLabel(left).localeCompare(deviceKindLabel(right),"zh-CN")),[actionCatalog,candidates]);
  const filteredSingleDevices=useMemo(()=>actionCatalog.filter(device=>{const kind=candidates.find(candidate=>candidate.did===device.did)?.kind;return (!singleDeviceRoom||device.room===singleDeviceRoom)&&(!singleDeviceKind||Boolean(kind&&deviceKindGroup(kind)===singleDeviceKind))}),[actionCatalog,candidates,singleDeviceKind,singleDeviceRoom]);
  const selectedSemantics=useMemo(()=>selectedProperties.map(semanticOnly),[selectedProperties]);
  const propertyCatalog=useMemo(()=>{const catalog=new Map<string,{key:string;serviceName:string;propertyName:string;groupLabel:string;label:string;capability:MiotCapabilityProperty;sourceDid:string}>();for(const device of candidates){const specification=deviceSpecs[device.did];for(const group of specification?.groups??[]){for(const property of listSceneWritableProperties(group)){const key=`${group.name}:${property.name}`;if(!catalog.has(key))catalog.set(key,{key,serviceName:group.name,propertyName:property.name,groupLabel:group.label,label:property.label,capability:property,sourceDid:device.did})}}}return [...catalog.values()].sort((left,right)=>left.groupLabel.localeCompare(right.groupLabel,"zh-CN")||left.label.localeCompare(right.label,"zh-CN"))},[candidates,deviceSpecs]);
  const targetOptions=useMemo<TargetOption[]>(()=>candidates.flatMap(device=>{const specification=deviceSpecs[device.did];if(!specification||specification.error)return [];if(!selectedSemantics.length)return supportsSemantics(specification,[],device.did)?[{key:device.did,device}]:[];const repeatedService=selectedSemantics.map(semantic=>semantic.serviceName).find(name=>specification.groups.filter(group=>group.name===name).length>1);if(!repeatedService)return mapScenePropertySemantics(selectedSemantics,specification.groups,undefined,device.did)?[{key:device.did,device}]:[];return specification.groups.filter(group=>group.name===repeatedService).flatMap(group=>{const siid=group.properties[0]?.siid;if(!siid)return [];const preferredService={name:repeatedService,siid};return mapScenePropertySemantics(selectedSemantics,specification.groups,preferredService,device.did)?[{key:targetOptionKey(device.did,preferredService),device,preferredService,groupLabel:group.label}]:[]})}),[candidates,deviceSpecs,selectedSemantics]);
  const incompatibilities=useMemo(()=>selectedSemantics.length?candidates.flatMap(device=>{const specification=deviceSpecs[device.did];if(!specification||specification.error)return [{did:device.did,name:device.name,reason:"设备能力不可用"}];if(targetOptions.some(option=>option.device.did===device.did))return [];const result=mapScenePropertySemanticsResult(selectedSemantics,specification.groups,undefined,device.did);return [{did:device.did,name:device.name,reason:result.ok?"没有兼容的具体服务":mappingFailureText(result.reason)}]}):[],[candidates,deviceSpecs,selectedSemantics,targetOptions]);
  const filteredTargetOptions=useMemo(()=>targetOptions.filter(option=>(!deviceRoom||option.device.room===deviceRoom)&&(!deviceKind||deviceKindGroup(option.device.kind)===deviceKind)),[deviceKind,deviceRoom,targetOptions]);
  const groupableActions=useMemo(()=>(draft?.actions??[]).map(action=>{if(action.kind!=="set-properties"||!action.properties?.length)return action;const specification=deviceSpecs[action.did],semantics=specification&&scenePropertySemantics(action.properties,specification.groups,action.did),device=candidates.find(item=>item.did===action.did);if(!semantics||!specification)return action;const switchGroup=specification.groups.find(group=>group.name==="switch"&&action.properties?.some(property=>group.properties.some(candidate=>candidate.siid===property.siid&&candidate.piid===property.piid)));return {...action,...(switchGroup?{deviceName:`${device?.name??action.deviceName} · ${switchGroup.label}`}:{ }),properties:action.properties.map((property,index)=>({...property,label:semantics[index]?.label??property.label,...(semantics[index]?.kind==="enum"&&semantics[index]?.choice?{value:`enum:${semantics[index].choice.key}`}:{})}))}}),[candidates,deviceSpecs,draft?.actions]);
  const actionGroups=useMemo(()=>groupSceneDraftActions(groupableActions,devices.filter(device=>device.homeId===homeId)),[devices,groupableActions,homeId]);
  const singleCatalogDevice=useMemo(()=>actionCatalog.find(device=>device.did===singleDeviceDid),[actionCatalog,singleDeviceDid]);
  const selectedSingleTemplate=useMemo(()=>singleCatalogDevice?.actions.find(template=>template.key===singleAction?.templateKey),[singleAction?.templateKey,singleCatalogDevice]);

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
    let active=true;
    void fetch(`/api/xiaomi/scenes/action-catalog?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||"XIAOMI_SCENE_ACTION_CATALOG_UNAVAILABLE");if(active)setActionCatalog(Array.isArray(data.devices)?data.devices:[])}).catch(reason=>{if(active){setActionCatalog([]);setCatalogError(reason instanceof Error?reason.message:"XIAOMI_SCENE_ACTION_CATALOG_UNAVAILABLE")}}).finally(()=>{if(active)setCatalogLoading(false)});
    return()=>{active=false};
  },[composerOpen,homeId]);

  useEffect(()=>{
    if(!composerOpen&&!sceneId)return;
    let active=true;const id=++requestId.current;
    const byModel=new Map<string,Promise<Specification>>();
    for(const device of candidates){const key=`${device.detail}:${device.urn??""}`;if(!byModel.has(key))byModel.set(key,fetchDeviceSpecification(device))}
    void Promise.all(candidates.map(async device=>{const specification=await byModel.get(`${device.detail}:${device.urn??""}`)!;return [device.did,specification] as const})).then(entries=>{if(active&&id===requestId.current){setDeviceSpecs(Object.fromEntries(entries));if(!entries.some(([,item])=>!item.error))setSpecsError("暂时无法读取可用于场景的设备能力。")}}).finally(()=>{if(active&&id===requestId.current)setSpecsLoading(false)});
    return()=>{active=false};
  },[candidates,composerOpen,sceneId,specReload]);

  useEffect(()=>{
    if(composerMode!=="batch"||!pendingProperties||!working||specsLoading)return;
    let active=true;void Promise.resolve().then(()=>{if(!active)return;const specification=deviceSpecs[working.did];const semantics=specification&&scenePropertySemantics(pendingProperties,specification.groups,working.did);if(!specification||!semantics){setComposerError("无法识别原动作中的属性，该动作暂不能批量修改。");setPendingProperties(undefined);return}const selections=semantics.flatMap(semantic=>{const group=specification.groups.find(item=>item.name===semantic.serviceName),property=group?.properties.find(item=>item.name===semantic.propertyName);return group&&property?[{...semantic,key:`${semantic.serviceName}:${semantic.propertyName}`,groupLabel:group.label,capability:property}]:[]});const keys=workingIndices.flatMap(index=>{const action=draft?.actions[index];if(!action||action.kind==="unsupported"||!action.properties?.length)return [];const actionSpec=deviceSpecs[action.did],actionSemantics=actionSpec&&scenePropertySemantics(action.properties,actionSpec.groups,action.did);if(!actionSpec||!actionSemantics)return [];const serviceName=actionSemantics[0]?.serviceName,group=actionSpec.groups.find(item=>item.name===serviceName&&action.properties?.some(property=>item.properties.some(candidate=>candidate.siid===property.siid&&candidate.piid===property.piid)));const repeated=serviceName&&actionSpec.groups.filter(item=>item.name===serviceName).length>1,preferredService=repeated&&group?{name:serviceName,siid:group.properties[0]?.siid}:undefined;return [targetOptionKey(action.did,preferredService?.siid?preferredService:undefined)]});setSelectedProperties(selections);setSelectedTargetKeys(Array.from(new Set(keys)));setPendingProperties(undefined)});return()=>{active=false};
  },[composerMode,deviceSpecs,draft?.actions,pendingProperties,specsLoading,working,workingIndices]);

  useEffect(()=>{
    if(!composerOpen||composerMode!=="single"||catalogLoading||!singleDeviceDid)return;
    let active=true;void Promise.resolve().then(()=>{if(!active)return;const device=actionCatalog.find(item=>item.did===singleDeviceDid);if(!device)return;if(singleAction?.templateKey&&device.actions.some(template=>template.key===singleAction.templateKey))return;const current=workingIndices.length===1?working:undefined;const template=current&&device.actions.find(item=>catalogTemplateMatchesAction(item,current));if(template)setSingleAction(catalogAction(template,device,current))});return()=>{active=false};
  },[actionCatalog,catalogLoading,composerMode,composerOpen,singleAction?.templateKey,singleDeviceDid,working,workingIndices.length]);

  function selectTarget(key:string){
    if(!targetOptions.some(option=>option.key===key))return;
    setSelectedTargetKeys(current=>current.includes(key)?current.filter(item=>item!==key):[...current,key]);setComposerError("");
  }

  function startAdd(){
    setComposerOpen(true);setComposerMode("single");setCatalogLoading(true);setCatalogError("");setSpecsLoading(true);setSpecReload(current=>current+1);setSpecsError("");setWorkingIndices([]);setSelectedTargetKeys([]);setSelectedProperties([]);setPendingProperties(undefined);setWorking(undefined);setSingleDeviceDid("");setSingleDeviceRoom("");setSingleDeviceKind("");setSingleAction(undefined);setAddPropertyKey("");setDeviceRoom("");setDeviceKind("");setComposerError("");
  }

  function startEdit(action:SceneDraftAction,indices:number[]){
    const device=candidates.find(item=>item.did===action.did);
    const mode=indices.length>1?"batch":"single";setComposerOpen(true);setComposerMode(mode);setCatalogLoading(true);setCatalogError("");setSpecsLoading(true);setSpecReload(current=>current+1);setSpecsError("");setWorkingIndices(indices);setSelectedTargetKeys([]);setSelectedProperties([]);setPendingProperties(mode==="batch"?structuredClone(action.properties):undefined);setWorking({...structuredClone(action),...(device?{deviceName:device.name,model:device.detail}:{})});setSingleDeviceDid(action.did);setSingleAction(undefined);setAddPropertyKey("");setComposerError("");
    if(device){setDeviceRoom(device.room);setDeviceKind(deviceKindGroup(device.kind))}
  }

  function switchComposerMode(mode:ComposerMode){
    if(mode===composerMode||workingIndices.length>1)return;
    if(mode==="batch"){
      if(working?.kind==="invoke-action"){setComposerError("调用设备动作不支持批量修改。");return}
      setPendingProperties(structuredClone(singleAction?.kind==="set-properties"?singleAction.properties:working?.properties));setSpecsLoading(true);setSpecReload(current=>current+1);
    }
    setComposerMode(mode);setComposerError("");
  }

  function selectSingleDevice(did:string){setSingleDeviceDid(did);setSingleAction(undefined);setComposerError("")}

  function selectSingleTemplate(key:string){
    const device=actionCatalog.find(item=>item.did===singleDeviceDid),template=device?.actions.find(item=>item.key===key);if(!device||!template)return;
    setSingleAction(catalogAction(template,device,workingIndices.length===1?working:undefined));setComposerError("");
  }

  function setSinglePropertyValue(index:number,value:SceneValue){
    if(singleAction?.kind!=="set-properties"||!singleAction.properties)return;
    setSingleAction({...singleAction,properties:singleAction.properties.map((property,itemIndex)=>itemIndex===index?{...property,value}:property)});
  }

  function commitSingle(){
    if(!draft||!singleAction||!selectedSingleTemplate)return;
    const removed=new Set(workingIndices),actions=draft.actions.filter((_,index)=>!removed.has(index));const insertion=workingIndices.length?Math.min(...workingIndices):actions.length;actions.splice(insertion,0,singleAction);setDraft({...draft,actions});setDirty(true);setActionsDirty(true);cancelComposer();
  }

  function addProperty(){
    const entry=propertyCatalog.find(item=>item.key===addPropertyKey);if(!entry)return;
    const semantic=scenePropertySemantic(entry.serviceName,entry.capability,firstValue(entry.capability),entry.sourceDid);if(!semantic)return;
    updateSelectedProperties([...selectedProperties,{...semantic,key:entry.key,groupLabel:entry.groupLabel,capability:entry.capability}]);setAddPropertyKey("");
  }

  function setPropertyValue(index:number,value:SceneValue){
    updateSelectedProperties(selectedProperties.map((property,itemIndex)=>{if(itemIndex!==index)return property;const semantic=scenePropertySemantic(property.serviceName,property.capability,value,property.source?.did);return semantic?{...property,...semantic}:property}));
  }

  function updateSelectedProperties(next:SelectedProperty[]){
    const semantics=next.map(semanticOnly);
    const compatible=selectedTargetKeys.filter(key=>{const option=targetOptions.find(item=>item.key===key),specification=option&&deviceSpecs[option.device.did];return Boolean(option&&specification&&mapScenePropertySemantics(semantics,specification.groups,option.preferredService,option.device.did))});
    setSelectedProperties(next);setSelectedTargetKeys(compatible);setComposerError(compatible.length<selectedTargetKeys.length?`已取消 ${selectedTargetKeys.length-compatible.length} 个不支持当前属性或数值的目标。`:"");
  }

  async function commitWorking(){
    if(!draft||saving||!selectedProperties.length)return;
    const targets=selectedTargetKeys.flatMap(key=>{const option=targetOptions.find(item=>item.key===key);return option?[option]:[]});
    if(!targets.length)return;
    const semantics=selectedProperties.map(semanticOnly);
    const nextCount=draft.actions.length-workingIndices.length+targets.length;
    if(nextCount>64){setComposerError("场景最多支持 64 个真实动作，请减少目标设备。");return}
    setSaving(true);setComposerError("");
    try{
      const existing=new Map(workingIndices.flatMap(index=>{const action=draft.actions[index];if(!action||action.kind==="unsupported"||!action.properties?.length)return [];const specification=deviceSpecs[action.did],semantics=specification&&scenePropertySemantics(action.properties,specification.groups,action.did),serviceName=semantics?.[0]?.serviceName,group=specification?.groups.find(item=>item.name===serviceName&&action.properties?.some(property=>item.properties.some(candidate=>candidate.siid===property.siid&&candidate.piid===property.piid))),preferred=serviceName&&group&&specification!.groups.filter(item=>item.name===serviceName).length>1?{name:serviceName,siid:group.properties[0]?.siid}:undefined;return [[targetOptionKey(action.did,preferred?.siid?preferred:undefined),action] as const]}));
      const expanded:SceneDraftAction[]=targets.map(option=>{
        const device=option.device,specification=deviceSpecs[device.did];
        if(!specification||specification.error)throw new Error(`${device.name} 的设备能力暂不可用`);
        const properties=mapScenePropertySemantics(semantics,specification.groups,option.preferredService,device.did);
        if(!properties)throw new Error(`${device.name} 不支持全部所选属性`);
        const source=existing.get(option.key);
        return {clientId:source?.clientId||newActionId(),...(source?.sourceIndex===undefined?{}:{sourceIndex:source.sourceIndex}),kind:"set-properties",did:device.did,deviceName:option.groupLabel?`${device.name} · ${option.groupLabel}`:device.name,model:device.detail,label:"设置设备属性",properties};
      });
      const removed=new Set(workingIndices),actions=draft.actions.filter((_,index)=>!removed.has(index));
      const insertion=workingIndices.length?Math.min(...workingIndices):actions.length;
      actions.splice(insertion,0,...expanded);
      setDraft({...draft,actions});setComposerOpen(false);setWorking(undefined);setWorkingIndices([]);setSelectedTargetKeys([]);setSelectedProperties([]);setDirty(true);setActionsDirty(true);
    }catch(reason){setComposerError(reason instanceof Error?reason.message:"批量动作生成失败")}
    finally{setSaving(false)}
  }

  function removeActions(indices:number[]){if(!draft)return;const removed=new Set(indices);setDraft({...draft,actions:draft.actions.filter((_,item)=>!removed.has(item))});setDirty(true);setActionsDirty(true)}
  function moveAction(index:number,direction:-1|1){if(!draft)return;const target=index+direction;if(target<0||target>=draft.actions.length)return;const actions=[...draft.actions];[actions[index],actions[target]]=[actions[target],actions[index]];setDraft({...draft,actions});setDirty(true);setActionsDirty(true)}
  function cancelComposer(){setComposerOpen(false);setWorking(undefined);setWorkingIndices([]);setSelectedTargetKeys([]);setSelectedProperties([]);setPendingProperties(undefined);setSingleAction(undefined);setSingleDeviceDid("");setSingleDeviceRoom("");setSingleDeviceKind("");setComposerError("")}
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

  return <section className="scene-editor scene-editor-page" aria-label={sceneId?"编辑场景":"新建场景"}>
    <header><button type="button" className="scene-page-back" onClick={composerOpen?cancelComposer:close}>← {composerOpen?"返回场景编辑":"返回场景"}</button><div><span>{composerOpen?workingIndices.length?"EDIT ACTION":"NEW ACTION":sceneId?"EDIT SCENE":"NEW SCENE"}</span><h2>{composerOpen?workingIndices.length?"修改动作":"添加动作":sceneId?"编辑手动场景":"新建手动场景"}</h2><p>{homeName} · {composerOpen?"完成动作设置后返回场景编辑":"保存后同步到米家云"}</p></div></header>
    {loading?<div className="scene-editor-state">正在读取可编辑场景…</div>:!draft?<div className="scene-editor-state error">{error||"场景读取失败"}</div>:<>
      <div className="scene-editor-scroll">
        {!composerOpen&&<>
        <section className="scene-editor-basics"><label><span>场景名称</span><input maxLength={50} value={draft.name} placeholder="例如：回家模式" onChange={event=>{setDraft({...draft,name:event.target.value});setDirty(true)}}/></label></section>
        {!draft.actionsEditable&&<div className="scene-editor-warning"><strong>动作保持只读</strong><p>这个场景包含当前版本无法安全重建的动作。你仍可修改名称，原始动作会完整保留。</p></div>}
        <section className="scene-editor-actions"><div className="scene-editor-section-title"><div><span>DO</span><div><strong>动作序列</strong><small>{draft.actions.length} 个真实动作</small></div></div>{draft.actionsEditable&&<button type="button" onClick={startAdd}>＋ 添加动作</button>}</div>
          <div className="scene-editor-action-groups">{actionGroups.map(group=>{const groupIndices=group.rooms.flatMap(room=>room.items.flatMap(item=>item.indices)).sort((left,right)=>left-right),groupActions=groupIndices.flatMap(index=>{const action=draft.actions[index];return action?[action]:[]}),firstGroupAction=groupActions.find((candidate):candidate is SceneDraftAction=>candidate.kind!=="unsupported"),groupEditable=groupActions.length===group.actionCount&&groupActions.every(candidate=>candidate.kind!=="unsupported"&&candidates.some(device=>device.did===candidate.did));return <section key={group.key}><header><strong>{group.label}</strong><div className="scene-group-tools"><small>{group.actionCount} 个动作</small>{draft.actionsEditable&&groupEditable&&firstGroupAction&&<button type="button" onClick={()=>startEdit(firstGroupAction,groupIndices)}>修改</button>}</div></header><div className="scene-editor-action-rooms">{group.rooms.map(room=><section key={room.room}><header><strong>{room.room}</strong><small>{room.actionCount} 个动作</small></header><ol>{room.items.map(item=>{const action=item.actions[0],index=item.indices[0],editable=item.actions.every(candidate=>candidate.kind!=="unsupported"&&candidates.some(device=>device.did===candidate.did));if(!action||index===undefined)return null;return <li className={item.collapsible?"batch":""} key={item.actions.map(candidate=>candidate.clientId).join(":")}><b>{item.collapsible?item.actions.length:index+1}</b><div><strong>{item.collapsible?item.state?`${item.state==="on"?"打开":"关闭"} ${item.actions.length} 盏灯`:`批量设置 ${item.actions.length} 盏灯`:action.deviceName||action.label}</strong><small>{item.collapsible?`${item.actions.map(candidate=>candidate.deviceName).filter(Boolean).join("、")}`:actionSummary(action)}{!editable&&action.kind!=="unsupported"?" · 仅可保留或删除":""}</small></div>{draft.actionsEditable&&action.kind!=="unsupported"&&<div className="scene-action-tools">{editable&&!item.collapsible&&<><button type="button" disabled={index===0} onClick={()=>moveAction(index,-1)}>↑</button><button type="button" disabled={index===draft.actions.length-1} onClick={()=>moveAction(index,1)}>↓</button></>}<button type="button" onClick={()=>removeActions(item.indices)}>删除</button></div>}</li>})}</ol></section>)}</div></section>})}</div>
          {!draft.actions.length&&<div className="scene-editor-empty">还没有动作。选择设备并加入至少一个动作后才能创建场景。</div>}
        </section>
        </>}
        {draft.actionsEditable&&composerOpen&&<section className={`scene-action-composer scene-action-page ${selectedProperties.length||selectedTargetKeys.length||singleAction?"active":""}`}><div className="scene-editor-section-title"><div><span>＋</span><div><strong>{workingIndices.length?"修改动作":"添加动作"}</strong><small>{composerMode==="single"?"选择设备官方目录中公开的动作":"先设置属性与状态，再选择所有支持的目标"}</small></div></div></div>
          <div className="scene-composer-mode" role="tablist" aria-label="动作编辑模式"><button type="button" role="tab" aria-selected={composerMode==="single"} className={composerMode==="single"?"selected":""} disabled={workingIndices.length>1} onClick={()=>switchComposerMode("single")}>单设备</button><button type="button" role="tab" aria-selected={composerMode==="batch"} className={composerMode==="batch"?"selected":""} disabled={workingIndices.length===1&&working?.kind==="invoke-action"} onClick={()=>switchComposerMode("batch")}>批量修改</button></div>
          {composerMode==="single"&&<>{catalogLoading&&<div className="scene-composer-state">正在读取官方设备动作目录…</div>}{catalogError&&<div className="scene-composer-state error">动作目录暂时不可用：{catalogError}</div>}{!catalogLoading&&!catalogError&&<div className="scene-single-editor">
            <section className="scene-single-device"><header><strong>Target device</strong><small>{workingIndices.length===1?"Existing action target":"Choose one device"}</small></header>{workingIndices.length===1?<div className="scene-single-device-fixed"><span className="scene-device-icon">{candidates.find(device=>device.did===singleDeviceDid)?.icon||"◇"}</span><div><strong>{singleCatalogDevice?.deviceName||working?.deviceName}</strong><small>{singleCatalogDevice?.room} · {singleCatalogDevice?`${catalogSourceLabel(singleCatalogDevice.source)} · ${singleCatalogDevice.actions.length} actions`:"Catalog unavailable"}</small></div></div>:<><div className="scene-device-filters scene-single-filters"><label><span>按房间筛选</span><select aria-label="单设备按房间筛选" value={singleDeviceRoom} onChange={event=>{setSingleDeviceRoom(event.target.value);selectSingleDevice("")}}><option value="">全部房间</option>{singleDeviceRooms.map(room=><option key={room} value={room}>{room}</option>)}</select></label><label><span>按类型筛选</span><select aria-label="单设备按类型筛选" value={singleDeviceKind} onChange={event=>{setSingleDeviceKind(event.target.value);selectSingleDevice("")}}><option value="">全部类型</option>{singleDeviceKinds.map(kind=><option key={kind} value={kind}>{deviceKindLabel(kind)}</option>)}</select></label></div><select aria-label="选择单个设备" value={singleDeviceDid} onChange={event=>selectSingleDevice(event.target.value)}><option value="">Choose device · {filteredSingleDevices.length} available</option>{singleDeviceRooms.map(room=>{const roomDevices=filteredSingleDevices.filter(device=>device.room===room);return roomDevices.length?<optgroup key={room} label={room}>{roomDevices.map(device=>{const kind=candidates.find(candidate=>candidate.did===device.did)?.kind;return <option key={device.did} value={device.did}>{device.deviceName} · {kind?deviceKindLabel(deviceKindGroup(kind)):"智能设备"} · {device.actions.length} actions</option>})}</optgroup>:null})}</select>{!filteredSingleDevices.length&&<div className="scene-device-empty">没有符合当前房间和类型筛选的设备。</div>}</>}</section>
            {singleCatalogDevice&&<section className="scene-official-actions"><header><strong>Supported actions</strong><small>{singleCatalogDevice.actions.length} · {catalogSourceLabel(singleCatalogDevice.source)}{singleCatalogDevice.excludedActionCount?` · ${singleCatalogDevice.excludedActionCount} unsupported`:""}</small></header>{singleCatalogDevice.actions.length?<div role="listbox" aria-label="设备支持的动作">{singleCatalogDevice.actions.map(template=><button type="button" role="option" aria-selected={singleAction?.templateKey===template.key} className={singleAction?.templateKey===template.key?"selected":""} key={template.key} onClick={()=>selectSingleTemplate(template.key)}><span><strong>{template.label}</strong><small>{template.serviceLabel} · {template.detail}</small></span><i>{singleAction?.templateKey===template.key?"✓":"＋"}</i></button>)}</div>:<div className="scene-device-empty">This device has no supported editable actions in the current official catalog.</div>}</section>}
            {workingIndices.length===1&&singleCatalogDevice&&!singleAction&&<div className="scene-composer-state error">The current action is not present in the latest official catalog. It will remain unchanged unless you choose a supported replacement.</div>}
            {selectedSingleTemplate&&singleAction&&<section className="scene-single-values"><header><strong>{selectedSingleTemplate.label}</strong><small>{selectedSingleTemplate.kind==="invoke-action"?"No input parameters":"Action values"}</small></header>{selectedSingleTemplate.properties?.map((property,index)=><div key={`${property.siid}.${property.piid}`}><label><span>{property.label}</span>{property.configurable?<PropertyValueEditor property={catalogSpecProperty(property)} value={singleAction.kind==="set-properties"?singleAction.properties?.[index]?.value??property.value??"":""} onChange={value=>setSinglePropertyValue(index,value)} rawLabels/>:<strong>{catalogValueLabel(property,property.value)}</strong>}</label></div>)}</section>}
          </div>}{composerError&&<div className="scene-composer-state error" role="alert">{composerError}</div>}<div className="scene-composer-actions"><button type="button" onClick={cancelComposer}>取消</button><button type="button" className="primary" disabled={!singleAction||!selectedSingleTemplate} onClick={commitSingle}>{workingIndices.length?"保存动作":"加入动作"}</button></div></>}
          {composerMode==="batch"&&<>{specsLoading&&<div className="scene-composer-state">正在汇总当前家庭可安全加入场景的读写属性…</div>}{specsError&&<div className="scene-composer-state error">{specsError}</div>}
          {!specsLoading&&<><div className="scene-kind-tabs"><button type="button" className="selected" disabled={!propertyCatalog.length}>设置批量属性</button><small>共发现 {propertyCatalog.length} 项标准读写属性</small></div>{!propertyCatalog.length&&<div className="scene-composer-state">当前设备没有适合加入手动场景的标准读写属性。</div>}
            <div className="scene-property-list">{selectedProperties.map((property,index)=><div key={property.key}><div><strong>{property.groupLabel} · {property.label}</strong><button type="button" onClick={()=>updateSelectedProperties(selectedProperties.filter((_,item)=>item!==index))}>移除</button></div><PropertyValueEditor property={property.capability} value={property.value} onChange={value=>setPropertyValue(index,value)}/></div>)}</div>
            <div className="scene-add-property"><select value={addPropertyKey} onChange={event=>setAddPropertyKey(event.target.value)}><option value="">选择要批量设置的属性</option>{Array.from(new Set(propertyCatalog.map(item=>item.groupLabel))).map(groupLabel=>{const properties=propertyCatalog.filter(item=>item.groupLabel===groupLabel&&!selectedProperties.some(selected=>selected.key===item.key));return properties.length?<optgroup key={groupLabel} label={groupLabel}>{properties.map(property=>{const semantic=scenePropertySemantic(property.serviceName,property.capability,firstValue(property.capability),property.sourceDid);const count=semantic?candidates.filter(device=>supportsSemantics(deviceSpecs[device.did],[semantic],device.did)).length:0;return <option key={property.key} value={property.key}>{property.label} · {count} 台支持</option>})}</optgroup>:null})}</select><button type="button" disabled={!addPropertyKey} onClick={addProperty}>加入</button></div>
            <p className="scene-device-help">这里只创建场景属性写入；设备页的立即执行 Action、只读属性和仅写属性不会在此交叉调用。</p>
            {incompatibilities.length>0&&<p className="scene-device-help" role="status">另有 {incompatibilities.length} 台设备不兼容：{incompatibilities.slice(0,3).map(item=>`${item.name}（${item.reason}）`).join("、")}{incompatibilities.length>3?"等":""}</p>}
            <div className="scene-device-picker"><div className="scene-device-filters"><label><span>按房间筛选</span><select value={deviceRoom} onChange={event=>setDeviceRoom(event.target.value)}><option value="">全部房间</option>{deviceRooms.map(room=><option key={room} value={room}>{room}</option>)}</select></label><label><span>按类型筛选</span><select value={deviceKind} onChange={event=>setDeviceKind(event.target.value)}><option value="">全部类型</option>{deviceKinds.map(kind=><option key={kind} value={kind}>{deviceKindLabel(kind)}</option>)}</select></label></div><div className="scene-device-result-title"><span>目标设备、灯组与按键</span><small>{selectedTargetKeys.length?`已选 ${selectedTargetKeys.length} 个目标`:`${filteredTargetOptions.length} 个目标支持当前设置`}</small></div><div className="scene-device-options" role="listbox" aria-label="目标设备、灯组与按键" aria-multiselectable="true">{filteredTargetOptions.map(option=>{const device=option.device,selected=selectedTargetKeys.includes(option.key);return <button type="button" role="option" aria-selected={selected} className={selected?"selected":""} key={option.key} onClick={()=>selectTarget(option.key)}><span className="scene-device-icon">{device.icon}</span><span><strong>{device.name}{option.groupLabel?` · ${option.groupLabel}`:""}</strong><small>{device.room} · {option.groupLabel?"开关按键":targetKindLabel(device)}{device.online===false?" · 离线":""}</small></span><i>{selected?"✓":"＋"}</i></button>})}</div>{!filteredTargetOptions.length&&<div className="scene-device-empty">没有设备、灯组或按键同时支持当前属性和值，请调整设置。</div>}</div>
            {composerError&&<div className="scene-composer-state error" role="alert">{composerError}</div>}<div className="scene-composer-actions"><button type="button" onClick={cancelComposer}>取消</button><button type="button" className="primary" disabled={saving||!selectedProperties.length||!selectedTargetKeys.length} onClick={()=>void commitWorking()}>{saving?"正在校验设备…":workingIndices.length?`保存 ${selectedTargetKeys.length} 个目标动作`:`加入 ${selectedTargetKeys.length} 个目标`}</button></div></>}</>}
        </section>}
      </div>
      {error&&<div className="scene-editor-error" role="alert">{error}</div>}
      {!composerOpen&&<footer><p>保存表示米家云已返回成功并能重新读取到场景。</p><div><button type="button" onClick={close}>取消</button><button type="button" className="primary" disabled={saving||!draft.name.trim()||!sceneId&&!draft.actions.length} onClick={()=>void save()}>{saving?"正在保存…":sceneId?"保存修改":"创建场景"}</button></div></footer>}
    </>}
  </section>
}

function PropertyValueEditor({property,value,onChange,rawLabels=false}:{property?:MiotCapabilityProperty;value:SceneValue;onChange:(value:SceneValue)=>void;rawLabels?:boolean}){
  if(property?.choices?.length)return <select value={String(value)} onChange={event=>{const choice=property.choices?.find(item=>String(item.value)===event.target.value);if(choice)onChange(choice.value)}}>{property.choices.map(choice=><option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}</select>;
  if(property?.format==="bool")return <select value={String(value)} onChange={event=>onChange(event.target.value==="true")}><option value="true">{rawLabels?"true":"开启"}</option><option value="false">{rawLabels?"false":"关闭"}</option></select>;
  if(property?.range)return <div className="scene-range-value"><input type="range" min={property.range.min} max={property.range.max} step={property.range.step} value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/><input type="number" min={property.range.min} max={property.range.max} step={property.range.step} value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/><span>{property.unit||""}</span></div>;
  if(property&&["float","int8","int16","int32","uint8","uint16","uint32"].includes(property.format))return <input type="number" value={Number(value)} onChange={event=>onChange(Number(event.target.value))}/>;
  return <input value={String(value)} onChange={event=>onChange(event.target.value)}/>;
}
