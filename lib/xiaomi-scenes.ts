import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";

export type ManualScene = {
  id: string;
  homeId: string;
  name: string;
  icon?: string;
  enabled: boolean;
  actionCount: number;
  updatedAt?: string;
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

function sceneEntries(response: Record<string, unknown>) {
  const result = response.result;
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

function actionCount(scene: RawScene) {
  const action = parsedRecord(scene.scene_action ?? scene.action);
  for (const candidate of [action?.actions, scene.actions, parsedRecord(scene.setting)?.action_list]) {
    if (Array.isArray(candidate)) return candidate.length;
  }
  return 0;
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
    scenes.set(id, {
      id,
      homeId,
      name,
      ...(icon ? { icon } : {}),
      enabled: enabled(scene.enable ?? scene.enabled ?? scene.status),
      actionCount: actionCount(scene),
      ...(updatedAt ? { updatedAt } : {}),
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
