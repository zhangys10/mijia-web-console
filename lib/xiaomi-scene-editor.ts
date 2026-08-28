import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";
import { getMiotCapabilities } from "./miot-spec.ts";
import { parseDerivedDeviceId } from "./device-topology.ts";
import { isScenePropertyValueSupported, isSceneWritableProperty } from "./xiaomi-scene-properties.ts";
import {
  parsedSceneRecord,
  type XiaomiRequester,
  type XiaomiSceneRecord,
} from "./xiaomi-scenes.ts";

export type SceneValue = boolean | number | string;

export type SceneDraftProperty = {
  siid: number;
  piid: number;
  value: SceneValue;
  label?: string;
};

export type SceneDraftAction = {
  clientId: string;
  kind: "set-properties" | "invoke-action";
  sourceIndex?: number;
  did: string;
  deviceName: string;
  model: string;
  label: string;
  properties?: SceneDraftProperty[];
  siid?: number;
  aiid?: number;
};

export type SceneDraftUnsupportedAction = {
  clientId: string;
  kind: "unsupported";
  sourceIndex: number;
  label: string;
  deviceName?: string;
  reason: string;
};

export type SceneEditorDraft = {
  sceneId: string;
  homeId: string;
  name: string;
  icon?: string;
  enabled: boolean;
  revision: string;
  actionsEditable: boolean;
  actions: Array<SceneDraftAction | SceneDraftUnsupportedAction>;
};

export type SceneWriteDraft = {
  homeId: string;
  name: string;
  enabled?: boolean;
  revision?: string;
  actions?: SceneDraftAction[];
};

type ActionContainer = {
  style: "modern" | "legacy";
  key: "scene_action" | "action" | "actions" | "setting";
  encoded: boolean;
  container?: XiaomiSceneRecord;
  entries: XiaomiSceneRecord[];
};

const SCENE_EDIT_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/Edit";

function record(value: unknown): XiaomiSceneRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XiaomiSceneRecord : undefined;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function integer(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function primitive(value: unknown): value is SceneValue {
  return typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function actionContainer(scene: XiaomiSceneRecord): ActionContainer {
  for (const key of ["scene_action", "action"] as const) {
    if (scene[key] === undefined) continue;
    const container = parsedSceneRecord(scene[key]);
    if (Array.isArray(container?.actions)) {
      return {
        style: "modern",
        key,
        encoded: typeof scene[key] === "string",
        container,
        entries: container.actions.map(item => record(item) ?? {}),
      };
    }
  }
  if (Array.isArray(scene.actions)) {
    return { style: "modern", key: "actions", encoded: false, entries: scene.actions.map(item => record(item) ?? {}) };
  }
  const setting = parsedSceneRecord(scene.setting);
  if (Array.isArray(setting?.action_list)) {
    return {
      style: "legacy",
      key: "setting",
      encoded: typeof scene.setting === "string",
      container: setting,
      entries: setting.action_list.map(item => record(item) ?? {}),
    };
  }
  return { style: "modern", key: "scene_action", encoded: false, container: {}, entries: [] };
}

function actionPayload(action: XiaomiSceneRecord) {
  return parsedSceneRecord(action.payload_json ?? action.payload);
}

function parsedAction(action: XiaomiSceneRecord, sourceIndex: number): SceneDraftAction | SceneDraftUnsupportedAction {
  const payload = actionPayload(action);
  const label = text(action.name ?? action.action_name) || "未命名动作";
  const deviceName = text(payload?.device_name ?? action.device_name);
  const did = text(payload?.did ?? action.did);
  const model = text(action.model ?? payload?.model);
  const command = text(payload?.command).toLowerCase();
  const base = { clientId: `source-${sourceIndex}`, sourceIndex, did, deviceName, model, label };
  if (command === "set_properties" && did && Array.isArray(payload?.value)) {
    const properties: SceneDraftProperty[] = [];
    for (const item of payload.value) {
      const value = record(item);
      const siid = integer(value?.siid);
      const piid = integer(value?.piid);
      if (!value || !siid || !piid || !primitive(value.value)) {
        return { clientId: base.clientId, kind: "unsupported", sourceIndex, label, ...(deviceName ? { deviceName } : {}), reason: "属性动作包含无法安全编辑的字段" };
      }
      properties.push({ siid, piid, value: value.value });
    }
    if (properties.length) return { ...base, kind: "set-properties", properties };
  }
  if (command === "action") return {
    clientId: base.clientId,
    kind: "unsupported",
    sourceIndex,
    label,
    ...(deviceName ? { deviceName } : {}),
    reason: "设备动作需要米家场景动作目录，当前仅支持原样保留",
  };
  return {
    clientId: base.clientId,
    kind: "unsupported",
    sourceIndex,
    label,
    ...(deviceName ? { deviceName } : {}),
    reason: command ? `暂不支持 ${command} 动作` : "动作格式无法安全识别",
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sceneRevision(scene: XiaomiSceneRecord) {
  const bytes = new TextEncoder().encode(canonical(scene));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
}

export function sceneRecordId(scene: XiaomiSceneRecord) {
  return text(scene.scene_id ?? scene.us_id ?? scene.id);
}

export async function createEditorDraft(scene: XiaomiSceneRecord, homeId: string): Promise<SceneEditorDraft> {
  const sceneId = sceneRecordId(scene);
  if (!sceneId) throw new Error("XIAOMI_SCENE_NOT_FOUND");
  const actions = actionContainer(scene).entries.map(parsedAction);
  const icon = text(scene.icon ?? scene.icon_url);
  const enabledValue = scene.enable ?? scene.enabled ?? scene.status;
  const enabled = enabledValue === undefined || enabledValue === null || ![false, 0, "0", "false", "disabled"].includes(enabledValue as never);
  return {
    sceneId,
    homeId,
    name: text(scene.name ?? scene.scene_name) || "未命名场景",
    ...(icon ? { icon } : {}),
    enabled,
    revision: await sceneRevision(scene),
    actionsEditable: actions.every(action => action.kind !== "unsupported"),
    actions,
  };
}

function modernAction(action: SceneDraftAction, order: number, source?: XiaomiSceneRecord, userId?: string) {
  const output: XiaomiSceneRecord = source ? deepClone(source) : {};
  const sourcePayload = source ? actionPayload(source) : undefined;
  const payload: XiaomiSceneRecord = sourcePayload ? deepClone(sourcePayload) : {};
  output.order = order;
  output.id = typeof output.id === "number" ? output.id : order;
  output.group_id = typeof output.group_id === "number" ? output.group_id : 1;
  output.type = typeof output.type === "number" ? output.type : 0;
  output.name = action.label || action.deviceName;
  output.payload = output.payload ?? "";
  output.protocol_type = typeof output.protocol_type === "number" ? output.protocol_type : 2;
  output.sa_id = typeof output.sa_id === "number" ? output.sa_id : action.kind === "set-properties" ? 5 : 0;
  output.from = typeof output.from === "number" ? output.from : 3;
  output.device_group_id = typeof output.device_group_id === "number" ? output.device_group_id : 0;
  output.nested_scene_info = output.nested_scene_info ?? null;
  output.std_sa_id = typeof output.std_sa_id === "string" ? output.std_sa_id : "";
  output.option_ids = Array.isArray(output.option_ids) ? output.option_ids : [];
  output.data_ver = typeof output.data_ver === "number" ? output.data_ver : 0;
  payload.command = action.kind === "set-properties" ? "set_properties" : "action";
  payload.did = action.did;
  payload.delay_time = typeof payload.delay_time === "number" ? payload.delay_time : 0;
  payload.device_name = action.deviceName;
  payload.model = action.model;
  if (userId) payload.uid = userId;
  payload.value = action.kind === "set-properties"
    ? action.properties?.map(property => ({ did: action.did, siid: property.siid, piid: property.piid, value: property.value })) ?? []
    : { did: action.did, siid: action.siid, aiid: action.aiid, in: [] };
  const key = source && "payload" in source && !("payload_json" in source) ? "payload" : "payload_json";
  output[key] = source && typeof source[key] === "string" ? JSON.stringify(payload) : payload;
  return output;
}

function legacyAction(action: SceneDraftAction, order: number, source?: XiaomiSceneRecord) {
  const output: XiaomiSceneRecord = source ? deepClone(source) : {};
  const sourcePayload = source ? actionPayload(source) : undefined;
  const payload: XiaomiSceneRecord = sourcePayload ? deepClone(sourcePayload) : {};
  output.name = action.label || action.deviceName;
  output.type = 0;
  output.model = action.model;
  output.tr_id = typeof output.tr_id === "number" ? output.tr_id : 0;
  output.sa_id = typeof output.sa_id === "number" ? output.sa_id : 0;
  payload.command = action.kind === "set-properties" ? "set_properties" : "action";
  payload.did = action.did;
  payload.delay_time = 0;
  payload.total_length = order - 1;
  payload.value = action.kind === "set-properties"
    ? action.properties?.map(property => ({ did: action.did, siid: property.siid, piid: property.piid, value: property.value })) ?? []
    : { did: action.did, siid: action.siid, aiid: action.aiid, in: [] };
  output.payload = payload;
  delete output.payload_json;
  return output;
}

function replaceActions(scene: XiaomiSceneRecord, actions: SceneDraftAction[], userId = text(scene.uid)) {
  const current = actionContainer(scene);
  const entries = actions.map((action, index) => {
    const source = action.sourceIndex === undefined ? undefined : current.entries[action.sourceIndex];
    return current.style === "legacy" ? legacyAction(action, index + 1, source) : modernAction(action, index + 1, source, userId);
  });
  if (current.key === "actions") scene.actions = entries;
  else if (current.key === "setting") {
    const setting = deepClone(current.container ?? {});
    setting.action_list = entries;
    scene.setting = current.encoded ? JSON.stringify(setting) : setting;
  } else {
    const container = deepClone(current.container ?? {});
    container.actions = entries;
    scene[current.key] = current.encoded ? JSON.stringify(container) : container;
  }
}

function writeMetadata(scene: XiaomiSceneRecord, draft: SceneWriteDraft) {
  scene.home_id = draft.homeId;
  scene.name = draft.name;
  if ("scene_name" in scene) scene.scene_name = draft.name;
  if (draft.enabled !== undefined) {
    if ("enabled" in scene) scene.enabled = draft.enabled;
    scene.enable = draft.enabled;
  }
}

export function buildUpdatePayload(scene: XiaomiSceneRecord, draft: SceneWriteDraft) {
  const output = deepClone(scene);
  writeMetadata(output, draft);
  if (draft.actions) replaceActions(output, draft.actions);
  output.edit_from = 0;
  output.value_format = 1;
  return output;
}

export function buildCreatePayload(draft: SceneWriteDraft, userId: string) {
  const output: XiaomiSceneRecord = {
    home_id: draft.homeId,
    scene_name: draft.name,
    enable_push: false,
    common_use: false,
    enable: draft.enabled ?? true,
    scene_condition: { express: 0 },
    scene_trigger: {
      express: 0,
      triggers: [{ id: 0, order: 1, src: "user", name: "", key: "user.click", value_type: 5 }],
    },
    scene_action: { mode: 1, actions: [] },
  };
  replaceActions(output, draft.actions ?? [], userId);
  output.edit_from = 0;
  output.value_format = 1;
  return output;
}

export async function submitSceneEdit(
  session: XiaomiSession,
  payload: XiaomiSceneRecord,
  request: XiaomiRequester = xiaomiRequest,
) {
  const response = await request(session, SCENE_EDIT_PATH, payload);
  if (response.result === false || response.result === null) throw new Error("XIAOMI_SCENE_NOT_ACCEPTED");
  return response;
}

export function sceneIdFromEditResponse(response: XiaomiSceneRecord) {
  const result = record(response.result);
  return text(result?.scene_id ?? result?.us_id ?? response.scene_id ?? response.us_id)
    || (typeof response.result === "string" || typeof response.result === "number" ? String(response.result) : "");
}

export function assertBasicSceneDraft(value: unknown, editing: boolean): SceneWriteDraft {
  const draft = record(value);
  if (!draft) throw new Error("INVALID_SCENE_DRAFT");
  const homeId = text(draft.homeId);
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!homeId || homeId.length > 128 || /[\u0000-\u001f]/.test(homeId)) throw new Error("INVALID_HOME_ID");
  if (!name || name.length > 50 || /[\u0000-\u001f]/.test(name)) throw new Error("INVALID_SCENE_NAME");
  const revision = typeof draft.revision === "string" ? draft.revision : undefined;
  if (editing && (!revision || !/^[a-f0-9]{64}$/.test(revision))) throw new Error("INVALID_SCENE_REVISION");
  let actions: SceneDraftAction[] | undefined;
  if (draft.actions !== undefined) {
    if (!Array.isArray(draft.actions) || draft.actions.length < 1 || draft.actions.length > 64) throw new Error("INVALID_SCENE_ACTIONS");
    actions = draft.actions.map((item, index) => {
      const action = record(item);
      if (!action || action.kind !== "set-properties") throw new Error("INVALID_SCENE_ACTION");
      const did = text(action.did);
      const deviceName = typeof action.deviceName === "string" ? action.deviceName.trim() : "";
      const model = text(action.model);
      const label = typeof action.label === "string" ? action.label.trim() : "";
      if (!did || did.length > 128 || !deviceName || deviceName.length > 100 || !model || model.length > 120 || !label || label.length > 100) throw new Error("INVALID_SCENE_ACTION");
      const base = { clientId: text(action.clientId) || `action-${index}`, did, deviceName, model, label, ...(Number.isInteger(action.sourceIndex) && Number(action.sourceIndex) >= 0 ? { sourceIndex: Number(action.sourceIndex) } : {}) };
      if (!Array.isArray(action.properties) || action.properties.length < 1 || action.properties.length > 20) throw new Error("INVALID_SCENE_ACTION");
      const properties = action.properties.map(item => {
        const property = record(item);
        const siid = integer(property?.siid);
        const piid = integer(property?.piid);
        if (!property || !siid || !piid || !primitive(property.value)) throw new Error("INVALID_SCENE_PROPERTY");
        return { siid, piid, value: property.value, ...(typeof property.label === "string" ? { label: property.label.slice(0, 100) } : {}) };
      });
      return { ...base, kind: "set-properties" as const, properties };
    });
  }
  return { homeId, name, ...(typeof draft.enabled === "boolean" ? { enabled: draft.enabled } : {}), ...(revision ? { revision } : {}), ...(actions ? { actions } : {}) };
}

type CapabilityLoader = typeof getMiotCapabilities;

function deviceHomeId(device: XiaomiSceneRecord) {
  return text(device.homeId ?? device.home_id);
}

function deviceModel(device: XiaomiSceneRecord) {
  return text(device.model);
}

function deviceUrn(device: XiaomiSceneRecord) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

export async function validateSceneDraftCapabilities(
  draft: SceneWriteDraft,
  devices: XiaomiSceneRecord[],
  loadCapabilities: CapabilityLoader = getMiotCapabilities,
  allowExistingVirtualTargets = false,
) {
  if (!draft.actions) return draft;
  const byDid = new Map(devices.map(device => [text(device.did), device]));
  const specifications = new Map<string, Awaited<ReturnType<CapabilityLoader>>>();
  const actions: SceneDraftAction[] = [];
  for (const action of draft.actions) {
    const device = byDid.get(action.did);
    const virtualTarget = Boolean(parseDerivedDeviceId(action.did));
    if (!device || deviceHomeId(device) !== draft.homeId || virtualTarget && !(allowExistingVirtualTargets && action.sourceIndex !== undefined)) throw new Error("XIAOMI_SCENE_DEVICE_NOT_FOUND");
    const model = deviceModel(device);
    if (!model) throw new Error("XIAOMI_SCENE_DEVICE_UNSUPPORTED");
    const urn = deviceUrn(device);
    const key = `${model}:${urn ?? ""}`;
    let specification = specifications.get(key);
    if (!specification) {
      specification = await loadCapabilities(model, urn);
      specifications.set(key, specification);
    }
    if (action.kind === "set-properties") {
      for (const requested of action.properties ?? []) {
        const group = specification.groups.find(item => item.siid === requested.siid);
        const property = group?.properties.find(item => item.piid === requested.piid);
        if (!group || !property || !isSceneWritableProperty(group.name, property) || !isScenePropertyValueSupported(property, requested.value)) throw new Error("XIAOMI_SCENE_PROPERTY_UNSUPPORTED");
      }
    } else throw new Error("XIAOMI_SCENE_ACTION_UNSUPPORTED");
    actions.push({
      ...action,
      model,
      deviceName: text(device.name ?? deviceModel(device)) || action.deviceName,
    });
  }
  return { ...draft, actions };
}

export function assertSceneActionSources(actions: SceneDraftAction[], original: SceneEditorDraft["actions"]) {
  const used = new Set<number>();
  for (const action of actions) {
    if (action.sourceIndex === undefined) continue;
    const source = original[action.sourceIndex];
    if (used.has(action.sourceIndex) || !source || source.kind === "unsupported" || source.kind !== action.kind || source.did !== action.did) throw new Error("INVALID_SCENE_ACTION_SOURCE");
    used.add(action.sourceIndex);
  }
}

function sameValue(left: SceneValue, right: SceneValue) {
  return typeof left === typeof right && left === right;
}

export function sceneDraftMatchesWrite(actual: SceneEditorDraft, expected: SceneWriteDraft) {
  if (actual.homeId !== expected.homeId || actual.name !== expected.name) return false;
  if (expected.enabled !== undefined && actual.enabled !== expected.enabled) return false;
  if (!expected.actions) return true;
  if (actual.actions.length !== expected.actions.length || actual.actions.some(action => action.kind === "unsupported")) return false;
  return expected.actions.every((action, index) => {
    const candidate = actual.actions[index];
    if (!candidate || candidate.kind === "unsupported" || candidate.kind !== action.kind || candidate.did !== action.did) return false;
    if (action.kind === "invoke-action") return candidate.kind === "invoke-action" && candidate.siid === action.siid && candidate.aiid === action.aiid;
    if (candidate.kind !== "set-properties" || candidate.properties?.length !== action.properties?.length) return false;
    return (action.properties ?? []).every((property, propertyIndex) => {
      const found = candidate.properties?.[propertyIndex];
      return Boolean(found && found.siid === property.siid && found.piid === property.piid && sameValue(found.value, property.value));
    });
  });
}
