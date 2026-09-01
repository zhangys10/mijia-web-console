import { getMiotCapabilities } from "./miot-spec.ts";
import type { SceneMappableGroup } from "./xiaomi-scene-properties.ts";
import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";

export type ManualScene = {
  id: string;
  homeId: string;
  name: string;
  icon?: string;
  enabled: boolean;
  actionCount: number;
  updatedAt?: string;
  actions: ManualSceneAction[];
};

export type ManualSceneAction = {
  order: number;
  label: string;
  deviceName?: string;
  room?: string;
  details: ManualSceneActionDetail[];
};

export type ManualSceneActionDetail = {
  kind: "power" | "brightness" | "color-temperature" | "delay" | "property" | "command";
  label: string;
  value: string;
  state?: "on" | "off";
};

type HomeIdentity = { id: string };

export type XiaomiSceneRecord = Record<string, unknown>;
export type SceneDeviceCapabilities = Map<string, SceneMappableGroup[]>;
type RawScene = XiaomiSceneRecord;
export type XiaomiRequester = (
  session: XiaomiSession,
  path: string,
  data: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export const SCENE_LIST_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList";
export const SCENE_RUN_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/NewRunScene";

function record(value: unknown): RawScene | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as RawScene;
}

export function parsedSceneRecord(value: unknown) {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return record(value);
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function sceneDeviceCapabilityKey(homeId: string, did: string) {
  return `${homeId}\u0000${did}`;
}

function deviceHomeId(device: RawScene) {
  return text(device.homeId ?? device.home_id);
}

function deviceUrn(device: RawScene) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

export async function loadSceneDeviceCapabilities(
  devices: XiaomiSceneRecord[],
  homeId: string,
  loadCapabilities: typeof getMiotCapabilities = getMiotCapabilities,
): Promise<SceneDeviceCapabilities> {
  const eligible = devices.filter(device => deviceHomeId(device) === homeId && text(device.did) && text(device.model));
  const byModel = new Map<string, Promise<SceneMappableGroup[]>>();
  for (const device of eligible) {
    const model = text(device.model);
    const urn = deviceUrn(device);
    const key = `${model}:${urn ?? ""}`;
    if (!byModel.has(key)) byModel.set(key, loadCapabilities(model, urn).then(result => result.groups).catch(() => []));
  }
  const entries = await Promise.all(eligible.map(async device => {
    const model = text(device.model);
    const urn = deviceUrn(device);
    return [sceneDeviceCapabilityKey(homeId, text(device.did)), await byModel.get(`${model}:${urn ?? ""}`)!] as const;
  }));
  return new Map(entries);
}

export async function loadSceneActionCapabilities(
  scenes: XiaomiSceneRecord[],
  homeId: string,
  existing: SceneDeviceCapabilities = new Map(),
  loadCapabilities: typeof getMiotCapabilities = getMiotCapabilities,
): Promise<SceneDeviceCapabilities> {
  const capabilities = new Map(existing);
  const targets = new Map<string, { did: string; model: string; urn?: string }>();
  for (const scene of scenes) {
    if ((text(scene.home_id) || homeId) !== homeId) continue;
    for (const action of actionEntries(scene)) {
      const payload = parsedSceneRecord(action.payload_json ?? action.payload);
      const did = text(payload?.did ?? action.did);
      const model = text(payload?.model ?? action.model);
      if (!did || !model || capabilities.get(sceneDeviceCapabilityKey(homeId, did))?.length) continue;
      const urnValue = payload?.urn ?? payload?.spec_type ?? action.urn ?? action.spec_type;
      const urn = typeof urnValue === "string" && urnValue.startsWith("urn:") ? urnValue : undefined;
      targets.set(sceneDeviceCapabilityKey(homeId, did), { did, model, urn });
    }
  }
  const byModel = new Map<string, Promise<SceneMappableGroup[]>>();
  for (const target of targets.values()) {
    const key = `${target.model}:${target.urn ?? ""}`;
    if (!byModel.has(key)) byModel.set(key, loadCapabilities(target.model, target.urn).then(result => result.groups).catch(() => []));
  }
  await Promise.all([...targets.entries()].map(async ([key, target]) => {
    capabilities.set(key, await byModel.get(`${target.model}:${target.urn ?? ""}`)!);
  }));
  return capabilities;
}

function number(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sceneEntries(response: Record<string, unknown>) {
  const result = response.result;
  if (result === null) return [];
  if (Array.isArray(result)) return result.filter((item): item is RawScene => Boolean(record(item)));
  const resultRecord = record(result);
  if (!resultRecord) throw new Error("XIAOMI_SCENE_RESPONSE_INVALID");
  for (const candidate of [resultRecord.scene_info_list, resultRecord.scene_list, resultRecord.list, resultRecord.scenes]) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is RawScene => Boolean(record(item)));
  }
  const values = Object.values(resultRecord);
  if (values.length > 0 && values.every(value => Boolean(record(value)))) return values as RawScene[];
  throw new Error("XIAOMI_SCENE_RESPONSE_INVALID");
}

function triggerEntries(scene: RawScene) {
  const trigger = parsedSceneRecord(scene.scene_trigger ?? scene.trigger);
  if (Array.isArray(trigger?.triggers)) return trigger.triggers.filter((item): item is RawScene => Boolean(record(item)));
  if (Array.isArray(scene.triggers)) return scene.triggers.filter((item): item is RawScene => Boolean(record(item)));
  return [];
}

export function isManualSceneRecord(scene: RawScene) {
  return triggerEntries(scene).some(trigger => text(trigger.src).toLowerCase() === "user" || text(trigger.key).toLowerCase() === "user.click");
}

function actionEntries(scene: RawScene) {
  const action = parsedSceneRecord(scene.scene_action ?? scene.action);
  for (const candidate of [action?.actions, scene.actions, parsedSceneRecord(scene.setting)?.action_list]) {
    if (Array.isArray(candidate)) return candidate.map(item => record(item) ?? { name: text(item) });
  }
  return [];
}

function primitive(value: unknown) {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function sameValue(left: unknown, right: unknown) {
  return typeof left === typeof right && left === right;
}

function propertyDetail(value: RawScene, groups: SceneMappableGroup[] = []) {
  const siid = number(value.siid, 0);
  const piid = number(value.piid, 0);
  const formatted = primitive(value.value);
  if (!formatted) return undefined;
  const property = groups.flatMap(group => group.properties).find(item => item.siid === siid && item.piid === piid);
  if (!property) return { kind: "property" as const, label: "未识别属性", value: formatted };
  const choiceMatches = property.choices?.filter(choice => sameValue(choice.value, value.value)) ?? [];
  const described = property.choices?.length
    ? choiceMatches.length === 1 ? choiceMatches[0].label : `未知（${formatted}）`
    : property.name === "brightness" ? `${formatted}%`
      : property.name === "color-temperature" ? `${formatted} K`
        : property.unit === "celsius" || property.name === "target-temperature" ? `${formatted}°C`
          : formatted;
  if (property.name === "on" && typeof value.value === "boolean") return { kind: "power" as const, label: property.label, value: described, state: value.value ? "on" as const : "off" as const };
  if (property.name === "brightness") return { kind: "brightness" as const, label: property.label, value: described };
  if (property.name === "color-temperature") return { kind: "color-temperature" as const, label: property.label, value: described };
  return { kind: "property" as const, label: property.label, value: described };
}

function commandLabel(command: string) {
  if (command === "set_properties") return "设置设备属性";
  if (command === "action") return "执行设备动作";
  if (command === "delay") return "延时";
  return command || "执行动作";
}

function normalizeActions(scene: RawScene, roomsByDid: Map<string, string>, capabilities: SceneDeviceCapabilities, homeId: string): ManualSceneAction[] {
  return actionEntries(scene).map((action, index) => {
    const payload = parsedSceneRecord(action.payload_json ?? action.payload);
    const command = text(payload?.command);
    const label = text(action.name) || text(action.action_name) || commandLabel(command);
    const deviceName = text(payload?.device_name) || text(action.device_name);
    const did = text(payload?.did ?? action.did);
    const room = roomsByDid.get(did);
    const groups = capabilities.get(sceneDeviceCapabilityKey(homeId, did));
    const values = Array.isArray(payload?.value) ? payload.value.filter((item): item is RawScene => Boolean(record(item))) : [];
    const details: ManualSceneActionDetail[] = values.map(value => propertyDetail(value, groups)).filter((item): item is NonNullable<ReturnType<typeof propertyDetail>> => Boolean(item));
    const delay = number(payload?.delay_time ?? action.delay_time, 0);
    if (delay > 0) details.unshift({ kind: "delay", label: "延时", value: `${delay} 秒` });
    if (!details.length && command && label !== commandLabel(command)) details.push({ kind: "command", label: "方式", value: commandLabel(command) });
    return {
      order: number(action.order, index + 1),
      label,
      ...(deviceName ? { deviceName } : {}),
      ...(room ? { room } : {}),
      details,
    };
  }).sort((left, right) => left.order - right.order);
}

function enabled(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return !["0", "false", "disabled", "off"].includes(String(value).toLowerCase());
}

export function parseManualScenes(response: Record<string, unknown>, homeId: string, devices: XiaomiSceneRecord[] = [], capabilities: SceneDeviceCapabilities = new Map()): ManualScene[] {
  const roomsByDid = new Map(devices.flatMap(device => {
    const deviceHomeId = text(device.homeId ?? device.home_id);
    const did = text(device.did);
    const room = text(device.roomName ?? device.room_name);
    return deviceHomeId === homeId && did && room ? [[did, room] as const] : [];
  }));
  const scenes = new Map<string, ManualScene>();
  for (const scene of sceneEntries(response)) {
    if (!isManualSceneRecord(scene)) continue;
    const id = text(scene.scene_id ?? scene.us_id ?? scene.id);
    const name = text(scene.name ?? scene.scene_name);
    const sceneHomeId = text(scene.home_id) || homeId;
    if (!id || !name || sceneHomeId !== homeId) continue;
    const icon = text(scene.icon ?? scene.icon_url);
    const updatedAt = text(scene.update_time ?? scene.updated_at ?? scene.modify_time);
    const actions = normalizeActions(scene, roomsByDid, capabilities, homeId);
    scenes.set(id, {
      id,
      homeId,
      name,
      ...(icon ? { icon } : {}),
      enabled: enabled(scene.enable ?? scene.enabled ?? scene.status),
      actionCount: actions.length,
      ...(updatedAt ? { updatedAt } : {}),
      actions,
    });
  }
  return [...scenes.values()];
}

export function assertHomeAccess(homes: HomeIdentity[], homeId: string) {
  if (!homes.some(home => home.id === homeId)) throw new Error("XIAOMI_HOME_NOT_FOUND");
}

export function selectRunnableManualScene(scenes: ManualScene[], homeId: string, sceneId: string) {
  const scene = scenes.find(item => item.homeId === homeId && item.id === sceneId);
  if (!scene) throw new Error("XIAOMI_SCENE_NOT_FOUND");
  if (!scene.enabled) throw new Error("XIAOMI_SCENE_DISABLED");
  return scene;
}

export async function listManualScenes(
  session: XiaomiSession,
  homeId: string,
  request: XiaomiRequester = xiaomiRequest,
) {
  const response = await request(session, SCENE_LIST_PATH, { home_id: homeId });
  return parseManualScenes(response, homeId);
}

export async function listRawManualScenes(
  session: XiaomiSession,
  homeId: string,
  request: XiaomiRequester = xiaomiRequest,
) {
  const response = await request(session, SCENE_LIST_PATH, { home_id: homeId });
  return sceneEntries(response).filter(scene => {
    const sceneHomeId = text(scene.home_id) || homeId;
    return sceneHomeId === homeId && isManualSceneRecord(scene);
  });
}

export async function runManualScene(
  session: XiaomiSession,
  sceneId: string,
  request: XiaomiRequester = xiaomiRequest,
) {
  const response = await request(session, SCENE_RUN_PATH, {
    scene_id: sceneId,
    scene_type: 2,
    trigger_key: "user.click",
  });
  if (response.result !== true) throw new Error("XIAOMI_SCENE_NOT_ACCEPTED");
}
