import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";
import { parseDerivedDeviceId } from "./device-topology.ts";
import {
  parsedSceneRecord,
  parseManualScenes,
  type ManualSceneAction,
  type XiaomiRequester,
  type XiaomiSceneRecord,
} from "./xiaomi-scenes.ts";

export type AutomationTrigger = {
  kind: "schedule" | "device" | "location" | "weather" | "unknown";
  label: string;
  detail?: string;
  editable: boolean;
  time?: string;
  weekdays?: number[];
};

export type XiaomiAutomation = {
  id: string;
  homeId: string;
  name: string;
  enabled: boolean;
  triggerMode: "all" | "any";
  triggers: AutomationTrigger[];
  actions: ManualSceneAction[];
  actionCount: number;
  updatedAt?: string;
};

export type AutomationTriggerTemplate = {
  key: string;
  automationId: string;
  sourceIndex: number;
  kind: AutomationTrigger["kind"];
  label: string;
  detail?: string;
  deviceKey?: string;
  deviceName?: string;
  room?: string;
};

export const AUTOMATION_LIST_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList";

function record(value: unknown): XiaomiSceneRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XiaomiSceneRecord : undefined;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function sceneEntries(response: XiaomiSceneRecord) {
  const result = response.result;
  if (result === null) return [];
  if (Array.isArray(result)) return result.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
  const container = record(result);
  if (!container) throw new Error("XIAOMI_AUTOMATION_RESPONSE_INVALID");
  for (const candidate of [container.scene_info_list, container.scene_list, container.list, container.scenes]) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
  }
  throw new Error("XIAOMI_AUTOMATION_RESPONSE_INVALID");
}

export function rawAutomationTriggers(scene: XiaomiSceneRecord) {
  const trigger = parsedSceneRecord(scene.scene_trigger ?? scene.trigger);
  const values = Array.isArray(trigger?.triggers) ? trigger.triggers : Array.isArray(scene.triggers) ? scene.triggers : [];
  return values.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
}

export function isAutomationRecord(scene: XiaomiSceneRecord) {
  const triggers = rawAutomationTriggers(scene);
  return triggers.length > 0 && !triggers.some(trigger => text(trigger.src).toLowerCase() === "user" || text(trigger.key).toLowerCase() === "user.click");
}

function clock(value: unknown) {
  const source = text(value);
  const match = source.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

function scheduleDetails(trigger: XiaomiSceneRecord) {
  const payload = parsedSceneRecord(trigger.payload_json ?? trigger.payload ?? trigger.setting);
  const timer = record(payload?.timer) ?? payload;
  const hour = Number(timer?.hour);
  const minute = Number(timer?.minute);
  const time = clock(timer?.time ?? timer?.cron ?? timer?.expression ?? trigger.name)
    ?? (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : undefined);
  const rawDays = timer?.weekdays ?? timer?.days ?? timer?.repeat;
  const weekdays = Array.isArray(rawDays)
    ? rawDays.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
    : undefined;
  return { time, weekdays };
}

export function parseAutomationTrigger(trigger: XiaomiSceneRecord): AutomationTrigger {
  const src = text(trigger.src).toLowerCase();
  const key = text(trigger.key).toLowerCase();
  const name = text(trigger.name ?? trigger.trigger_name);
  if (/timer|time|schedule/.test(`${src} ${key}`)) {
    const { time, weekdays } = scheduleDetails(trigger);
    const repeat = weekdays?.length && weekdays.length < 7 ? weekdays.map(day => "一二三四五六日"[day - 1]).join("、") : "每天";
    return { kind: "schedule", label: time ? `${repeat} ${time}` : name || "定时触发", ...(time ? { time } : {}), ...(weekdays?.length ? { weekdays } : {}), editable: Boolean(time) };
  }
  const payload = parsedSceneRecord(trigger.payload_json ?? trigger.payload);
  const deviceName = text(payload?.device_name ?? trigger.device_name);
  if (/device|miot|sensor|event|property/.test(`${src} ${key}`) || deviceName) return { kind: "device", label: name || deviceName || "设备状态变化", ...(deviceName && name ? { detail: deviceName } : {}), editable: false };
  if (/location|geofence/.test(`${src} ${key}`)) return { kind: "location", label: name || "到达或离开某地", editable: false };
  if (/weather|sunset|sunrise/.test(`${src} ${key}`)) return { kind: "weather", label: name || "天气或日出日落", editable: false };
  return { kind: "unknown", label: name || "米家私有触发条件", detail: "当前版本只读，保存时会原样保留", editable: false };
}

function triggerDeviceDid(trigger: XiaomiSceneRecord) {
  const payload = parsedSceneRecord(trigger.payload_json ?? trigger.payload ?? trigger.setting);
  const device = record(payload?.device);
  const params = record(payload?.params);
  return text(trigger.did ?? trigger.device_id ?? payload?.did ?? payload?.device_id ?? payload?.deviceId ?? device?.did ?? device?.device_id ?? params?.did);
}

export function buildAutomationTriggerCatalog(
  automations: XiaomiSceneRecord[],
  devices: XiaomiSceneRecord[],
  homeId: string,
): AutomationTriggerTemplate[] {
  const scopedDevices = devices.filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did));
  const devicesByDid = new Map(scopedDevices.flatMap((device, index, candidates) => {
    const did = text(device.did);
    return parseDerivedDeviceId(did) || candidates.findIndex(candidate => text(candidate.did) === did) !== index ? [] : [[did, {
      deviceKey: `device-${index + 1}`,
      deviceName: text(device.name) || text(device.model) || "未命名设备",
      room: text(device.roomName ?? device.room_name) || "未分配",
    }] as const];
  }));
  const templates = automations
    .filter(automation => (text(automation.home_id) || homeId) === homeId)
    .flatMap(automation => rawAutomationTriggers(automation).map((trigger, sourceIndex) => ({
      trigger,
      sourceIndex,
      automationId: text(automation.scene_id ?? automation.us_id ?? automation.id),
    })))
    .flatMap(item => {
      const parsed = parseAutomationTrigger(item.trigger);
      if (!item.automationId || parsed.kind === "schedule" || parsed.kind === "unknown") return [];
      const device = parsed.kind === "device" ? devicesByDid.get(triggerDeviceDid(item.trigger)) : undefined;
      return [{
        key: `${item.automationId}:${item.sourceIndex}`,
        automationId: item.automationId,
        sourceIndex: item.sourceIndex,
        kind: parsed.kind,
        label: parsed.label,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
        ...(device ?? {}),
      } satisfies AutomationTriggerTemplate];
    });
  return templates.filter((item, index) => templates.findIndex(candidate =>
    candidate.kind === item.kind
    && candidate.label === item.label
    && candidate.deviceKey === item.deviceKey
  ) === index);
}

function enabled(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  return ![false, 0, "0", "false", "disabled", "off"].includes(value as never);
}

export function parseAutomations(response: XiaomiSceneRecord, homeId: string, devices: XiaomiSceneRecord[] = []): XiaomiAutomation[] {
  return sceneEntries(response).flatMap(scene => {
    if (!isAutomationRecord(scene)) return [];
    const id = text(scene.scene_id ?? scene.us_id ?? scene.id);
    const name = text(scene.name ?? scene.scene_name);
    const sceneHomeId = text(scene.home_id) || homeId;
    if (!id || !name || sceneHomeId !== homeId) return [];
    const triggerContainer = parsedSceneRecord(scene.scene_trigger ?? scene.trigger);
    const manualShape = { ...scene, scene_trigger: { triggers: [{ src: "user", key: "user.click" }] } };
    const actions = parseManualScenes({ result: [manualShape] }, homeId, devices)[0]?.actions ?? [];
    const updatedAt = text(scene.update_time ?? scene.updated_at ?? scene.modify_time);
    return [{
      id,
      homeId,
      name,
      enabled: enabled(scene.enable ?? scene.enabled ?? scene.status),
      triggerMode: Number(triggerContainer?.express) === 1 ? "all" : "any",
      triggers: rawAutomationTriggers(scene).map(parseAutomationTrigger),
      actions,
      actionCount: actions.length,
      ...(updatedAt ? { updatedAt } : {}),
    }];
  });
}

export async function listRawAutomations(session: XiaomiSession, homeId: string, request: XiaomiRequester = xiaomiRequest) {
  const response = await request(session, AUTOMATION_LIST_PATH, { home_id: homeId });
  return sceneEntries(response).filter(scene => (text(scene.home_id) || homeId) === homeId && isAutomationRecord(scene));
}

export async function listAutomations(session: XiaomiSession, homeId: string, request: XiaomiRequester = xiaomiRequest) {
  return parseAutomations({ result: await listRawAutomations(session, homeId, request) }, homeId);
}
