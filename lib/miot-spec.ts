type MiotRawValue = { value: number | string | boolean; description?: string };
type MiotRawProperty = { iid: number; type: string; description?: string; format?: string; access?: string[]; unit?: string; "value-list"?: MiotRawValue[]; "value-range"?: number[] };
type MiotRawAction = { iid: number; type: string; description?: string; in?: number[]; out?: number[] };
type MiotRawEvent = { iid: number; type: string; description?: string; arguments?: number[] };
type MiotRawService = { iid: number; type: string; description?: string; properties?: MiotRawProperty[]; actions?: MiotRawAction[]; events?: MiotRawEvent[] };
type MiotRawSpec = { type: string; description?: string; services?: MiotRawService[] };
type MiotInstance = { model?: string; type?: string; version?: number; status?: string };

export type MiotCapabilityProperty = { key: string; name: string; label: string; siid: number; piid: number; format: string; readable: boolean; writable: boolean; notify: boolean; unit?: string; choices?: Array<{ value: number | string | boolean; label: string }>; range?: { min: number; max: number; step: number } };
export type MiotCapabilityAction = { key: string; name: string; label: string; siid: number; aiid: number; inputs: number[] };
export type MiotCapabilityEvent = { key: string; name: string; label: string; siid: number; eiid: number; arguments: number[] };
export type MiotCapabilityGroup = { key: string; name: string; label: string; siid: number; properties: MiotCapabilityProperty[]; actions: MiotCapabilityAction[]; events: MiotCapabilityEvent[] };

const labels: Record<string, string> = {
  switch: "按键", "switch-sensor": "按键事件", "switch-panel": "按键绑定", "switch-relay": "按键负载映射",
  on: "开关", mode: "工作模式", "wireless-mode": "无线开关模式", "wireless-enable": "无线开关模式",
  "button-mode": "按键模式", "button-type": "按键类型", "default-state": "通电默认状态",
  "power-on-state": "通电默认状态", "power-on-behavior": "通电默认状态", "backlight-mode": "指示灯模式",
  "indicator-light": "指示灯", "indicator-light-on": "指示灯开关", "physical-controls-locked": "童锁",
  "child-lock": "童锁", "mutual-control": "本地双控与解绑", "bound-keys": "已绑定按键",
  "target-did": "目标设备 ID", "target-device": "目标设备", "target-device-id": "目标设备 ID",
  "target-channel": "目标回路", "target-siid": "目标服务", "source-key": "来源按键",
  "bind-device": "绑定设备", "add-binding": "新增绑定", "remove-binding": "解除绑定",
  "max-key-count": "最大绑定按键数", "current-key": "当前操作按键", "pressed-key": "被按下的按键",
  "enter-learn-mode": "进入绑定学习模式", "exit-learn-mode": "退出绑定学习模式", "delete-key": "删除绑定按键",
  "panel-add-enable": "允许按键绑定", "jog-enable": "点动模式", "jog-delay-time": "点动延时",
  "flexible-mode": "在线点动模式", "flexible-time": "在线点动延时", "single-click": "单击",
  "double-click": "双击", "long-press": "长按", "key-pressed": "按键按下", toggle: "切换开关状态",
  brightness: "亮度", "color-temperature": "色温", "target-temperature": "目标温度", "target-humidity": "目标湿度",
  "fan-level": "风速档位", "horizontal-swing": "左右摇头", "start-sweep": "开始清扫", "stop-sweeping": "停止清扫",
  "start-charge": "返回充电", "motor-control": "电机控制", "target-position": "目标位置", status: "运行状态",
  "battery-level": "电池电量", "electric-power": "功率", "power-consumption": "用电量", light: "灯光",
  "air-conditioner": "空调", fan: "风扇", vacuum: "扫拖机器人", humidifier: "加湿器", outlet: "插座",
};

const origins = ["https://miot-spec.org", "https://spec.miot-spec.com"];
const instanceCache = new Map<string, string>();
const specCache = new Map<string, { value: MiotRawSpec; expiresAt: number }>();
let instanceIndex: Promise<void> | undefined;

function typeName(type: string) { return type.split(":")[3] ?? type; }
function translatedName(name: string, fallback?: string) {
  if (labels[name]) return labels[name];
  const base = name.replace(/[-_](?:i{1,4}|[a-d]|\d+)$/i, "");
  if (labels[base]) return labels[base];
  return fallback || name.replace(/-/g, " ");
}

async function fetchSpecJson(path: string): Promise<Record<string, unknown>> {
  let failure: Error | undefined;
  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) { failure = new Error(`MIOT_SPEC_HTTP_${response.status}`); continue; }
      const data = await response.json();
      if (!data || typeof data !== "object") throw new Error("MIOT_SPEC_RESPONSE_INVALID");
      return data as Record<string, unknown>;
    } catch (error) { failure = error instanceof Error ? error : new Error("MIOT_SPEC_UNAVAILABLE"); }
  }
  throw failure ?? new Error("MIOT_SPEC_UNAVAILABLE");
}

async function resolveUrn(model: string) {
  if (instanceCache.has(model)) return instanceCache.get(model)!;
  if (!instanceIndex) {
    instanceIndex = (async () => {
      const result = await fetchSpecJson("/miot-spec-v2/instances?status=all");
      const instances = (result.instances ?? []) as MiotInstance[];
      const versions = new Map<string, number>();
      for (const instance of instances) {
        if (!instance.model || !instance.type) continue;
        const current = versions.get(instance.model) ?? -1;
        const version = Number(instance.version ?? 0);
        if (!instanceCache.has(instance.model) || version >= current) { instanceCache.set(instance.model, instance.type); versions.set(instance.model, version); }
      }
    })().catch(error => { instanceIndex = undefined; throw error; });
  }
  await instanceIndex;
  const urn = instanceCache.get(model);
  if (!urn) throw new Error("MIOT_SPEC_MODEL_NOT_FOUND");
  return urn;
}

export async function getMiotCapabilities(model: string, providedUrn?: string) {
  if (!/^[\w.-]{2,120}$/.test(model)) throw new Error("INVALID_DEVICE_MODEL");
  const urn = providedUrn?.startsWith("urn:") ? providedUrn : await resolveUrn(model);
  const cache = specCache.get(urn);
  let spec: MiotRawSpec;
  if (cache && cache.expiresAt > Date.now()) spec = cache.value;
  else {
    spec = await fetchSpecJson(`/miot-spec-v2/instance?type=${encodeURIComponent(urn)}`) as unknown as MiotRawSpec;
    if (!Array.isArray(spec.services)) throw new Error("MIOT_SPEC_RESPONSE_INVALID");
    specCache.set(urn, { value: spec, expiresAt: Date.now() + 30 * 60 * 1000 });
  }

  return normalizeMiotSpecification(model, urn, spec);
}

export function normalizeMiotSpecification(model: string, urn: string, spec: MiotRawSpec) {
  const sameServiceCount = new Map<string, number>();
  const groups: MiotCapabilityGroup[] = [];
  for (const service of spec.services ?? []) {
    const name = typeName(service.type);
    if (name === "device-information") continue;
    const index = (sameServiceCount.get(name) ?? 0) + 1;
    sameServiceCount.set(name, index);
    const properties: MiotCapabilityProperty[] = (service.properties ?? []).map(property => {
      const propertyName = typeName(property.type);
      const access = property.access ?? [];
      const valueRange = property["value-range"];
      return {
        key: `${service.iid}.${property.iid}`, name: propertyName, label: translatedName(propertyName, property.description),
        siid: service.iid, piid: property.iid, format: property.format ?? "string", readable: access.includes("read"), writable: access.includes("write"), notify: access.includes("notify"),
        ...(property.unit && property.unit !== "none" ? { unit: property.unit } : {}),
        ...(property["value-list"]?.length ? { choices: property["value-list"].map(item => ({ value: item.value, label: translatedName(String(item.description ?? item.value), String(item.description ?? item.value)) })) } : {}),
        ...(valueRange?.length && Number.isFinite(valueRange[0]) && Number.isFinite(valueRange[1]) ? { range: { min: valueRange[0], max: valueRange[1], step: valueRange[2] || 1 } } : {}),
      };
    });
    const actions: MiotCapabilityAction[] = (service.actions ?? []).map(action => ({ key: `${service.iid}.a${action.iid}`, name: typeName(action.type), label: translatedName(typeName(action.type), action.description), siid: service.iid, aiid: action.iid, inputs: action.in ?? [] }));
    const events: MiotCapabilityEvent[] = (service.events ?? []).map(event => ({ key: `${service.iid}.e${event.iid}`, name: typeName(event.type), label: translatedName(typeName(event.type), event.description), siid: service.iid, eiid: event.iid, arguments: event.arguments ?? [] }));
    if (!properties.length && !actions.length && !events.length) continue;
    const groupLabel = translatedName(name, service.description);
    groups.push({ key: String(service.iid), name, label: name === "switch" ? `按键 ${index}` : index > 1 ? `${groupLabel} ${index}` : groupLabel, siid: service.iid, properties, actions, events });
  }
  return { model, urn, description: spec.description ?? model, groups };
}
