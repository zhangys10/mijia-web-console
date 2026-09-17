"use client";

import { useEffect, useMemo, useState } from "react";
import type { ManagedDevice } from "../lib/device-management";
import { automationPropertyDisplay } from "../lib/xiaomi-automation-action-display";
import type { AutomationConditionDraft, AutomationEditorDraft, AutomationEffectiveTimeDraft } from "../lib/xiaomi-automation-editor";
import type { XiaomiAutomation } from "../lib/xiaomi-automations";
import type { SceneDraftAction, SceneValue } from "../lib/xiaomi-scene-editor";

type Props = { homeId: string; homeName: string; devices: ManagedDevice[]; connected: boolean; onMessage: (message: string) => void };
type CatalogAction = { key:string;kind:"set-property";did:string;deviceName:string;room:string;model:string;serviceLabel:string;siid:number;piid:number;label:string;format:string;range?:{min:number;max:number;step:number};choices?:Array<{value:SceneValue;label:string}> };
type CatalogPropertyDescription = Pick<CatalogAction,"did"|"serviceLabel"|"siid"|"piid"|"label"|"format"|"range"|"choices"> & {editable:boolean};
type TriggerTemplate = { key:string;automationId:string;sourceIndex:number;kind:string;label:string;detail?:string;deviceKey?:string;deviceName?:string;room?:string;model?:string;did?:string };
type TriggerKind = { kind:string;label:string;writable:boolean };
type CatalogSource = "tca-v3"|"model-catalog"|"miot-spec";
type TriggerCapability = { key:string;kind:"property"|"event"|"unknown";label:string;detail:string;source:CatalogSource;siid?:number;piid?:number;eiid?:number;value?:SceneValue };
type DiscoveredAction = { key:string;kind:"set-property"|"set-properties"|"action"|"unknown";label:string;detail:string;source:CatalogSource;siid?:number;piid?:number;aiid?:number;value?:SceneValue };
type TriggerDevice = { key:string;did?:string;model?:string;deviceName:string;room:string;capabilities:TriggerCapability[];actions:DiscoveredAction[];discovery:"tca-v3"|"model-catalog"|"miot-spec"|"unavailable" };
type Catalog = { actions: CatalogAction[];propertyDescriptions:CatalogPropertyDescription[];triggerKinds:TriggerKind[];triggerTemplates:TriggerTemplate[];triggerDevices:TriggerDevice[] };
type UnsupportedAction = { clientId:string;kind:"unsupported";sourceIndex:number;label:string;deviceName?:string;reason:string };

export type ConditionItem = AutomationConditionDraft & { id: string };

type EditorState = Omit<AutomationEditorDraft, "conditions" | "falseActions" | "actions"> & {
  schedule?: { time: string; weekdays: number[] };
  triggerMode: "all" | "any";
  conditionMode: "all" | "any";
  conditions: ConditionItem[];
  actions: Array<SceneDraftAction | UnsupportedAction>;
  falseActions: Array<SceneDraftAction | UnsupportedAction>;
  effectiveTime: AutomationEffectiveTimeDraft;
};

const demoAutomations: XiaomiAutomation[] = [
  {
    id: "demo-sunset",
    homeId: "demo",
    name: "傍晚回家亮灯",
    enabled: true,
    triggerMode: "any",
    triggers: [
      { kind: "weather", label: "日落后", detail: "日落后 30 分钟", editable: false },
      { kind: "location", label: "有人回家", detail: "距离家 500 米内", editable: false },
      { kind: "device", label: "智能门锁已开启", detail: "玄关智能门锁 · 任意门锁开启", editable: false, deviceName: "智能门锁", room: "玄关" },
    ],
    conditionMode: "all",
    conditions: [
      { kind: "device", label: "玄关灯处于关闭状态", detail: "玄关灯 · 电源", deviceName: "玄关灯", room: "玄关" },
      { kind: "time", label: "17:30 ~ 23:59 期间生效", timeRange: { start: "17:30", end: "23:59" }, weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ],
    actions: [
      { order: 1, label: "打开玄关灯", deviceName: "玄关灯", room: "玄关", details: [{ kind: "power", label: "电源", value: "开启", state: "on" }, { kind: "brightness", label: "亮度", value: "80%" }] },
      { order: 2, label: "开启客厅吸顶灯", deviceName: "客厅吸顶灯", room: "客厅", details: [{ kind: "power", label: "电源", value: "开启", state: "on" }] },
      { order: 3, label: "延时 5 秒", details: [{ kind: "delay", label: "延时", value: "5 秒" }] },
    ],
    falseActions: [
      { order: 1, label: "向手机发送通知", details: [{ kind: "command", label: "提醒", value: "检测到回家，但当前已开灯或非生效时段" }] },
    ],
    effectiveTime: { type: "custom", start: "17:30", end: "23:59", weekdays: [1, 2, 3, 4, 5, 6, 7] },
    actionCount: 3,
    updatedAt: "2026-09-15 18:20",
  },
  {
    id: "demo-night",
    homeId: "demo",
    name: "深夜自动温湿度调节",
    enabled: false,
    triggerMode: "all",
    triggers: [
      { kind: "device", label: "室内温度高于 27°C", detail: "主卧温湿度传感器", editable: false, deviceName: "温湿度传感器", room: "主卧" },
      { kind: "schedule", label: "工作日 23:30", time: "23:30", weekdays: [1, 2, 3, 4, 5], editable: true },
    ],
    conditionMode: "all",
    conditions: [
      { kind: "device", label: "米家空调处于关闭", detail: "米家空调 · 电源关", deviceName: "米家空调", room: "客厅" },
    ],
    actions: [
      { order: 1, label: "打开米家空调", deviceName: "米家空调", room: "客厅", details: [{ kind: "power", label: "电源", value: "开启", state: "on" }, { kind: "property", label: "模式", value: "制冷" }, { kind: "property", label: "温度", value: "26°C" }] },
      { order: 2, label: "开启空气净化器", deviceName: "空气净化器", room: "主卧", details: [{ kind: "power", label: "电源", value: "开启", state: "on" }, { kind: "property", label: "模式", value: "睡眠" }] },
    ],
    falseActions: [
      { order: 1, label: "调节空调温度至 25°C", deviceName: "米家空调", room: "客厅", details: [{ kind: "property", label: "温度", value: "25°C" }] },
    ],
    effectiveTime: { type: "custom", start: "23:00", end: "07:00", weekdays: [1, 2, 3, 4, 5] },
    actionCount: 2,
    updatedAt: "2026-09-14 23:30",
  },
];

function friendlyError(error:string){return ({XIAOMI_AUTOMATION_CONFLICT:"自动化已在米家 App 或其他页面中修改，请返回列表后重试。",XIAOMI_AUTOMATION_TRIGGER_READ_ONLY:"这个触发条件由米家或设备插件管理，当前只能原样保留。",XIAOMI_AUTOMATION_ACTIONS_READ_ONLY:"自动化包含暂不支持重建的动作，动作区保持只读。",XIAOMI_AUTOMATION_CONDITION_NODE_INVALID:"无法读取该自动化的条件结构，请保留原条件后再保存。",XIAOMI_AUTOMATION_CONDITION_SOURCE_INVALID:"有新增条件暂不支持安全写入米家，请先保存原条件或删除新增条件。",XIAOMI_AUTOMATION_CONDITION_SOURCE_DUPLICATE:"条件与原场景不匹配，请返回列表后重新进入编辑。",XIAOMI_AUTOMATION_CONDITION_TIME_UNSUPPORTED:"该时间条件的原始字段暂不支持安全更新，请保留原时间或删除该条件。",XIAOMI_AUTOMATION_CONDITION_UNSUPPORTED:"当前条件包含米家私有参数，暂不支持安全重建；请保留原条件后再保存。",XIAOMI_AUTOMATION_WRITE_NOT_VISIBLE:"米家云已接收请求，但暂时没有回读到一致结果。",XIAOMI_AUTOMATION_NAME_CONFLICT:"当前家庭已有同名自动化。"} as Record<string,string>)[error]||`自动化操作失败：${error}`}
function actionValue(option:CatalogAction):SceneValue{if(option.format==="bool")return true;if(option.choices?.length)return option.choices[0]!.value;if(option.range)return option.range.min;return ""}
function resolveActionModel(action:{did?:string;model?:string;deviceName?:string}, catalogActions:CatalogAction[]){return action.model&&action.model!=="device"?action.model:(catalogActions.find(option=>String(option.did)===String(action.did))?.model||action.model||"device")}
function triggerGlyph(kind:string){return kind==="schedule"?"◷":kind==="device"?"▣":kind==="location"?"⌖":kind==="weather"||kind==="sun"?"☀":kind==="manual"?"👆":"◇"}
function catalogSourceLabel(source:CatalogSource){return source==="tca-v3"?"当前设备已确认":source==="model-catalog"?"官方型号目录":"MIoT 规格"}
function discoverySummary(device:TriggerDevice){if(device.discovery==="unavailable")return "自动化目录暂不可用";const counts=[device.capabilities.length?`${device.capabilities.length} 个条件`:"",device.actions.length?`${device.actions.length} 个动作`:""].filter(Boolean).join(" · ");return counts||"没有声明自动化能力"}
function triggerCategory(template:TriggerTemplate){return template.kind==="weather"&&/日出|日落|sunrise|sunset/i.test(template.label)?"sun":template.kind}
function parseSunFromLabel(label: string): {
  type: "sunrise" | "sunset";
  offsetType: "at" | "before" | "after";
  offsetMinutes: number;
  weekdays: number[];
  repeatMode: "everyday" | "workday" | "weekend" | "custom";
} {
  const isSunset = /日落|sunset/i.test(label);
  const type = isSunset ? "sunset" : "sunrise";
  const isBefore = /前|before/i.test(label);
  const isAt = /时|正当时|at/i.test(label) && !/小时/i.test(label);
  const offsetType = isAt ? "at" : isBefore ? "before" : "after";
  const minMatch = label.match(/(\d+)\s*(?:分钟|min|m)/i);
  const offsetMinutes = isAt ? 0 : (minMatch ? parseInt(minMatch[1], 10) : 30);
  let weekdays = [1, 2, 3, 4, 5, 6, 7];
  let repeatMode: "everyday" | "workday" | "weekend" | "custom" = "everyday";
  if (/工作日/i.test(label)) {
    weekdays = [1, 2, 3, 4, 5];
    repeatMode = "workday";
  } else if (/周末/i.test(label)) {
    weekdays = [6, 7];
    repeatMode = "weekend";
  } else {
    const dayMatch = label.match(/周([一二三四五六日、]+)/);
    if (dayMatch) {
      const charMap: Record<string, number> = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7 };
      const parsed = Array.from(dayMatch[1]).map(c => charMap[c]).filter(Boolean);
      if (parsed.length) {
        weekdays = parsed;
        repeatMode = "custom";
      }
    }
  }
  return { type, offsetType, offsetMinutes, weekdays, repeatMode };
}

function parseTemperatureFromLabel(label: string): {
  isTemp: boolean;
  operator: "高于" | "低于";
  value: number;
} {
  const isTemp = /温度|气温/i.test(label);
  const isHigher = /高于|大于|超/i.test(label);
  const numMatch = label.match(/(-?\d+)\s*(?:℃|°C|度)?/i);
  const value = numMatch ? parseInt(numMatch[1], 10) : 30;
  return { isTemp, operator: isHigher ? "高于" : "低于", value };
}

function formatTemperatureLabel(operator: "高于" | "低于", value: number): string {
  return `室外温度${operator}${value}℃`;
}

function formatSunLabel(
  type: "sunrise" | "sunset",
  offsetType: "at" | "before" | "after",
  minutes: number,
  weekdays: number[]
) {
  const typeText = type === "sunset" ? "日落" : "日出";
  const offsetText = offsetType === "at" || minutes === 0
    ? "时"
    : offsetType === "before"
      ? `前${minutes}分钟`
      : `后${minutes}分钟`;
  const repeatText = weekdays.length === 7
    ? "每天"
    : weekdays.join(",") === "1,2,3,4,5"
      ? "工作日"
      : weekdays.join(",") === "6,7"
        ? "周末"
        : `周${weekdays.map(d => "一二三四五六日"[d - 1]).join("、")}`;
  return `${typeText}${offsetText} ${repeatText}`;
}
function selectedTemplate(draft:EditorState,template:TriggerTemplate){return Boolean(draft.triggerSelections?.some(item=>item.automationId===template.automationId&&item.sourceIndex===template.sourceIndex))}
function scheduleWeekdaysSummary(weekdays:number[]){if(!weekdays||weekdays.length===7)return "每天";const key=[...weekdays].sort().join(",");if(key==="1,2,3,4,5")return "工作日";if(key==="6,7")return "周末";return `周${weekdays.map(d=>"一二三四五六日"[d-1]).join("、")}`}
function scheduleLabel(schedule:NonNullable<EditorState["schedule"]>){return `${schedule.time} · ${schedule.weekdays.length===7?"每天":`每周 ${schedule.weekdays.map(day=>"一二三四五六日"[day-1]).join("、")}`}`}
function effectiveTimeLabel(effective:AutomationEffectiveTimeDraft){const days=effective.weekdays.length===7?"每天":effective.weekdays.join(",")==="1,2,3,4,5"?"工作日":effective.weekdays.join(",")==="6,7"?"周末":`周${effective.weekdays.map(d=>"一二三四五六日"[d-1]).join("、")}`;const time=effective.type==="custom"&&effective.start&&effective.end?`${effective.start} ~ ${effective.end}`:"全天生效";return `${days} · ${time}`}
function draftReady(draft:EditorState){return Boolean(draft.name.trim()&&draft.actions.length&&(draft.schedule||draft.triggerSelections?.length)&&(!draft.schedule||draft.schedule.weekdays.length))}
function actionPropertySummary(action:SceneDraftAction|UnsupportedAction,catalog:CatalogPropertyDescription[],includeValues=false){if(action.kind==="unsupported")return action.reason;return action.properties?.map(property=>{const display=automationPropertyDisplay(action,property,catalog);return includeValues?`${display.label}：${display.valueLabel}`:display.label}).join(" · ")||action.label}
function choiceKey(value:SceneValue){return `${typeof value}:${String(value)}`}
function resolveDeviceContext(
  target: { deviceName?: string; room?: string; did?: string; deviceKey?: string; label?: string; detail?: string },
  managedDevices: ManagedDevice[] = [],
  triggerDevices: TriggerDevice[] = []
): { deviceName: string; room: string; did?: string; deviceKey?: string } {
  let match = target.did ? managedDevices.find(d => String(d.did) === String(target.did)) : undefined;
  let trigMatch = target.deviceKey ? triggerDevices.find(d => d.key === target.deviceKey) : undefined;
  if (!match && trigMatch?.did) {
    match = managedDevices.find(d => String(d.did) === String(trigMatch!.did));
  }
  const rawName = target.deviceName;
  const isGeneric = !rawName || rawName === "智能设备" || rawName === "未命名设备";
  if (!match && !isGeneric) {
    match = managedDevices.find(d => d.name === rawName || rawName.includes(d.name) || d.name.includes(rawName));
  }
  if (!trigMatch && !isGeneric) {
    trigMatch = triggerDevices.find(d => d.deviceName === rawName || rawName.includes(d.deviceName) || d.deviceName.includes(rawName));
  }
  if (!match && target.label) {
    match = managedDevices.find(d => d.name && (target.label!.includes(d.name) || d.name.includes(target.label!)));
    if (!trigMatch) {
      trigMatch = triggerDevices.find(d => d.deviceName && (target.label!.includes(d.deviceName) || d.deviceName.includes(target.label!)));
    }
  }
  if (!match && target.detail) {
    match = managedDevices.find(d => d.name && target.detail!.includes(d.name));
    if (!trigMatch) {
      trigMatch = triggerDevices.find(d => d.deviceName && target.detail!.includes(d.deviceName));
    }
  }
  if (!match && !trigMatch && target.label) {
    const devWithCap = triggerDevices.find(td => td.capabilities?.some(c => c.label === target.label || (c.label && target.label!.includes(c.label)) || (target.label && c.label.includes(target.label!))));
    if (devWithCap) {
      trigMatch = devWithCap;
      if (devWithCap.did) {
        match = managedDevices.find(d => String(d.did) === String(devWithCap.did));
      }
    }
  }
  if (!match) {
    try {
      const targetStr = JSON.stringify(target);
      for (const d of managedDevices) {
        if (d.did && String(d.did).length >= 4 && targetStr.includes(String(d.did))) {
          match = d;
          break;
        }
      }
      if (!match && !trigMatch) {
        for (const td of triggerDevices) {
          if (td.did && String(td.did).length >= 4 && targetStr.includes(String(td.did))) {
            trigMatch = td;
            break;
          }
        }
      }
    } catch {
      // ignore serialization error
    }
  }

  const matchedName = match?.name || trigMatch?.deviceName;
  const deviceName = (matchedName && (isGeneric || !rawName))
    ? matchedName
    : (!isGeneric ? rawName! : (matchedName || "智能设备"));

  let room = (target.room && target.room !== "未分配")
    ? target.room
    : (match?.room && match.room !== "未分配" ? match.room : (trigMatch?.room && trigMatch.room !== "未分配" ? trigMatch.room : undefined));

  if ((!room || room === "未分配") && deviceName && deviceName !== "智能设备") {
    const dev = managedDevices.find(d => d.name === deviceName || deviceName.includes(d.name) || d.name.includes(deviceName));
    if (dev?.room && dev.room !== "未分配") room = dev.room;
    if (!room || room === "未分配") {
      const trig = triggerDevices.find(d => d.deviceName === deviceName || deviceName.includes(d.deviceName) || d.deviceName.includes(deviceName));
      if (trig?.room && trig.room !== "未分配") room = trig.room;
    }
  }
  if ((!room || room === "未分配") && target.detail) {
    const foundRoom = managedDevices.find(d => d.room && d.room !== "未分配" && target.detail!.includes(d.room))?.room;
    if (foundRoom) room = foundRoom;
  }

  return {
    deviceName: deviceName || "智能设备",
    room: room || "未分配",
    did: target.did || match?.did || trigMatch?.did,
    deviceKey: target.deviceKey || trigMatch?.key,
  };
}


export default function AutomationCenter({homeId,homeName,devices=[],connected,onMessage}:Props){
  const [items,setItems]=useState<XiaomiAutomation[]>(connected?[]:demoAutomations);
  const [loading,setLoading]=useState(connected),[error,setError]=useState("");
  const [selected,setSelected]=useState<XiaomiAutomation|null>(null);
  const [editorId,setEditorId]=useState<string|undefined|null>(null),[draft,setDraft]=useState<EditorState>();
  const [catalog,setCatalog]=useState<Catalog>({actions:[],propertyDescriptions:[],triggerKinds:[],triggerTemplates:[],triggerDevices:[]});
  const [catalogLoading,setCatalogLoading]=useState(false);
  const [saving,setSaving]=useState(false),[reviewing,setReviewing]=useState(false);
  const [actionKey,setActionKey]=useState(""),[actionRoom,setActionRoom]=useState("");
  const rooms=useMemo(()=>Array.from(new Set(catalog.actions.map(item=>item.room))),[catalog.actions]);
  const actionOptions=useMemo(()=>catalog.actions.filter(item=>!actionRoom||item.room===actionRoom),[actionRoom,catalog.actions]);

  async function load(){
    if(!connected||!homeId||homeId==="demo"){setItems(demoAutomations);setLoading(false);return}
    setLoading(true);setError("");
    try{
      const response=await fetch(`/api/xiaomi/automations?homeId=${encodeURIComponent(homeId)}`),data=await response.json();
      if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SYNC_FAILED");
      const list=Array.isArray(data.automations)?data.automations as XiaomiAutomation[]:[];
      setItems(list);
      setSelected(current=>current?list.find(item=>item.id===current.id)??null:null);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR");
    }finally{
      setLoading(false);
    }
  }

  useEffect(()=>{
    if(!connected||!homeId||homeId==="demo")return;
    let active=true;
    void fetch(`/api/xiaomi/automations?homeId=${encodeURIComponent(homeId)}`).then(async response=>{
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SYNC_FAILED");
      if(active){setItems(Array.isArray(data.automations)?data.automations:[]);setLoading(false)}
    }).catch(reason=>{
      if(active){setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR");setLoading(false)}
    });
    return()=>{active=false};
  },[homeId,connected]);

  async function fetchCatalog(){
    if(!homeId||homeId==="demo")return;
    setCatalogLoading(true);
    try{
      const response=await fetch(`/api/xiaomi/automations/catalog?homeId=${encodeURIComponent(homeId)}`);
      const data=await response.json();
      if(response.ok)setCatalog(data as Catalog);
    }catch{
      // non-fatal
    }finally{
      setCatalogLoading(false);
    }
  }

  async function openEditor(id?:string){
    const current = (id ? items.find(a => a.id === id) : undefined)
      || (id ? demoAutomations.find(a => a.id === id) : undefined)
      || (selected?.id === id ? selected : undefined)
      || selected
      || undefined;

    if(!connected){
      // demo mode editing
      if(!catalog.triggerDevices.length){
        setCatalog({
          actions:[
            {key:"light-strip:2.1",kind:"set-property",did:"light-strip",deviceName:"卫生间镜柜灯带",room:"卫生间",model:"yeelink.light.strip1",serviceLabel:"灯光",siid:2,piid:1,label:"电源",format:"bool"},
          ],
          propertyDescriptions:[],
          triggerKinds:[
            {kind:"device",label:"智能设备",writable:true},
            {kind:"schedule",label:"指定时间",writable:true},
            {kind:"weather",label:"环境天气",writable:false},
            {kind:"location",label:"位置变化",writable:false},
          ],
          triggerTemplates:[
            {key:"demo:0",automationId:"demo-sunset",sourceIndex:0,kind:"weather",label:"日落后",detail:"日落后 30 分钟"},
            {key:"demo:1",automationId:"demo-sunset",sourceIndex:1,kind:"location",label:"有人回家",detail:"距离家 500 米内"},
            {key:"demo:2",automationId:"demo-sunset",sourceIndex:2,kind:"device",label:"单击",detail:"卫生间无线开关 · 卫生间",deviceName:"卫生间无线开关",room:"卫生间",deviceKey:"dev-sw1"},
            {key:"demo:3",automationId:"demo-sunset",sourceIndex:3,kind:"device",label:"智能门锁已开启",detail:"玄关智能门锁 · 任意门锁开启",deviceName:"智能门锁",room:"玄关",deviceKey:"dev-lock"},
          ],
          triggerDevices:[
            {key:"dev-sw1",deviceName:"卫生间无线开关",room:"卫生间",capabilities:[{key:"c1",kind:"event",label:"单击",detail:"按键按下一次",source:"miot-spec"},{key:"c2",kind:"event",label:"双击",detail:"按键双击",source:"miot-spec"},{key:"c3",kind:"event",label:"长按",detail:"按键长按",source:"miot-spec"}],actions:[],discovery:"miot-spec"},
            {key:"dev-lock",deviceName:"智能门锁",room:"玄关",capabilities:[{key:"c4",kind:"event",label:"智能门锁已开启",detail:"任意开锁",source:"miot-spec"},{key:"c5",kind:"event",label:"智能门锁已上锁",detail:"门锁反锁",source:"miot-spec"}],actions:[],discovery:"miot-spec"},
            {key:"dev-light",deviceName:"卫生间镜柜灯带",room:"卫生间",capabilities:[{key:"c6",kind:"property",label:"灯关",detail:"电源处于关闭状态",source:"miot-spec"},{key:"c7",kind:"property",label:"灯开",detail:"电源处于开启状态",source:"miot-spec"}],actions:[],discovery:"miot-spec"},
            {key:"dev-sensor",deviceName:"人体传感器",room:"客厅",capabilities:[{key:"c8",kind:"property",label:"有人移动",detail:"感应到人体移动",source:"miot-spec"},{key:"c9",kind:"property",label:"2分钟无人移动",detail:"无人移动超时",source:"miot-spec"}],actions:[],discovery:"miot-spec"},
          ],
        });
      }
      const initial:EditorState={
        sceneId:current?.id||"",
        homeId:"demo",
        name:current?.name||"新自动化场景",
        enabled:current?.enabled??false,
        revision:"0".repeat(64),
        actionsEditable:true,
        actions:current?.actions.map((a,i)=>({clientId:`action-${i}`,kind:"set-properties" as const,did:a.deviceName||"demo",model:"demo",deviceName:a.deviceName||"示例设备",label:a.label,properties:[{siid:2,piid:1,value:true}]}))||[],
        falseActions:current?.falseActions?.map((a,i)=>({clientId:`false-action-${i}`,kind:"set-properties" as const,did:a.deviceName||"demo",model:"demo",deviceName:a.deviceName||"示例设备",label:a.label,properties:[{siid:2,piid:1,value:false}]}))||[],
        triggerEditable:true,
        triggerLabel:current?.triggers.map(t=>t.label).join(" 或 ")||"定时到达",
        triggerMode:current?.triggerMode||"any",
        conditionMode:current?.conditionMode||"all",
        conditions:current?.conditions?.map((c,i)=>({
          ...c,
          id:`cond-${i}`,
          kind:c.kind==="unknown"?"custom" as const:c.kind,
          deviceName:c.deviceName,
          room:c.room,
          detail:c.detail||(c.deviceName?`${c.deviceName}${c.room?` · ${c.room}`:""}`:undefined),
        }))||[],
        schedule:current?.triggers.find(t=>t.kind==="schedule"&&t.time)?{time:current.triggers.find(t=>t.kind==="schedule")!.time!,weekdays:current.triggers.find(t=>t.kind==="schedule")!.weekdays||[1,2,3,4,5,6,7]}:{time:"08:00",weekdays:[1,2,3,4,5,6,7]},
        triggerSelections:(current?.triggers||[]).map((_,i)=>({automationId:current?.id||"demo-sunset",sourceIndex:i})),
        effectiveTime:current?.effectiveTime||{type:"all-day",weekdays:[1,2,3,4,5,6,7]},
      };
      setEditorId(id??"");setDraft(initial);setReviewing(false);setError("");
      return;
    }
    setEditorId(id??"");setDraft(undefined);setReviewing(false);setError("");setActionKey("");setActionRoom("");
    try{
      const catalogRequest=fetch(`/api/xiaomi/automations/catalog?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data as Catalog});
      const next=id?fetch(`/api/xiaomi/automations/${encodeURIComponent(id)}?homeId=${encodeURIComponent(homeId)}`).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);return data.draft as AutomationEditorDraft}):Promise.resolve({sceneId:"",homeId,name:"",enabled:false,revision:"",actionsEditable:true,actions:[],triggerEditable:true,triggerLabel:"尚未选择条件",triggerMode:"any",triggerSelections:[]} as AutomationEditorDraft);
      const [cat,loadedDraft]=await Promise.all([catalogRequest,next]);
      const initialTemplates = [...(cat.triggerTemplates || [])].map(t => {
        const resolved = resolveDeviceContext(t, devices, cat.triggerDevices || []);
        return {
          ...t,
          deviceName: resolved.deviceName !== "智能设备" ? resolved.deviceName : t.deviceName,
          room: resolved.room !== "未分配" ? resolved.room : t.room,
          did: t.did || resolved.did,
        };
      });
      if (loadedDraft.triggers) {
        loadedDraft.triggers.forEach((tr, idx) => {
          const key = `${loadedDraft.sceneId}:${idx}`;
          const resolved = resolveDeviceContext(tr, devices, cat.triggerDevices || []);
          const existing = initialTemplates.find(t => t.key === key || (t.automationId === loadedDraft.sceneId && t.sourceIndex === idx));
          const devName = (tr.deviceName && tr.deviceName !== "智能设备") ? tr.deviceName : (resolved.deviceName !== "智能设备" ? resolved.deviceName : undefined);
          const devRoom = (tr.room && tr.room !== "未分配") ? tr.room : (resolved.room !== "未分配" ? resolved.room : undefined);
          const devDid = tr.did || resolved.did;
          if (existing) {
            if (devName) existing.deviceName = devName;
            if (devRoom) existing.room = devRoom;
            if (devDid) existing.did = devDid;
            if (!existing.detail && tr.detail) existing.detail = tr.detail;
          } else if (tr.kind !== "schedule" && tr.kind !== "unknown") {
            initialTemplates.push({
              key,
              automationId: loadedDraft.sceneId,
              sourceIndex: idx,
              kind: tr.kind,
              label: tr.label,
              detail: tr.detail || (devName ? `${devName}${devRoom ? ` · ${devRoom}` : ""}` : undefined),
              deviceName: devName,
              room: devRoom,
              did: devDid,
              model: tr.model,
            });
          }
        });
      }
      if (current?.triggers) {
        current.triggers.forEach((tr, idx) => {
          const key = `${id}:${idx}`;
          const existing = initialTemplates.find(t => t.key === key || (t.automationId === id && t.sourceIndex === idx));
          const trDevName = tr.deviceName && tr.deviceName !== "智能设备" ? tr.deviceName : undefined;
          const trRoom = tr.room && tr.room !== "未分配" ? tr.room : undefined;
          if (existing) {
            if ((!existing.deviceName || existing.deviceName === "智能设备") && trDevName) {
              existing.deviceName = trDevName;
            }
            if ((!existing.room || existing.room === "未分配") && trRoom) {
              existing.room = trRoom;
            }
            if (tr.detail && (!existing.detail || existing.detail === "已验证条件模板")) {
              existing.detail = tr.detail;
            }
          }
        });
      }
      setCatalog({ ...cat, triggerTemplates: initialTemplates });
      const resolvedFalseActions = (loadedDraft.falseActions && loadedDraft.falseActions.length > 0)
        ? loadedDraft.falseActions.map((a, i) => {
            const fallbackAction = current?.falseActions?.[i];
            const did = a.kind === "set-properties" || a.kind === "invoke-action" ? a.did : undefined;
            const matchDev = did ? devices.find(d => String(d.did) === String(did)) : ((a.deviceName || fallbackAction?.deviceName) ? devices.find(d => d.name === (a.deviceName || fallbackAction?.deviceName)) : undefined);
            const devName = (a.deviceName && a.deviceName !== "智能设备") ? a.deviceName : (fallbackAction?.deviceName || matchDev?.name || a.label);
            return {
              ...a,
              clientId: (a as { clientId?: string }).clientId || `false-action-${i}`,
              deviceName: devName,
              ...(matchDev?.did && !did ? { did: matchDev.did } : {}),
            };
          })
        : (current?.falseActions || []).map((a, i) => {
            const matchDev = a.deviceName ? devices.find(d => d.name === a.deviceName) : undefined;
            return {
              clientId: `false-action-${i}`,
              kind: "set-properties" as const,
              did: matchDev?.did || a.deviceName || "device",
              model: resolveActionModel(a, cat.actions),
              deviceName: a.deviceName || a.label || "设备动作",
              label: a.label,
              properties: [{ siid: 2, piid: 1, value: false }],
            };
          });

      const sourceConditions = (loadedDraft.conditions && loadedDraft.conditions.length > 0)
        ? loadedDraft.conditions
        : (current?.conditions || []);
      const resolvedConditions = sourceConditions.map((c, i) => {
        const fallbackCond = current?.conditions?.[i];
        const resolved = resolveDeviceContext(c, devices, cat.triggerDevices || []);
        const devName = (c.deviceName && c.deviceName !== "智能设备")
          ? c.deviceName
          : (fallbackCond?.deviceName && fallbackCond.deviceName !== "智能设备"
            ? fallbackCond.deviceName
            : (resolved.deviceName !== "智能设备" ? resolved.deviceName : undefined));
        const devRoom = (c.room && c.room !== "未分配")
          ? c.room
          : (fallbackCond?.room && fallbackCond.room !== "未分配"
            ? fallbackCond.room
            : (resolved.room !== "未分配" ? resolved.room : undefined));
        const devDid = c.did || fallbackCond?.did || resolved.did;
        return {
          ...c,
          id: `cond-${i}`,
          kind: c.kind === "unknown" ? "custom" as const : c.kind,
          deviceName: devName,
          room: devRoom,
          did: devDid,
          detail: c.detail || fallbackCond?.detail || (devName ? `${devName}${devRoom ? ` · ${devRoom}` : ""}` : undefined),
        };
      });

      const resolvedEffectiveTime = loadedDraft.effectiveTime || current?.effectiveTime || { type: "all-day", weekdays: [1, 2, 3, 4, 5, 6, 7] };
      const resolvedConditionMode = loadedDraft.conditionMode || current?.conditionMode || "all";
      const resolvedTriggerMode = loadedDraft.triggerMode || current?.triggerMode || "any";

      setDraft({
        ...loadedDraft,
        triggerMode: resolvedTriggerMode,
        conditionMode: resolvedConditionMode,
        conditions: resolvedConditions,
        falseActions: resolvedFalseActions,
        effectiveTime: resolvedEffectiveTime,
        actions: loadedDraft.actions.map((action, index) => action.kind === "unsupported"
          ? { clientId: `unsupported-${index}`, kind: "unsupported", sourceIndex: index, label: action.label, deviceName: action.deviceName, reason: "包含米家私有参数，保存时原样保留" }
          : {
              clientId: action.clientId || `action-${index}`,
              kind: action.kind,
              ...(Number.isInteger(action.sourceIndex) ? { sourceIndex: Number(action.sourceIndex) } : {}),
              did: action.did,
              deviceName: action.deviceName,
              model: resolveActionModel(action, cat.actions),
              label: action.label,
              ...(action.templateKey ? { templateKey: action.templateKey } : {}),
              ...(action.properties ? { properties: action.properties } : {}),
              ...(Number.isInteger(action.siid) ? { siid: Number(action.siid) } : {}),
              ...(Number.isInteger(action.aiid) ? { aiid: Number(action.aiid) } : {}),
            }),
      });
    }catch(reason){
      setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR");
    }
  }

  function closeEditor(){setEditorId(null);setDraft(undefined);setReviewing(false);setError("")}
  function update(patch:Partial<EditorState>){setDraft(current=>current?{...current,...patch}:current)}
  function toggleSchedule(){if(!draft)return;update({schedule:draft.schedule?undefined:{time:"08:00",weekdays:[1,2,3,4,5,6,7]}})}
  function toggleDay(day:number){if(!draft?.schedule)return;const next=draft.schedule.weekdays.includes(day)?draft.schedule.weekdays.filter(item=>item!==day):[...draft.schedule.weekdays,day].sort();update({schedule:{...draft.schedule,weekdays:next}})}
  function toggleEffectiveDay(day:number){if(!draft)return;const next=draft.effectiveTime.weekdays.includes(day)?draft.effectiveTime.weekdays.filter(item=>item!==day):[...draft.effectiveTime.weekdays,day].sort();update({effectiveTime:{...draft.effectiveTime,weekdays:next.length?next:[1,2,3,4,5,6,7]}})}

  function toggleTriggerTemplate(template:TriggerTemplate){
    if(!draft)return;
    const exists=selectedTemplate(draft,template);
    const selections=exists
      ?(draft.triggerSelections??[]).filter(item=>!(item.automationId===template.automationId&&item.sourceIndex===template.sourceIndex))
      :[...(draft.triggerSelections??[]),{automationId:template.automationId,sourceIndex:template.sourceIndex}];
    update({triggerSelections:selections});
  }

  function addCondition(cond:Omit<ConditionItem,"id">){
    if(!draft)return;
    const item:ConditionItem={...cond,id:`cond-${Date.now()}-${Math.random().toString(36).slice(2,7)}`};
    update({conditions:[...draft.conditions,item]});
  }

  function updateCondition(id:string,patch:Partial<ConditionItem>){
    if(!draft)return;
    update({conditions:draft.conditions.map(c=>c.id===id?{...c,...patch}:c)});
  }

  function removeCondition(id:string){
    if(!draft)return;
    update({conditions:draft.conditions.filter(c=>c.id!==id)});
  }

  function updateTriggerTemplate(key:string,patch:Partial<TriggerTemplate>){
    setCatalog(current=>({
      ...current,
      triggerTemplates:current.triggerTemplates.map(t=>t.key===key?{...t,...patch}:t),
    }));
    if (draft?.triggers) {
      const parts = key.split(":");
      const sourceIndex = parts.length > 1 ? Number(parts[1]) : -1;
      const nextTriggers = draft.triggers.map((tr, idx) => {
        if (idx === sourceIndex || tr.label === patch.label) {
          return {
            ...tr,
            ...(patch.label ? { label: patch.label } : {}),
            ...(patch.deviceName ? { deviceName: patch.deviceName } : {}),
            ...(patch.room ? { room: patch.room } : {}),
            ...(patch.did ? { did: patch.did } : {}),
            ...(patch.detail ? { detail: patch.detail } : {}),
          };
        }
        return tr;
      });
      update({
        triggers: nextTriggers,
        triggerLabel: nextTriggers.map(t => t.label).join(draft.triggerMode === "all" ? " 且 " : " 或 "),
      });
    }
  }

  function addAction(){
    if(!draft||!actionKey)return;
    const option=catalog.actions.find(item=>item.key===actionKey);if(!option)return;
    const action:SceneDraftAction={clientId:`action-${Date.now()}`,kind:"set-properties",did:option.did,deviceName:option.deviceName,model:option.model,label:option.label,properties:[{siid:option.siid,piid:option.piid,value:actionValue(option)}]};
    update({actions:[...draft.actions,action]});
  }

  function addCustomAction(isFalseAction:boolean,option:CatalogAction){
    if(!draft)return;
    const action:SceneDraftAction={clientId:`act-${isFalseAction?"false-":""}${Date.now()}`,kind:"set-properties",did:option.did,deviceName:option.deviceName,model:option.model,label:option.label,properties:[{siid:option.siid,piid:option.piid,value:actionValue(option)}]};
    if(isFalseAction){
      update({falseActions:[...draft.falseActions,action]});
    }else{
      update({actions:[...draft.actions,action]});
    }
  }

  function removeAction(index:number){if(!draft)return;update({actions:draft.actions.filter((_,itemIndex)=>itemIndex!==index)})}
  function removeFalseAction(index:number){if(!draft)return;update({falseActions:draft.falseActions.filter((_,itemIndex)=>itemIndex!==index)})}

  function moveAction(index:number,delta:number,isFalseAction=false){
    if(!draft)return;
    const list=isFalseAction?[...draft.falseActions]:[...draft.actions];
    const target=index+delta;
    if(target<0||target>=list.length)return;
    const [moved]=list.splice(index,1);
    if(!moved)return;
    list.splice(target,0,moved);
    if(isFalseAction)update({falseActions:list});else update({actions:list});
  }

  function setPropertyValue(index:number,value:SceneValue,isFalseAction=false){
    if(!draft)return;
    const list=isFalseAction?[...draft.falseActions]:[...draft.actions];
    const current=list[index];
    if(!current||current.kind!=="set-properties"||!current.properties?.[0])return;
    const next={...current,properties:[{...current.properties[0],value}]};
    list[index]=next;
    if(isFalseAction)update({falseActions:list});else update({actions:list});
  }

  async function save(){
    if(!draft)return;
    if(homeId==="demo"){
      onMessage(`演示模式：已在本地${draft.sceneId?"更新":"创建"}自动化「${draft.name}」`);
      closeEditor();
      return;
    }
    setSaving(true);setError("");
    try{
      const editing=Boolean(draft.sceneId);
      const url=editing?`/api/xiaomi/automations/${encodeURIComponent(draft.sceneId)}?homeId=${encodeURIComponent(homeId)}`:`/api/xiaomi/automations?homeId=${encodeURIComponent(homeId)}`;
      const payload={
        homeId,
        name:draft.name.trim(),
        enabled:draft.enabled,
        triggerMode:draft.triggerMode,
        conditionMode:draft.conditionMode,
        conditions:draft.conditions,
        effectiveTime:draft.effectiveTime,
        ...(draft.schedule?{schedule:draft.schedule}:{}),
        triggerSelections:draft.triggerSelections?.map(sel => {
          const matched = catalog.triggerTemplates.find(t => t.automationId === sel.automationId && t.sourceIndex === sel.sourceIndex)
            || catalog.triggerTemplates.find(t => t.key === `${sel.automationId}:${sel.sourceIndex}`);
          return {
            automationId: sel.automationId,
            sourceIndex: sel.sourceIndex,
            ...(matched?.label ? { label: matched.label } : {}),
          };
        }),
        ...(draft.actionsEditable ? {
          actions: draft.actions.flatMap(action => {
            if (action.kind === "unsupported") return [];
            const matchedDev = devices.find(device => String(device.did) === String(action.did));
            const model = resolveActionModel(action, catalog.actions);
            const deviceName = action.deviceName || matchedDev?.name || "智能设备";
            const label = action.label || deviceName || "执行动作";
            const base = {
              clientId: action.clientId || `action-${Date.now()}`,
              kind: action.kind,
              did: action.did,
              deviceName,
              model,
              label,
              ...(Number.isInteger(action.sourceIndex) ? { sourceIndex: Number(action.sourceIndex) } : {}),
              ...(action.templateKey ? { templateKey: action.templateKey } : {}),
            };
            return action.kind === "invoke-action"
              ? [{ ...base, ...(Number.isInteger(action.siid) ? { siid: Number(action.siid) } : {}), ...(Number.isInteger(action.aiid) ? { aiid: Number(action.aiid) } : {}) }]
              : (action.properties ? [{ ...base, properties: action.properties }] : []);
          }),
        } : {}),
        falseActions: draft.falseActions.flatMap(action => {
          if (action.kind === "unsupported") return [];
          const matchedDev = devices.find(device => String(device.did) === String(action.did));
          const model = resolveActionModel(action, catalog.actions);
          const deviceName = action.deviceName || matchedDev?.name || "智能设备";
          const label = action.label || deviceName || "执行动作";
          const base = {
            clientId: action.clientId || `action-${Date.now()}`,
            kind: action.kind,
            did: action.did,
            deviceName,
            model,
            label,
            ...(Number.isInteger(action.sourceIndex) ? { sourceIndex: Number(action.sourceIndex) } : {}),
            ...(action.templateKey ? { templateKey: action.templateKey } : {}),
          };
          return action.kind === "invoke-action"
            ? [{ ...base, ...(Number.isInteger(action.siid) ? { siid: Number(action.siid) } : {}), ...(Number.isInteger(action.aiid) ? { aiid: Number(action.aiid) } : {}) }]
            : (action.properties ? [{ ...base, properties: action.properties }] : []);
        }),
        ...(editing?{revision:draft.revision}:{}),
      };
      const response=await fetch(url,{method:editing?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||"XIAOMI_AUTOMATION_SAVE_FAILED");
      await load();
      closeEditor();
      onMessage(`已${editing?"修改":"创建"}自动化「${draft.name}」`);
    }catch(reason){
      setError(reason instanceof Error?reason.message:"UNKNOWN_ERROR");
    }finally{
      setSaving(false);
    }
  }

  if(editorId!==null&&reviewing&&draft)return <AutomationReview draft={draft} templates={catalog.triggerTemplates} devices={devices} actionCatalog={catalog.propertyDescriptions} saving={saving} error={error} onBack={()=>{setError("");setReviewing(false)}} onCancel={closeEditor} onSave={()=>void save()}/>;
  if(editorId!==null)return <AutomationEditor draft={draft} error={error} devices={devices} triggerKinds={catalog.triggerKinds} triggerTemplates={catalog.triggerTemplates} triggerDevices={catalog.triggerDevices} catalogLoading={catalogLoading} onFetchCatalog={()=>void fetchCatalog()} rooms={rooms} actionRoom={actionRoom} actionOptions={actionOptions} actionCatalog={catalog.propertyDescriptions} actionKey={actionKey} onClose={closeEditor} onUpdate={update} onToggleSchedule={toggleSchedule} onToggleTriggerTemplate={toggleTriggerTemplate} onToggleDay={toggleDay} onToggleEffectiveDay={toggleEffectiveDay} onAddCondition={addCondition} onUpdateCondition={updateCondition} onRemoveCondition={removeCondition} onUpdateTriggerTemplate={updateTriggerTemplate} onActionRoom={setActionRoom} onActionKey={setActionKey} onAddAction={addAction} onAddCustomAction={addCustomAction} onRemoveAction={removeAction} onRemoveFalseAction={removeFalseAction} onMoveAction={moveAction} onPropertyValue={setPropertyValue} onReview={()=>{setError("");setReviewing(true)}}/>;
  if(selected)return <AutomationDetail automation={selected} devices={devices} homeName={homeName} connected={connected} onBack={()=>setSelected(null)} onEdit={()=>void openEditor(selected.id)}/>;

  const active=items.filter(item=>item.enabled),inactive=items.filter(item=>!item.enabled);
  return <section className="automation-center" aria-label="自动化中心">
    <header>
      <div><span>AUTOMATION</span><h2>智能自动化</h2><p>{homeName} · 联动触发、条件判断与双向分支动作</p></div>
      <button type="button" disabled={!connected&&homeId!=="demo"} onClick={()=>void openEditor()}>＋ 新建自动化</button>
    </header>
    {!connected&&<div className="automation-notice">当前展示米家风格演示数据；支持触发点（AND/OR）、前置条件（AND/OR）、True/False 分支动作及生效时段。扫码连接后读取真实自动化。</div>}
    {loading&&<div className="automation-state">正在读取米家自动化…</div>}
    {error&&<div className="automation-state error" role="alert">{friendlyError(error)} <button onClick={()=>void load()}>重试</button></div>}
    {!loading&&!error&&!items.length&&<div className="automation-empty"><span>⌁</span><strong>还没有自动化</strong><p>添加触发点、条件与动作，让全屋设备智能响应生活场景。</p></div>}
    <AutomationGroup title="正在运行" items={active} devices={devices} onOpen={setSelected}/>
    <AutomationGroup title="已停用" items={inactive} devices={devices} onOpen={setSelected}/>
  </section>;
}

function AutomationGroup({title,items,devices=[],onOpen}:{title:string;items:XiaomiAutomation[];devices?:ManagedDevice[];onOpen:(item:XiaomiAutomation)=>void}){
  if(!items.length)return null;
  return <section className="automation-group">
    <header><strong>{title}</strong><small>{items.length} 条</small></header>
    <div>
      {items.map(item=><button type="button" className="automation-card" key={item.id} onClick={()=>onOpen(item)}>
        <span className={`automation-status ${item.enabled?"on":"off"}`}><i/></span>
        <div>
          <strong>{item.name}</strong>
          <small>{item.triggers.map(trigger=>{
            const devCtx=resolveDeviceContext(trigger,devices);
            const devName=trigger.deviceName&&trigger.deviceName!=="智能设备"?trigger.deviceName:devCtx.deviceName!=="智能设备"?devCtx.deviceName:undefined;
            return `${devName?`${devName} · `:""}${trigger.label}`;
          }).join(item.triggerMode==="all"?" 且 ":" 或 ")}</small>
          <p>{item.conditions?.length?`[条件 ${item.conditions.length} 个] `:""}{item.actions.slice(0,2).map(action=>action.deviceName||action.label).join("、")||`${item.actionCount} 个动作`}{item.falseActions?.length?` · 否则: ${item.falseActions.length} 动作`:""}</p>
        </div>
        <b>›</b>
      </button>)}
    </div>
  </section>;
}

function AutomationDetail({automation,devices=[],homeName,connected,onBack,onEdit}:{automation:XiaomiAutomation;devices?:ManagedDevice[];homeName:string;connected:boolean;onBack:()=>void;onEdit:()=>void}){
  return <section className="automation-detail">
    <header>
      <button onClick={onBack}>← 返回自动化</button>
      {connected&&<button className="primary" onClick={onEdit}>编辑自动化</button>}
    </header>
    <div className="automation-detail-title">
      <span>⌁</span>
      <div>
        <small>{automation.enabled?"正在运行":"已停用"}</small>
        <h2>{automation.name}</h2>
        <p>{homeName}{automation.updatedAt?` · 更新于 ${automation.updatedAt}`:""}</p>
      </div>
    </div>
    <AutomationFlow automation={automation} devices={devices}/>
  </section>;
}

function AutomationFlow({automation,devices=[]}:{automation:XiaomiAutomation;devices?:ManagedDevice[]}){
  const conditions=automation.conditions||[];
  const falseActions=automation.falseActions||[];
  const effective=automation.effectiveTime;

  return <div className="automation-flow">
    {/* 01 触发点 */}
    <section className="automation-flow-block">
      <header>
        <span>IF</span>
        <div>
          <strong>如果（触发点）</strong>
          <small className="automation-mode-badge">{automation.triggerMode==="all"?"满足所有触发点 (AND)":"满足任一触发点 (OR)"}</small>
        </div>
      </header>
      {automation.triggers.map((trigger,index)=>{
        const devCtx=resolveDeviceContext(trigger,devices);
        const isSun=trigger.kind==="weather"&&/日出|日落|sunrise|sunset/i.test(trigger.label);
        const isDevice=!isSun&&(trigger.kind==="device"||Boolean(trigger.deviceName&&trigger.deviceName!=="智能设备")||Boolean(devCtx.deviceName&&devCtx.deviceName!=="智能设备"));
        const devName=trigger.deviceName&&trigger.deviceName!=="智能设备"?trigger.deviceName:devCtx.deviceName!=="智能设备"?devCtx.deviceName:undefined;
        const room=trigger.room&&trigger.room!=="未分配"?trigger.room:devCtx.room!=="未分配"?devCtx.room:undefined;
        return <div className="automation-flow-row" key={`${trigger.kind}:${index}`}>
          <i>{isSun?"☀":triggerGlyph(trigger.kind)}</i>
          <div className="automation-flow-content">
            <div className="automation-flow-meta">
              <span className={`automation-tag tag-${trigger.kind==="schedule"?"schedule":isDevice?"device":"weather"}`}>
                {isDevice?"智能设备":trigger.kind==="schedule"?"定时到达":isSun?"日出日落":trigger.kind==="weather"?"环境天气":trigger.kind==="location"?"位置变动":"触发"}
              </span>
              {room&&<span className="automation-room-tag">{room}</span>}
              {devName&&<strong className="automation-dev-name">{devName}</strong>}
              {devName&&<span className="automation-sep">·</span>}
              <strong>{trigger.label}</strong>
            </div>
            <small className="automation-flow-sub">
              {devName?`设备：${devName} | 触发事件：${trigger.label}${room?` | 房间：${room}`:""}`:isSun?`日出日落 · ${trigger.label}`:trigger.kind==="schedule"&&trigger.time?`定时：${trigger.time} · 重复：${scheduleWeekdaysSummary(trigger.weekdays||[1,2,3,4,5,6,7])}`:trigger.detail||"已验证触发条件"}
            </small>
          </div>
          {!trigger.editable&&<em>只读模板</em>}
        </div>;
      })}
    </section>

    <b className="automation-flow-link">↓</b>

    {/* 02 前置条件 */}
    <section className="automation-flow-block">
      <header>
        <span className="condition-span">WHEN</span>
        <div>
          <strong>{automation.conditionMode==="any"?"满足任一条件":"同时满足条件"}</strong>
          <small className="automation-mode-badge">{automation.conditionMode==="any"?"满足任一条件 (OR)":"满足所有条件 (AND)"}</small>
        </div>
      </header>
      {conditions.length>0?conditions.map((condition,index)=>{
        const devCtx=resolveDeviceContext(condition,devices);
        const isDevice=condition.kind==="device"||Boolean(condition.deviceName&&condition.deviceName!=="智能设备")||Boolean(devCtx.deviceName&&devCtx.deviceName!=="智能设备");
        const devName=condition.deviceName&&condition.deviceName!=="智能设备"?condition.deviceName:devCtx.deviceName!=="智能设备"?devCtx.deviceName:undefined;
        const room=condition.room&&condition.room!=="未分配"?condition.room:devCtx.room!=="未分配"?devCtx.room:undefined;
        return <div className="automation-flow-row" key={`${condition.kind}:${index}`}>
          <i>{condition.kind==="device"?"▣":condition.kind==="time"?"◷":"☀"}</i>
          <div className="automation-flow-content">
            <div className="automation-flow-meta">
              <span className={`automation-tag tag-${isDevice?"device":condition.kind==="time"?"time":"weather"}`}>
                {isDevice?"设备状态":condition.kind==="time"?"生效时段":"环境气象"}
              </span>
              {room&&<span className="automation-room-tag">{room}</span>}
              {devName&&<strong className="automation-dev-name">{devName}</strong>}
              {devName&&<span className="automation-sep">·</span>}
              <strong>{condition.label}</strong>
            </div>
            <small className="automation-flow-sub">
              {devName?`设备：${devName} | 状态判断：${condition.detail||condition.label}${room?` | 房间：${room}`:""}`:condition.kind==="time"&&condition.timeRange?`时段：${condition.timeRange.start} ~ ${condition.timeRange.end} · 重复：${scheduleWeekdaysSummary(condition.weekdays||[1,2,3,4,5,6,7])}`:condition.detail||"已验证状态判断"}
            </small>
          </div>
        </div>;
      }):<div className="automation-flow-empty-cond">无额外前置条件 · 触发点成立即执行后续动作</div>}
    </section>

    <b className="automation-flow-link">↓</b>

    {/* 03 True / False 双分支动作 */}
    <div className="automation-branches-grid">
      {/* 满足条件时执行 (True) */}
      <section className="automation-flow-block branch-true">
        <header>
          <span className="true-span">THEN</span>
          <div>
            <strong>满足条件时执行 (True)</strong>
            <small>按顺序执行 · {automation.actions.length} 个动作</small>
          </div>
        </header>
        {automation.actions.map((action,index)=><div className="automation-flow-row" key={index}>
          <i>{index+1}</i>
          <div>
            <strong>{action.deviceName||action.label}</strong>
            <small>{action.details.map(detail=>`${detail.label} ${detail.value}`).join(" · ")||action.label}</small>
          </div>
        </div>)}
      </section>

      {/* 不满足条件时执行 (False) */}
      <section className="automation-flow-block branch-false">
        <header>
          <span className="false-span">ELSE</span>
          <div>
            <strong>不满足条件时执行 (False)</strong>
            <small>{falseActions.length?`按顺序执行 · ${falseActions.length} 个动作`:"未配置备用动作"}</small>
          </div>
        </header>
        {falseActions.length>0?falseActions.map((action,index)=><div className="automation-flow-row" key={index}>
          <i>{index+1}</i>
          <div>
            <strong>{action.deviceName||action.label}</strong>
            <small>{action.details.map(detail=>`${detail.label} ${detail.value}`).join(" · ")||action.label}</small>
          </div>
        </div>):<div className="automation-flow-empty-cond">条件不满足时不执行任何操作</div>}
      </section>
    </div>

    {/* 04 生效时段与其他条件 */}
    {effective&&<section className="automation-flow-block time-block">
      <header>
        <span className="time-span">TIME</span>
        <div>
          <strong>生效时段与其他条件</strong>
          <small>{effectiveTimeLabel(effective)}</small>
        </div>
      </header>
      <div className="automation-effective-preview">
        <span>时区：Asia/Shanghai (中国标准时间)</span>
        <div className="automation-weekdays readonly">
          {["一","二","三","四","五","六","日"].map((label,index)=><span className={effective.weekdays.includes(index+1)?"selected":""} key={label}>周{label}</span>)}
        </div>
      </div>
    </section>}
  </div>;
}

function AutomationEditor({
  draft,error,devices,triggerKinds,triggerTemplates,triggerDevices,catalogLoading,onFetchCatalog,rooms,actionRoom,actionOptions,actionCatalog,actionKey,
  onClose,onUpdate,onToggleSchedule,onToggleTriggerTemplate,onToggleDay,onToggleEffectiveDay,onAddCondition,onUpdateCondition,onRemoveCondition,onUpdateTriggerTemplate,
  onActionRoom,onActionKey,onAddAction,onAddCustomAction,onRemoveAction,onRemoveFalseAction,onMoveAction,onPropertyValue,onReview,
}:{
  draft?:EditorState;error:string;devices:ManagedDevice[];triggerKinds:TriggerKind[];triggerTemplates:TriggerTemplate[];triggerDevices:TriggerDevice[];
  catalogLoading:boolean;onFetchCatalog:()=>void;rooms:string[];actionRoom:string;actionOptions:CatalogAction[];actionCatalog:CatalogPropertyDescription[];actionKey:string;
  onClose:()=>void;onUpdate:(patch:Partial<EditorState>)=>void;onToggleSchedule:()=>void;onToggleTriggerTemplate:(template:TriggerTemplate)=>void;
  onToggleDay:(day:number)=>void;onToggleEffectiveDay:(day:number)=>void;onAddCondition:(c:Omit<ConditionItem,"id">)=>void;
  onUpdateCondition:(id:string,patch:Partial<ConditionItem>)=>void;onRemoveCondition:(id:string)=>void;onUpdateTriggerTemplate:(key:string,patch:Partial<TriggerTemplate>)=>void;
  onActionRoom:(room:string)=>void;onActionKey:(key:string)=>void;onAddAction:()=>void;onAddCustomAction:(isFalse:boolean,opt:CatalogAction)=>void;
  onRemoveAction:(index:number)=>void;onRemoveFalseAction:(index:number)=>void;onMoveAction:(index:number,delta:number,isFalse?:boolean)=>void;
  onPropertyValue:(index:number,value:SceneValue,isFalse?:boolean)=>void;onReview:()=>void;
}){
  const [activeKind,setActiveKind]=useState("");
  const [deviceKey,setDeviceKey]=useState("");
  const [showTriggerPicker,setShowTriggerPicker]=useState(false);

  // Inline trigger editor state
  const [editingSchedule,setEditingSchedule]=useState(false);
  const [editingTriggerKey,setEditingTriggerKey]=useState<string|null>(null);
  const [editTriggerDraft,setEditTriggerDraft]=useState<{label:string;deviceName?:string;room?:string;detail?:string;did?:string}>({label:""});
  const [showTriggerDevPicker,setShowTriggerDevPicker]=useState(false);

  // Inline condition editor state
  const [editingConditionId,setEditingConditionId]=useState<string|null>(null);
  const [editCondDraft,setEditCondDraft]=useState<Partial<ConditionItem>>({});
  const [showCondDevPicker,setShowCondDevPicker]=useState(false);

  // Sun trigger builder and editing state
  const [sunType, setSunType] = useState<"sunrise" | "sunset">("sunrise");
  const [sunOffsetType, setSunOffsetType] = useState<"at" | "before" | "after">("after");
  const [sunOffsetMinutes, setSunOffsetMinutes] = useState(60);
  const [sunWeekdays, setSunWeekdays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const [sunRepeatMode, setSunRepeatMode] = useState<"everyday" | "workday" | "weekend" | "custom">("everyday");

  // Weather / Temperature condition builder & editor state
  const [weatherSubTab, setWeatherSubTab] = useState<"temp" | "humidity" | "weather" | "aqi">("temp");
  const [weatherTempOp, setWeatherTempOp] = useState<"高于" | "低于">("低于");
  const [weatherTempValue, setWeatherTempValue] = useState<number>(30);
  const [weatherHumidOp, setWeatherHumidOp] = useState<"高于" | "低于">("高于");
  const [weatherHumidValue, setWeatherHumidValue] = useState<number>(60);

  // Condition builder state
  const [conditionCategory,setConditionCategory]=useState<"device"|"time"|"weather"|"">("");
  const [condDeviceKey,setCondDeviceKey]=useState("");
  const [condTimeStart,setCondTimeStart]=useState("08:00");
  const [condTimeEnd,setCondTimeEnd]=useState("22:00");

  // Action branch selection state
  const [actionCategory,setActionCategory]=useState<"device"|"scene"|"automation"|"delay"|"notice"|"">("");
  const [delaySeconds,setDelaySeconds]=useState(5);
  const [noticeText,setNoticeText]=useState("全屋联动已执行");

  if(!draft)return <section className="automation-editor"><div className="automation-state">正在准备自动化编辑器…</div>{error&&<div className="automation-state error">{friendlyError(error)}</div>}</section>;

  const templatesForKind=triggerTemplates.filter(template=>triggerCategory(template)===activeKind);
  const deviceTemplates=triggerTemplates.filter(template=>template.kind==="device"&&template.deviceKey);
  const templateDevices:TriggerDevice[]=deviceTemplates.map(template=>{
    const devCtx = resolveDeviceContext(template, devices, triggerDevices);
    return {
      key: template.deviceKey!,
      did: template.did || devCtx.did,
      deviceName: devCtx.deviceName,
      room: devCtx.room,
      capabilities: [],
      actions: [],
      discovery: "unavailable" as const
    };
  });
  const managedTriggerDevices: TriggerDevice[] = devices.map((device, index) => ({
    key: `managed-${device.did || index}`,
    did: device.did,
    model: device.kind,
    deviceName: device.name,
    room: device.room || "未分配",
    capabilities: [],
    actions: [],
    discovery: "miot-spec" as const,
  }));
  const visibleTriggerDevices=Array.from(new Map<string,TriggerDevice>([
    ...templateDevices.map(device=>[device.key,device] as [string,TriggerDevice]),
    ...managedTriggerDevices.map(device=>[device.key,device] as [string,TriggerDevice]),
    ...triggerDevices.map(device=>{
      const managed = device.did ? devices.find(d => String(d.did) === String(device.did)) : devices.find(d => d.name === device.deviceName);
      const room = device.room && device.room !== "未分配" ? device.room : (managed?.room || "未分配");
      const deviceName = device.deviceName && device.deviceName !== "智能设备" ? device.deviceName : (managed?.name || device.deviceName);
      return [device.key, {
        ...device,
        deviceName,
        room,
        did: device.did || managed?.did,
      }] as [string, TriggerDevice];
    }),
  ]).values());
  const activeDeviceTemplates=deviceTemplates.filter(template=>template.deviceKey===deviceKey);
  const activeDevice=visibleTriggerDevices.find(device=>device.key===deviceKey);
  const selectedTemplates=triggerTemplates.filter(template=>selectedTemplate(draft,template));
  const triggerCount=(draft.schedule?1:0)+(draft.triggerSelections?.length??0);

  function closeTriggerPicker(){setShowTriggerPicker(false);setActiveKind("");setDeviceKey("")}

  // Device selections for conditions
  const activeCondDevice=visibleTriggerDevices.find(d=>d.key===condDeviceKey);

  return <section className="automation-editor automation-editor-single" aria-label={draft.sceneId?"修改自动化":"新建自动化"}>
    <header>
      <button onClick={onClose}>← 返回自动化</button>
      <div><span>AUTOMATION</span><h2>{draft.sceneId?"编辑自动化":"新建自动化"}</h2></div>
    </header>

    <div className="automation-editor-body">
      {/* 01 基本信息 */}
      <section className="automation-editor-section">
        <div className="automation-section-copy"><b>01</b><div><strong>基本信息</strong><p>设置名称与启用状态。新建规则默认关闭。</p></div></div>
        <div className="automation-basic-grid">
          <label className="automation-field">
            <span>自动化名称</span>
            <input maxLength={50} value={draft.name} placeholder="例如：回家后打开玄关灯" onChange={event=>onUpdate({name:event.target.value})}/>
          </label>
          <label className="automation-field-toggle">
            <span>规则启用状态</span>
            <button type="button" className={`automation-status-btn ${draft.enabled?"on":"off"}`} onClick={()=>onUpdate({enabled:!draft.enabled})}>
              {draft.enabled?"已启用":"已停用"}
            </button>
          </label>
        </div>
      </section>

      {/* 02 触发条件（触发点） */}
      <section className="automation-editor-section">
        <div className="automation-section-copy">
          <b>02</b>
          <div>
            <strong>触发条件</strong>
            <p>先确认已选条件，需要更多条件时再添加。主要逻辑包含触发点（and/or 关系）及可选类别，参考米家 App 支持智能设备、环境变化等。</p>
          </div>
        </div>

        {/* 触发点关系切换器 */}
        {triggerCount>1&&<div className="automation-trigger-mode" role="radiogroup" aria-label="触发点关系">
          <button type="button" className={draft.triggerMode==="any"?"selected":""} aria-pressed={draft.triggerMode==="any"} onClick={()=>onUpdate({triggerMode:"any"})}>任一条件满足</button>
          <button type="button" className={draft.triggerMode==="all"?"selected":""} aria-pressed={draft.triggerMode==="all"} onClick={()=>onUpdate({triggerMode:"all"})}>全部条件满足</button>
        </div>}

        {/* 已选触发点列表 - 必须在 builder 之前 */}
        <div className="automation-selected-panel">
          <div className="automation-selected-heading">
            <div><strong>已选触发点</strong><small>{triggerCount} 个触发点已配置</small></div>
            {!showTriggerPicker&&<button type="button" aria-expanded={showTriggerPicker} aria-controls="automation-trigger-picker" onClick={()=>setShowTriggerPicker(true)}>＋ 添加触发条件</button>}
          </div>
          {triggerCount>0?<ol className="automation-selected-triggers">
            {draft.schedule&&<li className={`automation-selected-trigger${editingSchedule?" editing":""}`}>
              <i>◷</i>
              <div className="automation-selected-info">
                <div className="automation-selected-meta">
                  <span className="automation-tag tag-schedule">定时到达</span>
                  <strong>指定时间：{scheduleLabel(draft.schedule)}</strong>
                </div>
                <small className="automation-selected-sub">按指定时间和重复周期准时触发 · {draft.schedule.time}</small>
                {editingSchedule&&<div className="automation-inline-editor">
                  <label className="automation-inline-field">
                    <span>设定触发时间</span>
                    <input type="time" value={draft.schedule.time} onChange={event=>onUpdate({schedule:{...draft.schedule!,time:event.target.value}})}/>
                  </label>
                  <div className="automation-inline-field">
                    <span>重复周期</span>
                    <div className="automation-weekdays">
                      {["一","二","三","四","五","六","日"].map((label,index)=><button type="button" className={draft.schedule!.weekdays.includes(index+1)?"selected":""} key={label} onClick={()=>onToggleDay(index+1)}>周{label}</button>)}
                    </div>
                    <div className="automation-quick-presets">
                      <button type="button" onClick={()=>onUpdate({schedule:{...draft.schedule!,weekdays:[1,2,3,4,5,6,7]}})}>每天</button>
                      <button type="button" onClick={()=>onUpdate({schedule:{...draft.schedule!,weekdays:[1,2,3,4,5]}})}>工作日</button>
                      <button type="button" onClick={()=>onUpdate({schedule:{...draft.schedule!,weekdays:[6,7]}})}>周末</button>
                    </div>
                  </div>
                  <div className="automation-inline-actions">
                    <button type="button" className="automation-btn-save" onClick={()=>setEditingSchedule(false)}>完成</button>
                  </div>
                </div>}
              </div>
              <div className="automation-selected-actions">
                <button type="button" className="automation-btn-edit" onClick={()=>setEditingSchedule(!editingSchedule)}>{editingSchedule?"收起":"编辑"}</button>
                <button type="button" aria-label="移除条件：指定时间" onClick={onToggleSchedule}>移除</button>
              </div>
            </li>}
            {selectedTemplates.map(template=>{
              const isEditing = editingTriggerKey === template.key;
              const devCtx = resolveDeviceContext(template, devices, visibleTriggerDevices);
              const isSun = triggerCategory(template) === "sun";
              const isDevice = !isSun && (template.kind === "device" || Boolean(template.deviceName) || Boolean(devCtx.deviceName && devCtx.deviceName !== "智能设备"));
              const currentDevName = isEditing && editTriggerDraft.deviceName && editTriggerDraft.deviceName !== "智能设备"
                ? editTriggerDraft.deviceName
                : ((template.deviceName && template.deviceName !== "智能设备") ? template.deviceName : devCtx.deviceName);
              const currentRoom = isEditing && editTriggerDraft.room && editTriggerDraft.room !== "未分配"
                ? editTriggerDraft.room
                : ((template.room && template.room !== "未分配") ? template.room : devCtx.room);

              return <li className={`automation-selected-trigger${isEditing?" editing":""}`} key={template.key}>
                <i>{isSun ? "☀" : triggerGlyph(template.kind)}</i>
                <div className="automation-selected-info">
                  <div className="automation-selected-meta">
                    <span className={`automation-tag tag-${isDevice?"device":isSun?"weather":template.kind==="weather"?"weather":"schedule"}`}>
                      {isDevice?"智能设备":isSun?"日出日落":template.kind==="weather"?"环境气象":template.kind==="location"?"位置变动":"触发条件"}
                    </span>
                    {currentRoom && currentRoom !== "未分配" && <span className="automation-room-tag">{currentRoom}</span>}
                    {currentDevName && currentDevName !== "智能设备" && <strong className="automation-dev-name">{currentDevName}</strong>}
                    {currentDevName && currentDevName !== "智能设备" && <span className="automation-sep">·</span>}
                    <strong className="automation-item-label">{template.label}</strong>
                  </div>
                  <small className="automation-selected-sub">
                    {currentDevName && currentDevName !== "智能设备"
                      ? `设备：${currentDevName} | 触发事件：${template.label}${currentRoom && currentRoom !== "未分配" ? ` | 房间：${currentRoom}` : ""}`
                      : isSun
                      ? `日出日落 · ${template.label}`
                      : (template.detail || (currentRoom && currentRoom !== "未分配" ? `房间：${currentRoom}` : "已验证条件模板"))}
                  </small>
                  {isEditing&&<div className="automation-inline-editor">
                    {isSun ? (
                      <div className="automation-sun-builder-inline">
                        <div className="automation-sun-field">
                          <span className="automation-sun-label">条件事件</span>
                          <div className="automation-sun-type-pills" role="radiogroup" aria-label="日出或日落">
                            <button type="button" className={sunType==="sunrise"?"selected":""} onClick={()=>{
                              setSunType("sunrise");
                              const lbl = formatSunLabel("sunrise", sunOffsetType, sunOffsetMinutes, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · 日出${sunOffsetType==="at"?"正当时":sunOffsetType==="before"?`前${sunOffsetMinutes}分钟`:`后${sunOffsetMinutes}分钟`}`}));
                            }}>🌅 日出</button>
                            <button type="button" className={sunType==="sunset"?"selected":""} onClick={()=>{
                              setSunType("sunset");
                              const lbl = formatSunLabel("sunset", sunOffsetType, sunOffsetMinutes, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · 日落${sunOffsetType==="at"?"正当时":sunOffsetType==="before"?`前${sunOffsetMinutes}分钟`:`后${sunOffsetMinutes}分钟`}`}));
                            }}>🌇 日落</button>
                          </div>
                        </div>

                        <div className="automation-sun-field">
                          <span className="automation-sun-label">触发时机</span>
                          <div className="automation-sun-offset-pills" role="radiogroup" aria-label="触发时机">
                            <button type="button" className={sunOffsetType==="at"?"selected":""} onClick={()=>{
                              setSunOffsetType("at");
                              const lbl = formatSunLabel(sunType, "at", 0, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}正当时`}));
                            }}>{sunType==="sunset"?"日落时":"日出时"} (正当时)</button>
                            <button type="button" className={sunOffsetType==="before"?"selected":""} onClick={()=>{
                              setSunOffsetType("before");
                              const lbl = formatSunLabel(sunType, "before", sunOffsetMinutes, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}前${sunOffsetMinutes}分钟`}));
                            }}>{sunType==="sunset"?"日落前":"日出前"}</button>
                            <button type="button" className={sunOffsetType==="after"?"selected":""} onClick={()=>{
                              setSunOffsetType("after");
                              const lbl = formatSunLabel(sunType, "after", sunOffsetMinutes, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}后${sunOffsetMinutes}分钟`}));
                            }}>{sunType==="sunset"?"日落后":"日出后"}</button>
                          </div>
                        </div>

                        {sunOffsetType!=="at"&&<div className="automation-sun-field">
                          <span className="automation-sun-label">偏移时长</span>
                          <div className="automation-sun-minutes-quick">
                            {[15,30,45,60,90,120].map(mins=><button type="button" key={mins} className={sunOffsetMinutes===mins?"selected":""} onClick={()=>{
                              setSunOffsetMinutes(mins);
                              const lbl = formatSunLabel(sunType, sunOffsetType, mins, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}${sunOffsetType==="before"?"前":"后"}${mins}分钟`}));
                            }}>{mins}分钟</button>)}
                          </div>
                          <div className="automation-sun-custom-minutes">
                            <span>自定义分钟：</span>
                            <input type="number" min={1} max={240} value={sunOffsetMinutes} onChange={e=>{
                              const mins = Math.max(1, Math.min(240, Number(e.target.value)||1));
                              setSunOffsetMinutes(mins);
                              const lbl = formatSunLabel(sunType, sunOffsetType, mins, sunWeekdays);
                              setEditTriggerDraft(d=>({...d, label: lbl, detail: `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}${sunOffsetType==="before"?"前":"后"}${mins}分钟`}));
                            }}/>
                            <span>分钟</span>
                          </div>
                        </div>}

                        <div className="automation-sun-field">
                          <span className="automation-sun-label">重复周期</span>
                          <div className="automation-sun-repeat-pills" role="radiogroup" aria-label="重复周期">
                            <button type="button" className={sunRepeatMode==="everyday"?"selected":""} onClick={()=>{
                              setSunRepeatMode("everyday");
                              const days=[1,2,3,4,5,6,7];
                              setSunWeekdays(days);
                              const lbl = formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, days);
                              setEditTriggerDraft(d=>({...d, label: lbl}));
                            }}>每天</button>
                            <button type="button" className={sunRepeatMode==="workday"?"selected":""} onClick={()=>{
                              setSunRepeatMode("workday");
                              const days=[1,2,3,4,5];
                              setSunWeekdays(days);
                              const lbl = formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, days);
                              setEditTriggerDraft(d=>({...d, label: lbl}));
                            }}>工作日</button>
                            <button type="button" className={sunRepeatMode==="weekend"?"selected":""} onClick={()=>{
                              setSunRepeatMode("weekend");
                              const days=[6,7];
                              setSunWeekdays(days);
                              const lbl = formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, days);
                              setEditTriggerDraft(d=>({...d, label: lbl}));
                            }}>周末</button>
                            <button type="button" className={sunRepeatMode==="custom"?"selected":""} onClick={()=>setSunRepeatMode("custom")}>自定义</button>
                          </div>
                          {sunRepeatMode==="custom"&&<div className="automation-sun-weekdays">
                            {[1,2,3,4,5,6,7].map(day=><button type="button" key={day} className={sunWeekdays.includes(day)?"selected":""} onClick={()=>{
                              const next = sunWeekdays.includes(day)
                                ? (sunWeekdays.length>1 ? sunWeekdays.filter(d=>d!==day) : sunWeekdays)
                                : [...sunWeekdays,day].sort();
                              setSunWeekdays(next);
                              const lbl = formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, next);
                              setEditTriggerDraft(d=>({...d, label: lbl}));
                            }}>周{"一二三四五六日"[day-1]}</button>)}
                          </div>}
                        </div>

                        <div className="automation-inline-field">
                          <span>当前设定预览</span>
                          <div className="automation-sun-preview-box">
                            <strong>☀ {editTriggerDraft.label || formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, sunWeekdays)}</strong>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <label className="automation-inline-field">
                          <span>触发名称 / 备注说明</span>
                          <input type="text" value={editTriggerDraft.label} onChange={e=>setEditTriggerDraft({...editTriggerDraft,label:e.target.value})} placeholder="如：按一次无线开关 / 门已打开"/>
                        </label>
                        {isDevice&&<div className="automation-inline-field">
                          <div className="automation-inline-dev">
                            <span>关联设备：<strong>{currentDevName && currentDevName !== "智能设备" ? currentDevName : "请选择智能设备"}</strong> {currentRoom && currentRoom !== "未分配" && currentDevName && currentDevName !== "智能设备" ? `(${currentRoom})` : ""}</span>
                            <button type="button" className="automation-switch-btn" onClick={()=>setShowTriggerDevPicker(!showTriggerDevPicker)}>{showTriggerDevPicker?"收起设备":"更换设备"}</button>
                          </div>
                          {showTriggerDevPicker&&<div className="automation-device-picker">
                            {visibleTriggerDevices.map(dev=><button type="button" key={dev.key} onClick={()=>{
                              setEditTriggerDraft({
                                ...editTriggerDraft,
                                deviceName: dev.deviceName,
                                room: dev.room,
                                did: dev.did,
                                detail: `${dev.deviceName}${dev.room && dev.room !== "未分配" ? ` · ${dev.room}` : ""}`,
                              });
                              setShowTriggerDevPicker(false);
                            }}>
                              <i>▣</i>
                              <span><strong>{dev.deviceName}</strong><small>{dev.room} · {dev.capabilities.length} 个条件可用</small></span>
                              <b>✓</b>
                            </button>)}
                          </div>}
                        </div>}
                        <label className="automation-inline-field">
                          <span>详细参数说明</span>
                          <input type="text" value={editTriggerDraft.detail||""} onChange={e=>setEditTriggerDraft({...editTriggerDraft,detail:e.target.value})} placeholder="如：按键按下一次 / 任意开锁"/>
                        </label>
                      </>
                    )}
                    <div className="automation-inline-actions">
                      <button type="button" className="automation-btn-save" onClick={()=>{
                        const finalLabel = isSun
                          ? (editTriggerDraft.label || formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, sunWeekdays))
                          : editTriggerDraft.label;
                        const finalDetail = isSun
                          ? `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}${sunOffsetType==="at"?"正当时":sunOffsetType==="before"?`前${sunOffsetMinutes}分钟`:`后${sunOffsetMinutes}分钟`}`
                          : editTriggerDraft.detail;
                        onUpdateTriggerTemplate(template.key, { ...editTriggerDraft, label: finalLabel, ...(finalDetail ? { detail: finalDetail } : {}) });
                        setEditingTriggerKey(null);
                      }}>保存修改</button>
                      <button type="button" className="automation-btn-cancel" onClick={()=>setEditingTriggerKey(null)}>取消</button>
                    </div>
                  </div>}
                </div>
                <div className="automation-selected-actions">
                  <button type="button" className="automation-btn-edit" onClick={()=>{
                    if(isEditing){
                      setEditingTriggerKey(null);
                    }else{
                      setEditingTriggerKey(template.key);
                      if (isSun) {
                        const parsed = parseSunFromLabel(template.label);
                        setSunType(parsed.type);
                        setSunOffsetType(parsed.offsetType);
                        setSunOffsetMinutes(parsed.offsetMinutes);
                        setSunWeekdays(parsed.weekdays);
                        setSunRepeatMode(parsed.repeatMode);
                      }
                      setEditTriggerDraft({
                        label: template.label,
                        deviceName: currentDevName !== "智能设备" ? currentDevName : template.deviceName,
                        room: currentRoom !== "未分配" ? currentRoom : template.room,
                        did: template.did || devCtx.did,
                        detail: template.detail,
                      });
                      setShowTriggerDevPicker(false);
                    }
                  }}>{isEditing?"收起":"编辑"}</button>
                  <button type="button" aria-label={`移除条件：${template.label}`} onClick={()=>onToggleTriggerTemplate(template)}>移除</button>
                </div>
              </li>;
            })}
          </ol>:<div className="automation-selected-empty">尚未添加触发点。点击下方按钮从智能设备或环境选择触发条件。</div>}
        </div>

        {/* 添加触发点选择器 (参考米家 App) */}
        {showTriggerPicker&&<div className="automation-trigger-builder" id="automation-trigger-picker">
          <div className="automation-builder-head">
            <strong>选择触发点类别 (参考米家 App)</strong>
            <button type="button" onClick={closeTriggerPicker}>收起</button>
          </div>
          <div className="automation-trigger-kinds">
            {triggerKinds.map(kind=><button type="button" key={kind.kind} className={activeKind===kind.kind?"selected":""} onClick={()=>{
              const nextKind = activeKind===kind.kind?"":kind.kind;
              setActiveKind(nextKind);
              setDeviceKey("");
              if(nextKind==="sun"){
                const existingSun = triggerTemplates.find(t=>triggerCategory(t)==="sun") || draft.triggers?.find(tr=>/日出|日落/.test(tr.label));
                if(existingSun){
                  const parsed = parseSunFromLabel(existingSun.label);
                  setSunType(parsed.type);
                  setSunOffsetType(parsed.offsetType);
                  setSunOffsetMinutes(parsed.offsetMinutes);
                  setSunWeekdays(parsed.weekdays);
                  setSunRepeatMode(parsed.repeatMode);
                }
              }
            }}>
              <i>{triggerGlyph(kind.kind)}</i>
              <span><strong>{kind.label}</strong><small>{kind.kind==="schedule"?"定时到达":kind.kind==="device"?"先选择设备":"选择具体条件"}</small></span>
              <b aria-hidden="true">›</b>
            </button>)}
          </div>

          {activeKind&&<div className="automation-trigger-config">
            {activeKind==="schedule"&&<>
              <div className="automation-config-title">
                <div><strong>指定时间</strong><small>按指定时间和星期触发</small></div>
                <button type="button" className={draft.schedule?"selected":""} aria-pressed={Boolean(draft.schedule)} onClick={onToggleSchedule}>
                  {draft.schedule?"移除":"选择"}
                </button>
              </div>
              {draft.schedule&&<label className="automation-time">
                <span>指定时间</span>
                <input type="time" value={draft.schedule.time} onChange={event=>onUpdate({schedule:{...draft.schedule!,time:event.target.value}})}/>
              </label>}
            </>}

            {activeKind==="device"&&<>
              <div className="automation-config-title">
                <div>
                  <strong>{deviceKey?"选择状态变化与动作":"选择设备"}</strong>
                  <small>{deviceKey?"优先来自米家当前设备的私有自动化目录":"调用 IoT 接口获取当前家庭已同步的全部可选物理设备"}</small>
                </div>
                {deviceKey&&<button type="button" onClick={()=>setDeviceKey("")}>重新选设备</button>}
              </div>

              {!deviceKey&&<div className="automation-device-picker">
                {visibleTriggerDevices.map(device=><button type="button" key={device.key} onClick={()=>setDeviceKey(device.key)}>
                  <i>▣</i>
                  <span><strong>{device.deviceName}</strong><small>{device.room} · {discoverySummary(device)}</small></span>
                  <b>›</b>
                </button>)}
              </div>}

              {!deviceKey&&!visibleTriggerDevices.length&&<div className="automation-readonly">
                <strong>当前家庭暂无已同步设备</strong>
                <p>请返回设备页重新同步后再试。</p>
              </div>}

              {deviceKey&&<>
                {activeDeviceTemplates.length>0&&<div className="automation-capability-group">
                  <strong>可直接使用的真实条件</strong>
                  <TriggerTemplatePicker templates={activeDeviceTemplates} draft={draft} onToggle={onToggleTriggerTemplate}/>
                </div>}

                <div className="automation-capability-group">
                  <strong>米家支持的状态变化</strong>
                  {activeDevice?.capabilities.length?<div className="automation-discovered-capabilities">
                    {activeDevice.capabilities.map(capability=><div key={capability.key}>
                      <span><strong>{capability.label}</strong><small>{capability.detail}</small></span>
                      <em>{catalogSourceLabel(capability.source)}</em>
                    </div>)}
                  </div>:<div className="automation-readonly">
                    <strong>{activeDevice?.discovery==="unavailable"?"自动化目录暂时不可用":"米家目录未声明设备条件"}</strong>
                    <p>{activeDeviceTemplates.length?"仍可使用从已有自动化确认的真实条件。":"目前没有可展示的状态变化。"}</p>
                  </div>}
                </div>

                {Boolean(activeDevice?.actions.length)&&<div className="automation-capability-group">
                  <strong>米家支持的执行动作</strong>
                  <div className="automation-discovered-capabilities">
                    {activeDevice!.actions.map(action=><div key={action.key}>
                      <span><strong>{action.label}</strong><small>{action.detail}</small></span>
                      <em>{catalogSourceLabel(action.source)}</em>
                    </div>)}
                  </div>
                </div>}

                {!activeDeviceTemplates.length&&Boolean(activeDevice?.capabilities.length)&&<div className="automation-capability-note">
                  这些条件已由米家自动化目录或 MIoT 规格确认。条件详情可以查看；新建时仍只提交已经从真实自动化验证过完整节点的数据。
                </div>}
              </>}
            </>}

            {activeKind==="sun"&&<div className="automation-trigger-config automation-sun-builder">
              <div className="automation-config-title">
                <div>
                  <strong>日出或日落条件配置</strong>
                  <small>支持自由配置日出/日落事件、时间偏移与重复周期（参考米家 App）</small>
                </div>
              </div>

              <div className="automation-sun-field">
                <span className="automation-sun-label">条件事件</span>
                <div className="automation-sun-type-pills" role="radiogroup" aria-label="日出或日落">
                  <button type="button" className={sunType==="sunrise"?"selected":""} onClick={()=>setSunType("sunrise")}>🌅 日出</button>
                  <button type="button" className={sunType==="sunset"?"selected":""} onClick={()=>setSunType("sunset")}>🌇 日落</button>
                </div>
              </div>

              <div className="automation-sun-field">
                <span className="automation-sun-label">触发时机</span>
                <div className="automation-sun-offset-pills" role="radiogroup" aria-label="触发时机">
                  <button type="button" className={sunOffsetType==="at"?"selected":""} onClick={()=>setSunOffsetType("at")}>{sunType==="sunset"?"日落时":"日出时"} (正当时)</button>
                  <button type="button" className={sunOffsetType==="before"?"selected":""} onClick={()=>setSunOffsetType("before")}>{sunType==="sunset"?"日落前":"日出前"}</button>
                  <button type="button" className={sunOffsetType==="after"?"selected":""} onClick={()=>setSunOffsetType("after")}>{sunType==="sunset"?"日落后":"日出后"}</button>
                </div>
              </div>

              {sunOffsetType!=="at"&&<div className="automation-sun-field">
                <span className="automation-sun-label">偏移时长</span>
                <div className="automation-sun-minutes-quick">
                  {[15,30,45,60,90,120].map(mins=><button type="button" key={mins} className={sunOffsetMinutes===mins?"selected":""} onClick={()=>setSunOffsetMinutes(mins)}>{mins}分钟</button>)}
                </div>
                <div className="automation-sun-custom-minutes">
                  <span>自定义分钟：</span>
                  <input type="number" min={1} max={240} value={sunOffsetMinutes} onChange={e=>setSunOffsetMinutes(Math.max(1, Math.min(240, Number(e.target.value)||1)))}/>
                  <span>分钟</span>
                </div>
              </div>}

              <div className="automation-sun-field">
                <span className="automation-sun-label">重复周期</span>
                <div className="automation-sun-repeat-pills" role="radiogroup" aria-label="重复周期">
                  <button type="button" className={sunRepeatMode==="everyday"?"selected":""} onClick={()=>{setSunRepeatMode("everyday");setSunWeekdays([1,2,3,4,5,6,7]);}}>每天</button>
                  <button type="button" className={sunRepeatMode==="workday"?"selected":""} onClick={()=>{setSunRepeatMode("workday");setSunWeekdays([1,2,3,4,5]);}}>工作日</button>
                  <button type="button" className={sunRepeatMode==="weekend"?"selected":""} onClick={()=>{setSunRepeatMode("weekend");setSunWeekdays([6,7]);}}>周末</button>
                  <button type="button" className={sunRepeatMode==="custom"?"selected":""} onClick={()=>setSunRepeatMode("custom")}>自定义</button>
                </div>
                {sunRepeatMode==="custom"&&<div className="automation-sun-weekdays">
                  {[1,2,3,4,5,6,7].map(day=><button type="button" key={day} className={sunWeekdays.includes(day)?"selected":""} onClick={()=>{
                    const next = sunWeekdays.includes(day)
                      ? (sunWeekdays.length>1 ? sunWeekdays.filter(d=>d!==day) : sunWeekdays)
                      : [...sunWeekdays,day].sort();
                    setSunWeekdays(next);
                  }}>周{"一二三四五六日"[day-1]}</button>)}
                </div>}
              </div>

              <div className="automation-sun-footer">
                <div className="automation-sun-preview">
                  <span>设定预览：</span>
                  <strong>{formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, sunWeekdays)}</strong>
                </div>
                <button type="button" className="automation-sun-apply-btn" onClick={()=>{
                  const formatted = formatSunLabel(sunType, sunOffsetType, sunOffsetMinutes, sunWeekdays);
                  const detail = `日出日落环境变化 · ${sunType==="sunset"?"日落":"日出"}${sunOffsetType==="at"?"正当时":sunOffsetType==="before"?`前${sunOffsetMinutes}分钟`:`后${sunOffsetMinutes}分钟`}`;
                  const existingSun = triggerTemplates.find(t=>triggerCategory(t)==="sun");
                  if (existingSun) {
                    onUpdateTriggerTemplate(existingSun.key, { label: formatted, detail });
                    if (!selectedTemplate(draft, existingSun)) {
                      onToggleTriggerTemplate(existingSun);
                    }
                  } else {
                    const dynKey = `sun:${Date.now()}`;
                    const dynTemplate: TriggerTemplate = {
                      key: dynKey,
                      automationId: draft.sceneId || "custom-sun",
                      sourceIndex: 0,
                      kind: "weather",
                      label: formatted,
                      detail,
                    };
                    onUpdateTriggerTemplate(dynKey, dynTemplate);
                    onToggleTriggerTemplate(dynTemplate);
                  }
                  closeTriggerPicker();
                }}>＋ 保存并添加此条件</button>
              </div>

              {templatesForKind.length>0&&<div className="automation-capability-group" style={{marginTop:"14px",paddingTop:"14px",borderTop:"1px dashed #e2e8f0"}}>
                <strong>或快速选用已有模板</strong>
                <TriggerTemplatePicker templates={templatesForKind} draft={draft} onToggle={onToggleTriggerTemplate}/>
              </div>}
            </div>}

            {activeKind==="weather"&&<div className="automation-trigger-config automation-sun-builder">
              <div className="automation-config-title">
                <div>
                  <strong>天气与气温触发条件配置</strong>
                  <small>参考米家 App 支持室外气温变化、湿度与天气现象作为自动化触发点</small>
                </div>
              </div>

              <div className="automation-weather-subtabs">
                <button type="button" className={weatherSubTab==="temp"?"selected":""} onClick={()=>setWeatherSubTab("temp")}>🌡️ 室外气温</button>
                <button type="button" className={weatherSubTab==="humidity"?"selected":""} onClick={()=>setWeatherSubTab("humidity")}>💧 室外湿度</button>
                <button type="button" className={weatherSubTab==="weather"?"selected":""} onClick={()=>setWeatherSubTab("weather")}>⛅ 天气现象</button>
              </div>

              {weatherSubTab==="temp"&&<>
                <div className="automation-sun-field">
                  <span className="automation-sun-label">气温比较关系</span>
                  <div className="automation-sun-type-pills" role="radiogroup" aria-label="比较关系">
                    <button type="button" className={weatherTempOp==="低于"?"selected":""} onClick={()=>setWeatherTempOp("低于")}>❄️ 低于 (&lt;)</button>
                    <button type="button" className={weatherTempOp==="高于"?"selected":""} onClick={()=>setWeatherTempOp("高于")}>🔥 高于 (&gt;)</button>
                  </div>
                </div>

                <div className="automation-sun-field">
                  <span className="automation-sun-label">设定目标气温</span>
                  <div className="automation-temp-stepper">
                    <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherTempValue(Math.max(-30, weatherTempValue-1))}>－ 1℃</button>
                    <div className="automation-temp-input-wrap">
                      <input type="number" min={-30} max={60} value={weatherTempValue} onChange={e=>setWeatherTempValue(Math.max(-30, Math.min(60, Number(e.target.value)||0)))}/>
                      <span>℃</span>
                    </div>
                    <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherTempValue(Math.min(60, weatherTempValue+1))}>＋ 1℃</button>
                  </div>
                  <div className="automation-temp-presets">
                    {[10,15,20,26,28,30,35].map(deg=><button type="button" key={deg} className={weatherTempValue===deg?"selected":""} onClick={()=>setWeatherTempValue(deg)}>{deg}℃</button>)}
                  </div>
                </div>

                <div className="automation-sun-footer">
                  <div className="automation-sun-preview">
                    <span>设定预览：</span>
                    <strong>{formatTemperatureLabel(weatherTempOp, weatherTempValue)}</strong>
                  </div>
                  <button type="button" className="automation-temp-apply-btn" onClick={()=>{
                    const formatted = formatTemperatureLabel(weatherTempOp, weatherTempValue);
                    const detail = `环境气象 · ${formatted}`;
                    const existingWeather = triggerTemplates.find(t=>t.kind==="weather"&&/温度|气温/.test(t.label));
                    if (existingWeather) {
                      onUpdateTriggerTemplate(existingWeather.key, { label: formatted, detail });
                      if (!selectedTemplate(draft, existingWeather)) {
                        onToggleTriggerTemplate(existingWeather);
                      }
                    } else {
                      const dynKey = `weather:${Date.now()}`;
                      const dynTemplate: TriggerTemplate = {
                        key: dynKey,
                        automationId: draft.sceneId || "custom-weather",
                        sourceIndex: 0,
                        kind: "weather",
                        label: formatted,
                        detail,
                      };
                      onUpdateTriggerTemplate(dynKey, dynTemplate);
                      onToggleTriggerTemplate(dynTemplate);
                    }
                    closeTriggerPicker();
                  }}>＋ 保存并添加此条件</button>
                </div>
              </>}

              {weatherSubTab!=="temp"&&<div className="automation-weather-options" style={{marginTop:"8px"}}>
                {["室外天气是晴天","室外天气是下雨","室外天气是下雪","室外空气质量优良"].map(label=><button type="button" key={label} onClick={()=>{
                  const dynKey = `weather:${Date.now()}`;
                  const dynTemplate: TriggerTemplate = {
                    key: dynKey,
                    automationId: draft.sceneId || "custom-weather",
                    sourceIndex: 0,
                    kind: "weather",
                    label,
                    detail: "环境气象变化",
                  };
                  onUpdateTriggerTemplate(dynKey, dynTemplate);
                  onToggleTriggerTemplate(dynTemplate);
                  closeTriggerPicker();
                }}>☀ {label}</button>)}
              </div>}

              {templatesForKind.length>0&&<div className="automation-capability-group" style={{marginTop:"14px",paddingTop:"14px",borderTop:"1px dashed #e2e8f0"}}>
                <strong>或快速选用已有模板</strong>
                <TriggerTemplatePicker templates={templatesForKind} draft={draft} onToggle={onToggleTriggerTemplate}/>
              </div>}
            </div>}

            {activeKind!=="schedule"&&activeKind!=="device"&&activeKind!=="sun"&&activeKind!=="weather"&&<>
              <div className="automation-config-title">
                <div>
                  <strong>{triggerKinds.find(kind=>kind.kind===activeKind)?.label}</strong>
                  <small>来自当前家庭已有自动化的安全模板</small>
                </div>
              </div>
              {templatesForKind.length?<TriggerTemplatePicker templates={templatesForKind} draft={draft} onToggle={onToggleTriggerTemplate}/>:<div className="automation-readonly">
                <strong>暂无可配置条件</strong>
                <p>米家云尚未返回这个类别的可安全复用参数。</p>
              </div>}
            </>}
          </div>}
        </div>}
      </section>

      {/* 03 前置条件（AND / OR 关系与分类） */}
      <section className="automation-editor-section">
        <div className="automation-section-copy">
          <b>03</b>
          <div>
            <strong>前置条件</strong>
            <p>条件（and/or 关系）。在触发点发生后同时满足才执行动作。参考米家 App 支持设备状态、生效时间段、环境状态。</p>
          </div>
        </div>

        {/* 条件关系切换器 */}
        <div className="automation-trigger-mode" role="radiogroup" aria-label="前置条件关系">
          <button type="button" className={draft.conditionMode==="all"?"selected":""} aria-pressed={draft.conditionMode==="all"} onClick={()=>onUpdate({conditionMode:"all"})}>全部条件满足 (AND)</button>
          <button type="button" className={draft.conditionMode==="any"?"selected":""} aria-pressed={draft.conditionMode==="any"} onClick={()=>onUpdate({conditionMode:"any"})}>任一条件满足 (OR)</button>
        </div>

        {/* 已选条件列表 */}
        <div className="automation-selected-panel">
          <div className="automation-selected-heading">
            <div><strong>已选前置条件</strong><small>{draft.conditions.length} 个条件已配置</small></div>
          </div>
          {draft.conditions.length>0?<ol className="automation-selected-triggers">
            {draft.conditions.map(condition=>{
              const isEditing = editingConditionId === condition.id;
              const devCtx = resolveDeviceContext(condition, devices, visibleTriggerDevices);
              const isWeather = condition.kind === "weather" || /温度|气温|湿度|天气|空气/.test(condition.label);
              const tempInfo = parseTemperatureFromLabel(condition.label || "");
              const isDevice = !isWeather && condition.kind !== "time" && (condition.kind === "device" || Boolean(condition.deviceName && condition.deviceName !== "智能设备") || Boolean(devCtx.deviceName && devCtx.deviceName !== "智能设备"));
              const currentDevName = isEditing && editCondDraft.deviceName && editCondDraft.deviceName !== "智能设备"
                ? editCondDraft.deviceName
                : ((condition.deviceName && condition.deviceName !== "智能设备") ? condition.deviceName : devCtx.deviceName);
              const currentRoom = isEditing && editCondDraft.room && editCondDraft.room !== "未分配"
                ? editCondDraft.room
                : ((condition.room && condition.room !== "未分配") ? condition.room : devCtx.room);

              return <li className={`automation-selected-trigger${isEditing?" editing":""}`} key={condition.id}>
                <i>{condition.kind==="device"?"▣":condition.kind==="time"?"◷":"☀"}</i>
                <div className="automation-selected-info">
                  <div className="automation-selected-meta">
                    <span className={`automation-tag tag-${isDevice?"device":condition.kind==="time"?"time":"weather"}`}>
                      {isDevice?"设备状态":condition.kind==="time"?"生效时段":"环境气象"}
                    </span>
                    {currentRoom && currentRoom !== "未分配" && <span className="automation-room-tag">{currentRoom}</span>}
                    {currentDevName && currentDevName !== "智能设备" && <strong className="automation-dev-name">{currentDevName}</strong>}
                    {currentDevName && currentDevName !== "智能设备" && <span className="automation-sep">·</span>}
                    <strong className="automation-item-label">{condition.label}</strong>
                  </div>
                  <small className="automation-selected-sub">
                    {currentDevName && currentDevName !== "智能设备"
                      ? `设备：${currentDevName} | 状态判断：${condition.detail||condition.label}${currentRoom && currentRoom !== "未分配" ? ` | 房间：${currentRoom}` : ""}`
                      : condition.kind==="time"&&condition.timeRange
                        ? `时段：${condition.timeRange.start} ~ ${condition.timeRange.end} · 重复：${scheduleWeekdaysSummary(condition.weekdays||[1,2,3,4,5,6,7])}`
                        : (condition.detail || (currentRoom && currentRoom !== "未分配" ? `房间：${currentRoom}` : "已验证状态判断"))}
                  </small>
                  {isEditing&&<div className="automation-inline-editor">
                    {tempInfo.isTemp ? (
                      <div className="automation-temp-inline-editor">
                        <div className="automation-temp-builder">
                          <div className="automation-sun-field">
                            <span className="automation-sun-label">气温判断关系</span>
                            <div className="automation-sun-type-pills" role="radiogroup" aria-label="比较关系">
                              <button
                                type="button"
                                className={weatherTempOp === "低于" ? "selected" : ""}
                                onClick={() => {
                                  setWeatherTempOp("低于");
                                  const lbl = formatTemperatureLabel("低于", weatherTempValue);
                                  setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                }}
                              >
                                ❄️ 低于 (&lt;)
                              </button>
                              <button
                                type="button"
                                className={weatherTempOp === "高于" ? "selected" : ""}
                                onClick={() => {
                                  setWeatherTempOp("高于");
                                  const lbl = formatTemperatureLabel("高于", weatherTempValue);
                                  setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                }}
                              >
                                🔥 高于 (&gt;)
                              </button>
                            </div>
                          </div>

                          <div className="automation-sun-field">
                            <span className="automation-sun-label">设定目标气温</span>
                            <div className="automation-temp-stepper">
                              <button
                                type="button"
                                className="automation-stepper-btn"
                                onClick={() => {
                                  const val = Math.max(-30, weatherTempValue - 1);
                                  setWeatherTempValue(val);
                                  const lbl = formatTemperatureLabel(weatherTempOp, val);
                                  setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                }}
                              >
                                － 1℃
                              </button>
                              <div className="automation-temp-input-wrap">
                                <input
                                  type="number"
                                  min={-30}
                                  max={60}
                                  value={weatherTempValue}
                                  onChange={e => {
                                    const val = Math.max(-30, Math.min(60, Number(e.target.value) || 0));
                                    setWeatherTempValue(val);
                                    const lbl = formatTemperatureLabel(weatherTempOp, val);
                                    setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                  }}
                                />
                                <span>℃</span>
                              </div>
                              <button
                                type="button"
                                className="automation-stepper-btn"
                                onClick={() => {
                                  const val = Math.min(60, weatherTempValue + 1);
                                  setWeatherTempValue(val);
                                  const lbl = formatTemperatureLabel(weatherTempOp, val);
                                  setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                }}
                              >
                                ＋ 1℃
                              </button>
                            </div>

                            <div className="automation-temp-presets">
                              {[10, 15, 20, 26, 28, 30, 35].map(deg => (
                                <button
                                  type="button"
                                  key={deg}
                                  className={weatherTempValue === deg ? "selected" : ""}
                                  onClick={() => {
                                    setWeatherTempValue(deg);
                                    const lbl = formatTemperatureLabel(weatherTempOp, deg);
                                    setEditCondDraft(d => ({ ...d, label: lbl, detail: `气温条件 · ${lbl}` }));
                                  }}
                                >
                                  {deg}℃
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="automation-inline-field">
                            <span>当前设定预览</span>
                            <div className="automation-sun-preview-box">
                              <strong>🌡️ {editCondDraft.label || formatTemperatureLabel(weatherTempOp, weatherTempValue)}</strong>
                            </div>
                          </div>
                        </div>

                        <div className="automation-inline-actions">
                          <button
                            type="button"
                            className="automation-btn-save"
                            onClick={() => {
                              const finalLabel = editCondDraft.label || formatTemperatureLabel(weatherTempOp, weatherTempValue);
                              const finalDetail = `气温条件 · ${finalLabel}`;
                              onUpdateCondition(condition.id, { ...editCondDraft, label: finalLabel, detail: finalDetail });
                              setEditingConditionId(null);
                            }}
                          >
                            保存修改
                          </button>
                          <button type="button" className="automation-btn-cancel" onClick={() => setEditingConditionId(null)}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <label className="automation-inline-field">
                          <span>条件名称 / 状态描述</span>
                          <input type="text" value={editCondDraft.label||""} onChange={e=>setEditCondDraft({...editCondDraft,label:e.target.value})} placeholder="例如：卫生间镜柜灯带处于关闭"/>
                        </label>
                        {isDevice&&<div className="automation-inline-field">
                          <div className="automation-inline-dev">
                            <span>关联设备：<strong>{currentDevName && currentDevName !== "智能设备" ? currentDevName : "请选择智能设备"}</strong> {currentRoom && currentRoom !== "未分配" && currentDevName && currentDevName !== "智能设备" ? `(${currentRoom})` : ""}</span>
                            <button type="button" className="automation-switch-btn" onClick={()=>setShowCondDevPicker(!showCondDevPicker)}>{showCondDevPicker?"收起设备":"更换设备"}</button>
                          </div>
                          {showCondDevPicker&&<div className="automation-device-picker">
                            {visibleTriggerDevices.map(dev=><button type="button" key={dev.key} onClick={()=>{
                              setEditCondDraft({
                                ...editCondDraft,
                                deviceName: dev.deviceName,
                                room: dev.room,
                                did: dev.did,
                                detail: `${dev.deviceName} · 状态判断`,
                              });
                              setShowCondDevPicker(false);
                            }}>
                              <i>▣</i>
                              <span><strong>{dev.deviceName}</strong><small>{dev.room} · {dev.capabilities.length} 个条件可用</small></span>
                              <b>✓</b>
                            </button>)}
                          </div>}
                        </div>}
                        <label className="automation-inline-field">
                          <span>判断说明 / 期望值</span>
                          <input type="text" value={editCondDraft.detail||""} onChange={e=>setEditCondDraft({...editCondDraft,detail:e.target.value})} placeholder="例如：电源处于关闭 / 门磁闭合 / 温度低于26°C"/>
                        </label>
                        {isDevice&&<div className="automation-quick-presets">
                          <button type="button" onClick={()=>setEditCondDraft({...editCondDraft,label:"电源处于开启",detail:"电源开关开启"})}>电源开启</button>
                          <button type="button" onClick={()=>setEditCondDraft({...editCondDraft,label:"电源处于关闭",detail:"电源开关关闭"})}>电源关闭</button>
                          <button type="button" onClick={()=>setEditCondDraft({...editCondDraft,label:"门已关",detail:"门磁传感器闭合"})}>门已关</button>
                          <button type="button" onClick={()=>setEditCondDraft({...editCondDraft,label:"门已开",detail:"门磁传感器打开"})}>门已开</button>
                        </div>}
                        {condition.kind==="time"&&<div className="automation-time-picker-row">
                          <label><span>开始时间</span><input type="time" value={editCondDraft.timeRange?.start||"08:00"} onChange={e=>setEditCondDraft({...editCondDraft,timeRange:{start:e.target.value,end:editCondDraft.timeRange?.end||"22:00"}})}/></label>
                          <span>至</span>
                          <label><span>结束时间</span><input type="time" value={editCondDraft.timeRange?.end||"22:00"} onChange={e=>setEditCondDraft({...editCondDraft,timeRange:{start:editCondDraft.timeRange?.start||"08:00",end:e.target.value}})}/></label>
                        </div>}
                        <div className="automation-inline-actions">
                          <button type="button" className="automation-btn-save" onClick={()=>{
                            onUpdateCondition(condition.id, editCondDraft);
                            setEditingConditionId(null);
                          }}>保存修改</button>
                          <button type="button" className="automation-btn-cancel" onClick={()=>setEditingConditionId(null)}>取消</button>
                        </div>
                      </>
                    )}
                  </div>}
                </div>
                <div className="automation-selected-actions">
                  <button type="button" className="automation-btn-edit" onClick={()=>{
                    if(isEditing){
                      setEditingConditionId(null);
                    }else{
                      setEditingConditionId(condition.id);
                      const parsed = parseTemperatureFromLabel(condition.label || "");
                      if (parsed.isTemp) {
                        setWeatherTempOp(parsed.operator);
                        setWeatherTempValue(parsed.value);
                      }
                      setEditCondDraft({
                        ...condition,
                        deviceName: currentDevName !== "智能设备" ? currentDevName : condition.deviceName,
                        room: currentRoom !== "未分配" ? currentRoom : condition.room,
                        did: condition.did || devCtx.did,
                        timeRange: condition.timeRange?{...condition.timeRange}:{start:"08:00",end:"22:00"},
                        weekdays: condition.weekdays?[...condition.weekdays]:[1,2,3,4,5,6,7],
                      });
                      setShowCondDevPicker(false);
                    }
                  }}>{isEditing?"收起":"编辑"}</button>
                  <button type="button" onClick={()=>onRemoveCondition(condition.id)}>移除</button>
                </div>
              </li>;
            })}
          </ol>:<div className="automation-selected-empty">未设置额外前置条件（触发点成立后直接执行动作）。</div>}
        </div>

        {/* 添加前置条件分类面板 */}
        <div className="automation-category-box">
          <div className="automation-category-title"><strong>＋ 添加前置条件 (选择类别)</strong></div>
          <div className="automation-category-chips">
            <button type="button" className={conditionCategory==="device"?"selected":""} onClick={()=>{setConditionCategory(conditionCategory==="device"?"":"device");setCondDeviceKey("")}}>📱 智能设备状态</button>
            <button type="button" className={conditionCategory==="time"?"selected":""} onClick={()=>setConditionCategory(conditionCategory==="time"?"":"time")}>⏳ 时间条件 (生效时段)</button>
            <button type="button" className={conditionCategory==="weather"?"selected":""} onClick={()=>setConditionCategory(conditionCategory==="weather"?"":"weather")}>🌦️ 环境气象状态</button>
          </div>

          {conditionCategory==="device"&&<div className="automation-cat-content">
            <div className="automation-config-title">
              <div><strong>{condDeviceKey?"选择设备状态条件":"调用 IoT 接口选择智能设备"}</strong><small>筛选设备并配置当前状态判断</small></div>
              {condDeviceKey&&<button type="button" onClick={()=>setCondDeviceKey("")}>重新选设备</button>}
            </div>
            {!condDeviceKey?<div className="automation-device-picker">
              {visibleTriggerDevices.map(device=><button type="button" key={device.key} onClick={()=>setCondDeviceKey(device.key)}>
                <i>▣</i>
                <span><strong>{device.deviceName}</strong><small>{device.room} · {device.capabilities.length} 个条件可用</small></span>
                <b>›</b>
              </button>)}
            </div>:activeCondDevice&&<div className="automation-capability-group">
              <strong>{activeCondDevice.deviceName} 支持的状态判断</strong>
              <div className="automation-device-cond-list">
                <button type="button" onClick={()=>{onAddCondition({kind:"device",label:"电源处于开启",detail:"设备当前开启",deviceName:activeCondDevice.deviceName,room:activeCondDevice.room,did:activeCondDevice.did});setConditionCategory("")}}>⚡ 电源处于开启</button>
                <button type="button" onClick={()=>{onAddCondition({kind:"device",label:"电源处于关闭",detail:"设备当前关闭",deviceName:activeCondDevice.deviceName,room:activeCondDevice.room,did:activeCondDevice.did});setConditionCategory("")}}>🔌 电源处于关闭</button>
                {activeCondDevice.capabilities.map(cap=><button type="button" key={cap.key} onClick={()=>{onAddCondition({kind:"device",label:cap.label,detail:cap.detail,deviceName:activeCondDevice.deviceName,room:activeCondDevice.room,did:activeCondDevice.did});setConditionCategory("")}}>◈ {cap.label}</button>)}
              </div>
            </div>}
          </div>}

          {conditionCategory==="time"&&<div className="automation-cat-content">
            <div className="automation-time-picker-row">
              <label><span>开始时间</span><input type="time" value={condTimeStart} onChange={e=>setCondTimeStart(e.target.value)}/></label>
              <span>至</span>
              <label><span>结束时间</span><input type="time" value={condTimeEnd} onChange={e=>setCondTimeEnd(e.target.value)}/></label>
              <button type="button" className="primary-pill" onClick={()=>{onAddCondition({kind:"time",label:`处于 ${condTimeStart} ~ ${condTimeEnd} 之间`,timeRange:{start:condTimeStart,end:condTimeEnd}});setConditionCategory("")}}>加入时间条件</button>
            </div>
          </div>}

          {conditionCategory==="weather"&&<div className="automation-cat-content">
            <div className="automation-weather-subtabs">
              <button type="button" className={weatherSubTab==="temp"?"selected":""} onClick={()=>setWeatherSubTab("temp")}>🌡️ 室外气温</button>
              <button type="button" className={weatherSubTab==="humidity"?"selected":""} onClick={()=>setWeatherSubTab("humidity")}>💧 室外湿度</button>
              <button type="button" className={weatherSubTab==="weather"?"selected":""} onClick={()=>setWeatherSubTab("weather")}>⛅ 天气现象</button>
              <button type="button" className={weatherSubTab==="aqi"?"selected":""} onClick={()=>setWeatherSubTab("aqi")}>🍃 空气质量</button>
            </div>

            {weatherSubTab==="temp"&&<div className="automation-temp-builder">
              <div className="automation-sun-field">
                <span className="automation-sun-label">气温比较关系</span>
                <div className="automation-sun-type-pills" role="radiogroup" aria-label="比较关系">
                  <button type="button" className={weatherTempOp==="低于"?"selected":""} onClick={()=>setWeatherTempOp("低于")}>❄️ 低于 (&lt;)</button>
                  <button type="button" className={weatherTempOp==="高于"?"selected":""} onClick={()=>setWeatherTempOp("高于")}>🔥 高于 (&gt;)</button>
                </div>
              </div>

              <div className="automation-sun-field">
                <span className="automation-sun-label">设定目标气温</span>
                <div className="automation-temp-stepper">
                  <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherTempValue(Math.max(-30, weatherTempValue-1))}>－ 1℃</button>
                  <div className="automation-temp-input-wrap">
                    <input type="number" min={-30} max={60} value={weatherTempValue} onChange={e=>setWeatherTempValue(Math.max(-30, Math.min(60, Number(e.target.value)||0)))}/>
                    <span>℃</span>
                  </div>
                  <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherTempValue(Math.min(60, weatherTempValue+1))}>＋ 1℃</button>
                </div>
                <div className="automation-temp-presets">
                  {[10,15,20,26,28,30,35].map(deg=><button type="button" key={deg} className={weatherTempValue===deg?"selected":""} onClick={()=>setWeatherTempValue(deg)}>{deg}℃</button>)}
                </div>
              </div>

              <div className="automation-sun-footer">
                <div className="automation-sun-preview">
                  <span>设定预览：</span>
                  <strong>{formatTemperatureLabel(weatherTempOp, weatherTempValue)}</strong>
                </div>
                <button type="button" className="automation-temp-apply-btn" onClick={()=>{
                  const lbl = formatTemperatureLabel(weatherTempOp, weatherTempValue);
                  onAddCondition({ kind: "weather", label: lbl, detail: `气温条件 · ${lbl}` });
                  setConditionCategory("");
                }}>＋ 添加气温条件</button>
              </div>
            </div>}

            {weatherSubTab==="humidity"&&<div className="automation-temp-builder">
              <div className="automation-sun-field">
                <span className="automation-sun-label">湿度比较关系</span>
                <div className="automation-sun-type-pills" role="radiogroup" aria-label="比较关系">
                  <button type="button" className={weatherHumidOp==="低于"?"selected":""} onClick={()=>setWeatherHumidOp("低于")}>干燥 低于 (&lt;)</button>
                  <button type="button" className={weatherHumidOp==="高于"?"selected":""} onClick={()=>setWeatherHumidOp("高于")}>潮湿 高于 (&gt;)</button>
                </div>
              </div>

              <div className="automation-sun-field">
                <span className="automation-sun-label">设定目标湿度</span>
                <div className="automation-temp-stepper">
                  <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherHumidValue(Math.max(10, weatherHumidValue-5))}>－ 5%</button>
                  <div className="automation-temp-input-wrap">
                    <input type="number" min={10} max={100} value={weatherHumidValue} onChange={e=>setWeatherHumidValue(Math.max(10, Math.min(100, Number(e.target.value)||50)))}/>
                    <span>%</span>
                  </div>
                  <button type="button" className="automation-stepper-btn" onClick={()=>setWeatherHumidValue(Math.min(100, weatherHumidValue+5))}>＋ 5%</button>
                </div>
                <div className="automation-temp-presets">
                  {[30,40,50,60,70,80].map(h=><button type="button" key={h} className={weatherHumidValue===h?"selected":""} onClick={()=>setWeatherHumidValue(h)}>{h}%</button>)}
                </div>
              </div>

              <div className="automation-sun-footer">
                <div className="automation-sun-preview">
                  <span>设定预览：</span>
                  <strong>室外湿度${weatherHumidOp}${weatherHumidValue}%</strong>
                </div>
                <button type="button" className="automation-temp-apply-btn" onClick={()=>{
                  const lbl = `室外湿度${weatherHumidOp}${weatherHumidValue}%`;
                  onAddCondition({ kind: "weather", label: lbl, detail: `环境湿度 · ${lbl}` });
                  setConditionCategory("");
                }}>＋ 添加湿度条件</button>
              </div>
            </div>}

            {weatherSubTab==="weather"&&<div className="automation-temp-builder">
              <div className="automation-sun-field">
                <span className="automation-sun-label">选择天气现象</span>
                <div className="automation-weather-options">
                  {["室外天气是晴天","室外天气是多云","室外天气是阴天","室外天气是下雨","室外天气是下雪"].map(label=><button type="button" key={label} onClick={()=>{onAddCondition({kind:"weather",label,detail:`天气现象 · ${label}`});setConditionCategory("")}}>⛅ {label}</button>)}
                </div>
              </div>
            </div>}

            {weatherSubTab==="aqi"&&<div className="automation-temp-builder">
              <div className="automation-sun-field">
                <span className="automation-sun-label">选择空气质量</span>
                <div className="automation-weather-options">
                  {["室外空气质量优","室外空气质量良","室外空气轻度污染","室外空气中度污染"].map(label=><button type="button" key={label} onClick={()=>{onAddCondition({kind:"weather",label,detail:`空气质量 · ${label}`});setConditionCategory("")}}>🍃 {label}</button>)}
                </div>
              </div>
            </div>}

            <div className="automation-weather-quick-note" style={{marginTop:"10px",paddingTop:"10px",borderTop:"1px dashed #e2e8f0"}}>
              <small style={{color:"var(--muted)",fontSize:"8px"}}>常用快捷选项：</small>
              <div className="automation-weather-options" style={{marginTop:"6px"}}>
                {["室外天气是晴天","室外天气是下雨","室外温度高于 28°C","室外温度低于 15°C","室外空气质量优良"].map(label=><button type="button" key={label} onClick={()=>{onAddCondition({kind:"weather",label,detail:`环境状态 · ${label}`});setConditionCategory("")}}>☀ {label}</button>)}
              </div>
            </div>
          </div>}
        </div>
      </section>

      {/* 04 执行动作（条件为 True 执行的动作） */}
      <section className="automation-editor-section">
        <div className="automation-section-copy">
          <b>04</b>
          <div>
            <strong>执行动作</strong>
            <p>条件为 true 执行的动作（按顺序执行）。只提供规格明确公开的安全设置。</p>
          </div>
        </div>

        <div className="automation-action-list">
          {draft.actions.map((action,index)=><div key={action.clientId} className={action.kind==="unsupported"?"readonly":""}>
            <b>{index+1}</b>
            <div>
              <strong>{action.deviceName||action.label}</strong>
              <small>{actionPropertySummary(action,actionCatalog)}</small>
              {action.kind==="set-properties"&&action.properties?.[0]&&<SimpleValue action={action} catalog={actionCatalog} index={index} onChange={(i,v)=>onPropertyValue(i,v,false)}/>}
            </div>
            {draft.actionsEditable&&<div className="automation-action-tools">
              <button type="button" disabled={index===0} onClick={()=>onMoveAction(index,-1,false)}>↑</button>
              <button type="button" disabled={index===draft.actions.length-1} onClick={()=>onMoveAction(index,1,false)}>↓</button>
              <button aria-label={`删除动作 ${index+1}：${action.deviceName||action.label}，${actionPropertySummary(action,actionCatalog)}`} onClick={()=>onRemoveAction(index)}>删除</button>
            </div>}
          </div>)}
        </div>

        {draft.actionsEditable&&<div className="automation-category-box">
          <div className="automation-category-title">
            <strong>＋ 添加满足条件时执行的动作 (选择类别)</strong>
            <button type="button" className="refresh-iot-btn" onClick={onFetchCatalog} disabled={catalogLoading}>
              {catalogLoading?"正在调用 IoT 接口...":"🔄 调用 IoT 接口刷新设备与动作"}
            </button>
          </div>
          <div className="automation-category-chips">
            <button type="button" className={actionCategory==="device"||!actionCategory?"selected":""} onClick={()=>setActionCategory("device")}>📱 智能设备控制</button>
            <button type="button" className={actionCategory==="delay"?"selected":""} onClick={()=>setActionCategory("delay")}>⏱️ 延时执行</button>
            <button type="button" className={actionCategory==="notice"?"selected":""} onClick={()=>setActionCategory("notice")}>🔔 发送通知</button>
          </div>

          {actionCategory==="delay"&&<div className="automation-time-picker-row">
            <label><span>延时秒数</span><input type="number" min={1} max={3600} value={delaySeconds} onChange={e=>setDelaySeconds(Number(e.target.value))}/></label>
            <button type="button" className="primary-pill" onClick={()=>{
              onUpdate({ actions:[...draft.actions, { clientId:`delay-${Date.now()}`, kind:"set-properties", did:"delay", model:"timer", label:`延时 ${delaySeconds} 秒`, deviceName:"自动化延时", properties:[{ siid:1, piid:1, value:delaySeconds }] }] });
            }}>加入延时</button>
          </div>}

          {actionCategory==="notice"&&<div className="automation-time-picker-row">
            <label><span>通知消息内容</span><input type="text" value={noticeText} onChange={e=>setNoticeText(e.target.value)}/></label>
            <button type="button" className="primary-pill" onClick={()=>{
              onUpdate({ actions:[...draft.actions, { clientId:`notice-${Date.now()}`, kind:"set-properties", did:"notice", model:"notice", label:`推送通知：${noticeText}`, deviceName:"米家消息推送", properties:[{ siid:1, piid:1, value:noticeText }] }] });
            }}>加入通知</button>
          </div>}

          {(actionCategory==="device"||!actionCategory)&&<div className="automation-add-action">
            <select aria-label="筛选动作房间" value={actionRoom} onChange={event=>onActionRoom(event.target.value)}>
              <option value="">全部房间</option>
              {rooms.map(room=><option value={room} key={room}>{room}</option>)}
            </select>
            <select aria-label="选择设备动作" value={actionKey} onChange={event=>onActionKey(event.target.value)}>
              <option value="">选择设备和设置</option>
              {actionOptions.map(option=><option value={option.key} key={option.key}>{option.room} · {option.deviceName} · {option.label}</option>)}
            </select>
            <button type="button" disabled={!actionKey} onClick={onAddAction}>加入动作</button>
          </div>}
        </div>}
      </section>

      {/* 05 条件为 False 时候的动作 (Else 分支) */}
      <section className="automation-editor-section automation-else-section">
        <div className="automation-section-copy">
          <b>05</b>
          <div>
            <strong>不满足条件执行的动作</strong>
            <p>条件为 false 时候的动作（否则执行）。当上述前置条件不满足时执行该分支动作，若无需备用动作可留空。</p>
          </div>
        </div>

        <div className="automation-action-list">
          {draft.falseActions.map((action,index)=><div key={action.clientId} className="false-action-row">
            <b className="false-badge">{index+1}</b>
            <div>
              <strong>{action.deviceName||action.label}</strong>
              <small>{actionPropertySummary(action,actionCatalog) || (action.kind === "unsupported" ? action.reason : action.label)}</small>
              {action.kind==="set-properties"&&action.properties?.[0]&&<SimpleValue action={action} catalog={actionCatalog} index={index} onChange={(i,v)=>onPropertyValue(i,v,true)}/>}
            </div>
            {draft.actionsEditable&&<div className="automation-action-tools">
              <button type="button" disabled={index===0} onClick={()=>onMoveAction(index,-1,true)}>↑</button>
              <button type="button" disabled={index===draft.falseActions.length-1} onClick={()=>onMoveAction(index,1,true)}>↓</button>
              <button aria-label={`删除否则动作 ${index+1}`} onClick={()=>onRemoveFalseAction(index)}>删除</button>
            </div>}
          </div>)}
        </div>

        {draft.falseActions.length===0&&<div className="automation-else-empty">当前未配置 False 动作（条件不满足时不执行任何操作）。可通过下方选择添加备用动作。</div>}

        {draft.actionsEditable&&<div className="automation-category-box">
          <div className="automation-category-title"><strong>＋ 为 Else 分支添加动作</strong></div>
          <div className="automation-add-action">
            <select aria-label="筛选房间" value={actionRoom} onChange={event=>onActionRoom(event.target.value)}>
              <option value="">全部房间</option>
              {rooms.map(room=><option value={room} key={room}>{room}</option>)}
            </select>
            <select aria-label="选择设备动作" value={actionKey} onChange={event=>onActionKey(event.target.value)}>
              <option value="">选择设备和设置</option>
              {actionOptions.map(option=><option value={option.key} key={option.key}>{option.room} · {option.deviceName} · {option.label}</option>)}
            </select>
            <button type="button" disabled={!actionKey} onClick={()=>{const opt=actionOptions.find(o=>o.key===actionKey);if(opt)onAddCustomAction(true,opt)}}>加入 Else 动作</button>
          </div>
        </div>}
      </section>

      {/* 06 生效日期与其他条件 */}
      <section className="automation-editor-section">
        <div className="automation-section-copy">
          <b>06</b>
          <div>
            <strong>生效日期</strong>
            <p>其他条件（时间条件）：设置规则的生效时段与重复星期。</p>
          </div>
        </div>

        <div className="automation-effective-controls">
          <div className="automation-trigger-mode">
            <button type="button" className={draft.effectiveTime.type==="all-day"?"selected":""} onClick={()=>onUpdate({effectiveTime:{...draft.effectiveTime,type:"all-day"}})}>全天生效</button>
            <button type="button" className={draft.effectiveTime.type==="custom"?"selected":""} onClick={()=>onUpdate({effectiveTime:{...draft.effectiveTime,type:"custom",start:draft.effectiveTime.start||"08:00",end:draft.effectiveTime.end||"22:00"}})}>自定义生效时段</button>
          </div>

          {draft.effectiveTime.type==="custom"&&<div className="automation-time-picker-row">
            <label><span>开始时段</span><input type="time" value={draft.effectiveTime.start||"08:00"} onChange={e=>onUpdate({effectiveTime:{...draft.effectiveTime,start:e.target.value}})}/></label>
            <span>至</span>
            <label><span>结束时段</span><input type="time" value={draft.effectiveTime.end||"22:00"} onChange={e=>onUpdate({effectiveTime:{...draft.effectiveTime,end:e.target.value}})}/></label>
          </div>}

          <div className="automation-weekdays">
            {["一","二","三","四","五","六","日"].map((label,index)=><button type="button" className={draft.effectiveTime.weekdays.includes(index+1)?"selected":""} aria-pressed={draft.effectiveTime.weekdays.includes(index+1)} onClick={()=>onToggleEffectiveDay(index+1)} key={label}>周{label}</button>)}
          </div>
        </div>

        {draft.schedule?<div className="automation-schedule-sync-note">
          <strong>指定时间触发点已设置：{draft.schedule.time}</strong>
          <small>指定时间触发点将在所选星期准时发生：</small>
          <div className="automation-weekdays">
            {["一","二","三","四","五","六","日"].map((label,index)=><button type="button" className={draft.schedule!.weekdays.includes(index+1)?"selected":""} aria-pressed={draft.schedule!.weekdays.includes(index+1)} onClick={()=>onToggleDay(index+1)} key={label}>周{label}</button>)}
          </div>
        </div>:<div className="automation-date-empty">
          <span>不使用指定时间</span>
          <small>设备、天气和位置条件会沿用其米家原始参数，并在上述生效日期内工作。</small>
        </div>}
      </section>

      {error&&<div className="automation-state error" role="alert">{friendlyError(error)}</div>}
    </div>

    <footer>
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={!draftReady(draft)} onClick={onReview}>下一步：检查</button>
    </footer>
  </section>;
}

function TriggerTemplatePicker({templates,draft,onToggle}:{templates:TriggerTemplate[];draft:EditorState;onToggle:(template:TriggerTemplate)=>void}){
  return <div className="automation-trigger-templates">
    {templates.map(template=>{
      const selected=selectedTemplate(draft,template);
      return <button type="button" key={template.key} className={selected?"selected":""} aria-pressed={selected} onClick={()=>onToggle(template)}>
        <span>{template.label}</span>
        {template.detail&&<small>{template.detail}</small>}
        <b>{selected?"✓":"＋"}</b>
      </button>;
    })}
  </div>;
}

function AutomationReview({draft,templates,devices=[],actionCatalog,saving,error,onBack,onCancel,onSave}:{draft:EditorState;templates:TriggerTemplate[];devices?:ManagedDevice[];actionCatalog:CatalogPropertyDescription[];saving:boolean;error:string;onBack:()=>void;onCancel:()=>void;onSave:()=>void}){
  const selected=templates.filter(template=>selectedTemplate(draft,template));
  const triggers=[
    ...(draft.schedule?[scheduleLabel(draft.schedule)]:[]),
    ...selected.map(template=>{
      const devCtx = resolveDeviceContext(template, devices);
      const devName = template.deviceName && template.deviceName !== "智能设备" ? template.deviceName : devCtx.deviceName !== "智能设备" ? devCtx.deviceName : undefined;
      return `${devName?`${devName} · `:""}${template.label}`;
    })
  ];
  const conditions=draft.conditions.map(c=>{
    const devCtx = resolveDeviceContext(c, devices);
    const devName = c.deviceName && c.deviceName !== "智能设备" ? c.deviceName : devCtx.deviceName !== "智能设备" ? devCtx.deviceName : undefined;
    return `${devName?`${devName} · `:""}${c.label}`;
  });

  return <section className="automation-editor automation-review-page" aria-label="检查自动化">
    <header>
      <button onClick={onBack}>← 返回编辑</button>
      <div><span>REVIEW</span><h2>检查自动化</h2></div>
    </header>
    <div className="automation-editor-body">
      <div className="automation-review-heading">
        <span>✓</span>
        <div>
          <h3>{draft.name}</h3>
          <p>{draft.enabled?"保存后启用":"保存后保持停用"} · {effectiveTimeLabel(draft.effectiveTime)}</p>
        </div>
      </div>

      <div className="automation-review-flow">
        {/* 触发点 */}
        <section>
          <header>
            <b>IF</b>
            <div>
              <strong>{draft.triggerMode==="all"?"全部触发点满足 (AND)":"任一触发点满足 (OR)"}</strong>
              <small>{triggers.length} 个触发点</small>
            </div>
          </header>
          {triggers.map((trigger,index)=><div className="automation-review-row" key={`${trigger}:${index}`}>
            <i>{index+1}</i>
            <strong>{trigger}</strong>
          </div>)}
        </section>

        {/* 条件 */}
        <section>
          <header>
            <b className="condition-span">WHEN</b>
            <div>
              <strong>{draft.conditionMode==="any"?"任一条件满足 (OR)":"全部条件满足 (AND)"}</strong>
              <small>{conditions.length?`${conditions.length} 个前置条件`:"无额外条件"}</small>
            </div>
          </header>
          {conditions.length>0?conditions.map((condition,index)=><div className="automation-review-row" key={`${condition}:${index}`}>
            <i>{index+1}</i>
            <strong>{condition}</strong>
          </div>):<div className="automation-review-empty">触发后立即执行动作</div>}
        </section>

        {/* True 动作 */}
        <section>
          <header>
            <b className="true-span">THEN</b>
            <div>
              <strong>满足条件执行 (True 分支)</strong>
              <small>{draft.actions.length} 个动作</small>
            </div>
          </header>
          {draft.actions.map((action,index)=><div className="automation-review-row" key={action.clientId}>
            <i>{index+1}</i>
            <div>
              <strong>{action.deviceName||action.label}</strong>
              <small>{actionPropertySummary(action,actionCatalog,true)}</small>
            </div>
          </div>)}
        </section>

        {/* False 动作 */}
        {draft.falseActions.length>0&&<section>
          <header>
            <b className="false-span">ELSE</b>
            <div>
              <strong>不满足条件执行 (False 分支)</strong>
              <small>{draft.falseActions.length} 个动作</small>
            </div>
          </header>
          {draft.falseActions.map((action,index)=><div className="automation-review-row" key={action.clientId}>
            <i>{index+1}</i>
            <div>
              <strong>{action.deviceName||action.label}</strong>
              <small>{actionPropertySummary(action,actionCatalog,true)}</small>
            </div>
          </div>)}
        </section>}
      </div>

      <div className="automation-save-note">提交后会从米家云重新读取；只有名称、条件与动作回读一致才会报告成功。</div>
      {error&&<div className="automation-state error" role="alert">{friendlyError(error)}</div>}
    </div>
    <footer>
      <button onClick={onCancel}>取消</button>
      <button className="primary" disabled={saving} onClick={onSave}>{saving?"正在保存并回读…":draft.sceneId?"确认保存修改":"确认创建自动化"}</button>
    </footer>
  </section>;
}

function SimpleValue({action,catalog,index,onChange}:{action:SceneDraftAction;catalog:CatalogPropertyDescription[];index:number;onChange:(index:number,value:SceneValue)=>void}){
  const property=action.properties?.[0];
  if(!property)return null;
  const display=automationPropertyDisplay(action,property,catalog),choices=display.descriptor?.choices;
  if(display.descriptor?.editable===false)return <span className="automation-value-readonly">当前值：{display.valueLabel}</span>;
  if(choices?.length)return <select aria-label={`设置${action.deviceName||action.label}的${display.label}`} className="automation-value-input" value={choiceKey(property.value)} onChange={event=>{const choice=choices.find(item=>choiceKey(item.value)===event.target.value);if(choice)onChange(index,choice.value)}}>{choices.map(choice=><option value={choiceKey(choice.value)} key={choiceKey(choice.value)}>{choice.label}</option>)}</select>;
  if(typeof property.value==="boolean")return <button type="button" aria-label={`设置${action.deviceName||action.label}的${display.label}，当前为${display.valueLabel}`} className={`automation-value-switch ${property.value?"on":""}`} onClick={()=>onChange(index,!property.value)}>{display.valueLabel}</button>;
  return <input aria-label={`设置${action.deviceName||action.label}的${display.label}`} className="automation-value-input" type={display.descriptor?.range?"number":"text"} min={display.descriptor?.range?.min} max={display.descriptor?.range?.max} step={display.descriptor?.range?.step} value={String(property.value)} onChange={event=>onChange(index,typeof property.value==="number"?Number(event.target.value):event.target.value)}/>;
}
