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
  details: ManualSceneActionDetail[];
};

export type ManualSceneActionDetail = {
  kind: "power" | "brightness" | "color-temperature" | "delay" | "property" | "command";
  label: string;
  value: string;
  state?: "on" | "off";
};

type HomeIdentity = { id: string };

type RawScene = Record<string, unknown>;
type XiaomiRequester = (
  session: XiaomiSession,
  path: string,
  data: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

const SCENE_LIST_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList";
const SCENE_RUN_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/NewRunScene";

function record(value: unknown): RawScene | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as RawScene;
}

function parsedRecord(value: unknown) {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return record(value);
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
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
  const trigger = parsedRecord(scene.scene_trigger ?? scene.trigger);
  if (Array.isArray(trigger?.triggers)) return trigger.triggers.filter((item): item is RawScene => Boolean(record(item)));
  if (Array.isArray(scene.triggers)) return scene.triggers.filter((item): item is RawScene => Boolean(record(item)));
  return [];
}

function isManualScene(scene: RawScene) {
  return triggerEntries(scene).some(trigger => text(trigger.src).toLowerCase() === "user");
}

function actionEntries(scene: RawScene) {
  const action = parsedRecord(scene.scene_action ?? scene.action);
  for (const candidate of [action?.actions, scene.actions, parsedRecord(scene.setting)?.action_list]) {
    if (Array.isArray(candidate)) return candidate.map(item => record(item) ?? { name: text(item) });
  }
  return [];
}

function primitive(value: unknown) {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "";
}

function propertyDetail(value: RawScene) {
  const siid = number(value.siid, 0);
  const piid = number(value.piid, 0);
  const formatted = primitive(value.value);
  if (!formatted) return undefined;
  if (piid === 1 && typeof value.value === "boolean") return { kind: "power" as const, label: "电源", value: formatted, state: value.value ? "on" as const : "off" as const };
  if (siid === 2 && piid === 2 && typeof value.value === "number") return { kind: "brightness" as const, label: "亮度", value: `${formatted}%` };
  if (siid === 2 && piid === 3 && typeof value.value === "number") return { kind: "color-temperature" as const, label: "色温", value: `${formatted} K` };
  return { kind: "property" as const, label: siid && piid ? `属性 ${siid}.${piid}` : "属性", value: formatted };
}

function commandLabel(command: string) {
  if (command === "set_properties") return "设置设备属性";
  if (command === "action") return "执行设备动作";
  if (command === "delay") return "延时";
  return command || "执行动作";
}

function normalizeActions(scene: RawScene): ManualSceneAction[] {
  return actionEntries(scene).map((action, index) => {
    const payload = parsedRecord(action.payload_json ?? action.payload);
    const command = text(payload?.command);
    const label = text(action.name) || text(action.action_name) || commandLabel(command);
    const deviceName = text(payload?.device_name) || text(action.device_name);
    const values = Array.isArray(payload?.value) ? payload.value.filter((item): item is RawScene => Boolean(record(item))) : [];
    const details: ManualSceneActionDetail[] = values.map(propertyDetail).filter((item): item is NonNullable<ReturnType<typeof propertyDetail>> => Boolean(item));
    const delay = number(payload?.delay_time ?? action.delay_time, 0);
    if (delay > 0) details.unshift({ kind: "delay", label: "延时", value: `${delay} 秒` });
    if (!details.length && command && label !== commandLabel(command)) details.push({ kind: "command", label: "方式", value: commandLabel(command) });
    return {
      order: number(action.order, index + 1),
      label,
      ...(deviceName ? { deviceName } : {}),
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

export function parseManualScenes(response: Record<string, unknown>, homeId: string): ManualScene[] {
  const scenes = new Map<string, ManualScene>();
  for (const scene of sceneEntries(response)) {
    if (!isManualScene(scene)) continue;
    const id = text(scene.scene_id ?? scene.us_id ?? scene.id);
    const name = text(scene.name ?? scene.scene_name);
    const sceneHomeId = text(scene.home_id) || homeId;
    if (!id || !name || sceneHomeId !== homeId) continue;
    const icon = text(scene.icon ?? scene.icon_url);
    const updatedAt = text(scene.update_time ?? scene.updated_at ?? scene.modify_time);
    const actions = normalizeActions(scene);
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
