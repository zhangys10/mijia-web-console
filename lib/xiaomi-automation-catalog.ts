import { parseDerivedDeviceId } from "./device-topology.ts";
import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";
import type { XiaomiRequester } from "./xiaomi-scenes.ts";

export const SCENE_TCA_CONFIG_V3_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneTCAConfigV3";
export const AUTOMATION_MODEL_CATALOG_URL = "https://home.mi.com/cgi-op/api/v1/baike/v2/scene";

type CatalogRecord = Record<string, unknown>;
type CatalogScalar = string | number | boolean;

export type AutomationCatalogSource = "tca-v3" | "model-catalog" | "miot-spec";

export type AutomationCatalogCapability = {
  key: string;
  kind: "property" | "event" | "unknown";
  label: string;
  detail: string;
  source: AutomationCatalogSource;
  siid?: number;
  piid?: number;
  eiid?: number;
  value?: CatalogScalar;
};

export type AutomationCatalogAction = {
  key: string;
  kind: "set-property" | "set-properties" | "action" | "unknown";
  label: string;
  detail: string;
  source: AutomationCatalogSource;
  siid?: number;
  piid?: number;
  aiid?: number;
  value?: CatalogScalar;
  properties?: Array<{ siid: number; piid: number; value: CatalogScalar }>;
  inputCount?: number;
};

export type AutomationCatalogDeviceInput = {
  key: string;
  homeId: string;
  did: string;
  model: string;
  deviceName: string;
  room: string;
};

export type AutomationCatalogDevice = {
  key: string;
  deviceName: string;
  room: string;
  capabilities: AutomationCatalogCapability[];
  actions: AutomationCatalogAction[];
  discovery: "tca-v3" | "model-catalog" | "unavailable";
};

export type AutomationModelSceneCatalog = {
  capabilities: AutomationCatalogCapability[];
  actions: AutomationCatalogAction[];
};

type TcaModelCatalog = {
  model: string;
  dids: string[];
  launch: CatalogRecord[];
  actions: CatalogRecord[];
};

type TcaPage = {
  models: TcaModelCatalog[];
  hasMore: boolean;
  maxHomeId: string;
  maxDid: string;
};

const INVALID_BLACK_DIDS = Symbol("INVALID_BLACK_DIDS");

export type AutomationCatalogOptions = {
  request?: XiaomiRequester;
  loadModelCatalog?: (model: string) => Promise<AutomationModelSceneCatalog>;
};

function record(value: unknown): CatalogRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as CatalogRecord;
}

function parsedRecord(value: unknown) {
  if (typeof value !== "string" || value.length > 1_000_000) return record(value);
  try { return record(JSON.parse(value)); } catch { return undefined; }
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function safeText(value: unknown, fallback = "") {
  const valueText = text(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (valueText || fallback).slice(0, 160);
}

function positiveInteger(value: unknown) {
  const numberValue = Number(value);
  return Number.isSafeInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function identifier(value: unknown) {
  const valueText = text(value);
  return valueText && valueText.length <= 128 && !/[\u0000-\u001f]/.test(valueText) ? valueText : "";
}

function catalogItemId(item: CatalogRecord, primary: "sc_id" | "sa_id", related: "related_sc_id" | "related_sa_id") {
  const id = identifier(item[primary]);
  return !id || id === "0" ? identifier(item[related]) : id;
}

function records(value: unknown, limit = 1_000) {
  return Array.isArray(value) ? value.slice(0, limit).flatMap(item => record(item) ? [item as CatalogRecord] : []) : [];
}

function mergedBlackDids(values: unknown[]) {
  const dids = new Set<string>();
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.length > 1_000) return INVALID_BLACK_DIDS;
    for (const rawDid of value) {
      const did = identifier(rawDid);
      if (!did) return INVALID_BLACK_DIDS;
      dids.add(did);
    }
  }
  return [...dids];
}

function mergeCatalogEntries(
  values: CatalogRecord[],
  primary: "sc_id" | "sa_id",
  related: "related_sc_id" | "related_sa_id",
) {
  const entries = new Map<string, CatalogRecord>();
  for (const value of values) {
    const id = catalogItemId(value, primary, related);
    if (!id) continue;
    const previous = entries.get(id);
    const blackDids = mergedBlackDids([previous?.black_dids, value.black_dids]);
    entries.set(id, {
      ...(previous ?? value),
      black_dids: blackDids === INVALID_BLACK_DIDS ? {} : blackDids,
    });
  }
  return [...entries.values()];
}

function mergeTcaModels(values: TcaModelCatalog[]) {
  const models = new Map<string, { model: string; dids: Set<string>; launch: CatalogRecord[]; actions: CatalogRecord[] }>();
  for (const value of values) {
    const model = models.get(value.model) ?? { model: value.model, dids: new Set<string>(), launch: [], actions: [] };
    value.dids.forEach(did => model.dids.add(did));
    model.launch.push(...value.launch);
    model.actions.push(...value.actions);
    models.set(value.model, model);
  }
  return [...models.values()].map(model => ({
    model: model.model,
    dids: [...model.dids],
    launch: mergeCatalogEntries(model.launch, "sc_id", "related_sc_id"),
    actions: mergeCatalogEntries(model.actions, "sa_id", "related_sa_id"),
  }));
}

function strings(value: unknown, limit = 300) {
  return Array.isArray(value) ? value.slice(0, limit).map(text).filter(Boolean) : [];
}

function parseCatalogValue(value: unknown) {
  if (typeof value !== "string") return value;
  if (!value || value.length > 16_384) return undefined;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function scalar(value: unknown): CatalogScalar | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function itemSpecInfo(item: CatalogRecord) {
  const shadow = record(item.shadow_launch) ?? record(item.shadow_action);
  return record(item.spec_info) ?? record(shadow?.spec_info);
}

function itemLabel(item: CatalogRecord, fallback: string, preferTriggerName = false) {
  const specInfo = itemSpecInfo(item);
  const names = preferTriggerName
    ? [item.name_when_v2, item.name_if_v2, item.name, item.intro]
    : [item.intro, item.name_when_v2, item.name_if_v2, item.name];
  const label = [
    ...names,
    specInfo?.pea_name,
    specInfo?.service_desc,
  ].map(value => safeText(value)).find(Boolean);
  return label || fallback;
}

function itemSpecDetail(item: CatalogRecord) {
  const specInfo = itemSpecInfo(item);
  const service = safeText(specInfo?.service_desc);
  const propertyEventAction = safeText(specInfo?.pea_name);
  return [service, propertyEventAction].filter((value, index, values) => value && values.indexOf(value) === index).join(" · ");
}

function parseAutomationKey(rawKey: unknown, model: string) {
  const key = text(rawKey);
  for (const kind of ["property", "event"] as const) {
    const prefix = `${kind === "property" ? "prop" : "event"}.${model}.`;
    if (!key.startsWith(prefix)) continue;
    const remainder = key.slice(prefix.length);
    const match = remainder.match(/^(\d+)\.(\d+)$/);
    if (!match) return { kind, legacy: true } as const;
    const siid = positiveInteger(match[1]);
    const iid = positiveInteger(match[2]);
    if (!siid || !iid) return { kind, legacy: true } as const;
    return kind === "property" ? { kind, siid, piid: iid } as const : { kind, siid, eiid: iid } as const;
  }
  return { kind: "unknown" as const };
}

function valueDetail(value: unknown) {
  const primitive = scalar(value);
  if (primitive !== undefined) {
    if (typeof primitive === "boolean") return primitive ? "开启" : "关闭";
    if (typeof primitive === "string") return "";
    return String(primitive).slice(0, 80);
  }
  const range = record(value);
  const minimum = typeof range?.min === "number" ? range.min : undefined;
  const maximum = typeof range?.max === "number" ? range.max : undefined;
  return minimum !== undefined && maximum !== undefined ? `范围 ${minimum}–${maximum}` : "";
}

function parseLaunchItem(item: CatalogRecord, model: string, source: Exclude<AutomationCatalogSource, "miot-spec">): AutomationCatalogCapability | undefined {
  const id = catalogItemId(item, "sc_id", "related_sc_id");
  if (!id) return undefined;
  const parsedKey = parseAutomationKey(item.key, model);
  const parsedValue = parseCatalogValue(item.value);
  const specDetail = itemSpecDetail(item);
  const kindDetail = specDetail
    || (parsedKey.kind === "event" ? "设备事件" : parsedKey.kind === "property" ? "设备属性" : "米家自动化条件");
  const detail = [kindDetail, valueDetail(parsedValue)].filter(Boolean).join(" · ");
  const safeValue = scalar(parsedValue);
  return {
    key: `${source}:condition:${id}`,
    kind: parsedKey.kind,
    label: itemLabel(item, "设备状态变化", source === "tca-v3"),
    detail,
    source,
    ...(parsedKey.siid ? { siid: parsedKey.siid } : {}),
    ...(parsedKey.kind === "property" && parsedKey.piid ? { piid: parsedKey.piid } : {}),
    ...(parsedKey.kind === "event" && parsedKey.eiid ? { eiid: parsedKey.eiid } : {}),
    ...(safeValue !== undefined ? { value: safeValue } : {}),
  };
}

function propertyValues(value: unknown) {
  return records(value, 32).flatMap(item => {
    const siid = positiveInteger(item.siid);
    const piid = positiveInteger(item.piid);
    const propertyValue = scalar(item.value);
    return siid && piid && propertyValue !== undefined ? [{ siid, piid, value: propertyValue }] : [];
  });
}

function parseActionItem(item: CatalogRecord, model: string, source: Exclude<AutomationCatalogSource, "miot-spec">): AutomationCatalogAction | undefined {
  const id = catalogItemId(item, "sa_id", "related_sa_id");
  if (!id) return undefined;
  const payload = parsedRecord(item.payload);
  const command = text(item.command ?? payload?.command);
  const normalizedCommand = command.startsWith(`${model}.`) ? command.slice(model.length + 1) : command;
  const parsedValue = parseCatalogValue(item.value ?? payload?.value);
  const specDetail = itemSpecDetail(item);
  let kind: AutomationCatalogAction["kind"] = "unknown";
  let detail = specDetail || "米家自动化动作";
  let siid: number | undefined;
  let piid: number | undefined;
  let aiid: number | undefined;
  let actionValue: CatalogScalar | undefined;
  let properties: Array<{ siid: number; piid: number; value: CatalogScalar }> | undefined;
  let inputCount: number | undefined;
  if (normalizedCommand === "set_properties") {
    properties = propertyValues(parsedValue);
    if (properties.length === 1) {
      kind = "set-property";
      [{ siid, piid, value: actionValue }] = properties;
      detail = specDetail || "设置设备属性";
    } else if (properties.length > 1) {
      kind = "set-properties";
      detail = `同时设置 ${properties.length} 个属性`;
    }
  } else if (normalizedCommand === "action") {
    const action = record(parsedValue);
    siid = positiveInteger(action?.siid);
    aiid = positiveInteger(action?.aiid);
    if (siid && aiid) {
      kind = "action";
      detail = specDetail || "调用设备动作";
      inputCount = Array.isArray(action?.in) ? action.in.length : undefined;
    }
  }
  return {
    key: `${source}:action:${id}`,
    kind,
    label: itemLabel(item, "设备动作"),
    detail,
    source,
    ...(siid ? { siid } : {}),
    ...(piid ? { piid } : {}),
    ...(aiid ? { aiid } : {}),
    ...(actionValue !== undefined ? { value: actionValue } : {}),
    ...(properties && properties.length > 1 ? { properties } : {}),
    ...(inputCount !== undefined ? { inputCount } : {}),
  };
}

function resultRecord(response: CatalogRecord) {
  return parsedRecord(response.result) ?? response;
}

export function parseSceneTcaConfigV3Page(response: CatalogRecord): TcaPage {
  const result = resultRecord(response);
  const tca = record(result.TCA_list ?? result.tca_list);
  const rawModels = records(tca?.model_TCA_list ?? tca?.model_tca_list, 1_000);
  if (!tca) throw new Error("XIAOMI_AUTOMATION_TCA_RESPONSE_INVALID");
  const models = rawModels.flatMap(item => {
    const model = identifier(item.model);
    const value = record(item.value);
    if (!model || !value) return [];
    return [{
      model,
      dids: strings(item.dids),
      launch: records(value.launch),
      actions: records(value.action_list),
    }];
  });
  return {
    models,
    hasMore: result.has_more === true || result.has_more === 1,
    maxHomeId: identifier(result.max_home_id),
    maxDid: identifier(result.max_did),
  };
}

export async function listSceneTcaConfigV3(
  session: XiaomiSession,
  homeId: string,
  ownerUid: string,
  dids: string[],
  request: XiaomiRequester = xiaomiRequest,
) {
  if (!identifier(homeId) || !identifier(ownerUid) || !dids.length || dids.length > 300 || dids.some(did => !identifier(did))) {
    throw new Error("INVALID_AUTOMATION_TCA_SCOPE");
  }
  const models: TcaModelCatalog[] = [];
  let maxHomeId: string | undefined;
  let maxDid: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    let page: TcaPage;
    try {
      const response = await request(session, SCENE_TCA_CONFIG_V3_PATH, {
        app_version: 12,
        home_data_list: [{ home_id: homeId, owner_uid: ownerUid, did: dids }],
        query_type: 1,
        with_spec: 1,
        limit: 300,
        ...(maxHomeId ? { max_home_id: maxHomeId } : {}),
        ...(maxDid ? { max_did: maxDid } : {}),
        status_filter: 1,
      });
      page = parseSceneTcaConfigV3Page(response);
    } catch (error) {
      if (pageIndex === 0) throw error;
      return mergeTcaModels(models);
    }
    models.push(...page.models);
    if (!page.hasMore) return mergeTcaModels(models);
    const nextHomeId = page.maxHomeId || undefined;
    const nextDid = page.maxDid || undefined;
    if ((!nextHomeId && !nextDid) || nextHomeId === maxHomeId && nextDid === maxDid) {
      return mergeTcaModels(models);
    }
    maxHomeId = nextHomeId;
    maxDid = nextDid;
  }
  return mergeTcaModels(models);
}

export function parseAutomationModelSceneCatalog(response: CatalogRecord, model: string): AutomationModelSceneCatalog {
  if (!identifier(model)) throw new Error("INVALID_XIAOMI_MODEL");
  const code = Number(response.code);
  if (code !== 0 || response.result !== "ok") throw new Error("XIAOMI_AUTOMATION_MODEL_CATALOG_UNAVAILABLE");
  const data = record(response.data);
  if (!data) throw new Error("XIAOMI_AUTOMATION_MODEL_CATALOG_INVALID");
  return {
    capabilities: records(data.launch).flatMap(item => {
      const parsed = parseLaunchItem(item, model, "model-catalog");
      return parsed ? [parsed] : [];
    }),
    actions: records(data.action_list).flatMap(item => {
      const parsed = parseActionItem(item, model, "model-catalog");
      return parsed ? [parsed] : [];
    }),
  };
}

export async function loadAutomationModelSceneCatalog(
  model: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomationModelSceneCatalog> {
  if (!identifier(model)) throw new Error("INVALID_XIAOMI_MODEL");
  const url = new URL(AUTOMATION_MODEL_CATALOG_URL);
  url.searchParams.set("model", model);
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`XIAOMI_AUTOMATION_MODEL_CATALOG_HTTP_${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("XIAOMI_AUTOMATION_MODEL_CATALOG_INVALID"); }
  const responseRecord = record(payload);
  if (!responseRecord) throw new Error("XIAOMI_AUTOMATION_MODEL_CATALOG_INVALID");
  return parseAutomationModelSceneCatalog(responseRecord, model);
}

function uniqueByKey<T extends { key: string }>(values: T[]) {
  return values.filter((item, index) => values.findIndex(candidate => candidate.key === item.key) === index);
}

function blockedForDid(item: CatalogRecord, did: string) {
  if (item.black_dids === undefined || item.black_dids === null) return false;
  if (!Array.isArray(item.black_dids) || item.black_dids.length > 1_000) return true;
  const blockedDids = item.black_dids.map(identifier);
  return blockedDids.some(blockedDid => !blockedDid) || blockedDids.includes(did);
}

function clientCapabilityKey(index: number) {
  return `condition-${index + 1}`;
}

function clientActionKey(index: number) {
  return `action-${index + 1}`;
}

function projectClientCapability(value: AutomationCatalogCapability, index: number): AutomationCatalogCapability {
  return {
    key: clientCapabilityKey(index),
    kind: value.kind,
    label: value.label,
    detail: value.detail,
    source: value.source,
    ...(value.siid ? { siid: value.siid } : {}),
    ...(value.piid ? { piid: value.piid } : {}),
    ...(value.eiid ? { eiid: value.eiid } : {}),
  };
}

function projectClientAction(value: AutomationCatalogAction, index: number): AutomationCatalogAction {
  return {
    key: clientActionKey(index),
    kind: value.kind,
    label: value.label,
    detail: value.detail,
    source: value.source,
    ...(value.siid ? { siid: value.siid } : {}),
    ...(value.piid ? { piid: value.piid } : {}),
    ...(value.aiid ? { aiid: value.aiid } : {}),
  };
}

async function discoverDeviceAutomationCatalogInternal(
  session: XiaomiSession,
  homeId: string,
  ownerUid: string,
  values: AutomationCatalogDeviceInput[],
  options: AutomationCatalogOptions = {},
): Promise<AutomationCatalogDevice[]> {
  const devices = values.filter(device =>
    device.homeId === homeId
    && identifier(device.key)
    && identifier(device.did)
    && identifier(device.model)
    && !parseDerivedDeviceId(device.did)
  ).filter((device, index, candidates) => candidates.findIndex(candidate => candidate.did === device.did) === index);
  if (!devices.length) return [];

  const byDid = new Map(devices.map(device => [device.did, device]));
  const conditionsByDid = new Map<string, AutomationCatalogCapability[]>();
  const actionsByDid = new Map<string, AutomationCatalogAction[]>();
  const confirmedDids = new Set<string>();
  try {
    const tcaModels = await listSceneTcaConfigV3(
      session,
      homeId,
      ownerUid,
      devices.map(device => device.did),
      options.request,
    );
    for (const item of tcaModels) {
      const candidateDids = item.dids.filter(did => byDid.get(did)?.model === item.model);
      for (const did of candidateDids) {
        confirmedDids.add(did);
        const capabilities = item.launch.flatMap(entry => {
          const parsed = !blockedForDid(entry, did) ? parseLaunchItem(entry, item.model, "tca-v3") : undefined;
          return parsed ? [parsed] : [];
        });
        const actions = item.actions.flatMap(entry => {
          const parsed = !blockedForDid(entry, did) ? parseActionItem(entry, item.model, "tca-v3") : undefined;
          return parsed ? [parsed] : [];
        });
        conditionsByDid.set(did, uniqueByKey([...(conditionsByDid.get(did) ?? []), ...capabilities]));
        actionsByDid.set(did, uniqueByKey([...(actionsByDid.get(did) ?? []), ...actions]));
      }
    }
  } catch {
    // The private directory is a discovery enhancement. Per-model discovery below is isolated.
  }

  const loadModelCatalog = options.loadModelCatalog ?? loadAutomationModelSceneCatalog;
  const fallbackModels = [...new Set(devices.filter(device => !confirmedDids.has(device.did)).map(device => device.model))];
  const modelCatalogs = new Map<string, AutomationModelSceneCatalog>();
  await Promise.all(fallbackModels.map(async model => {
    try { modelCatalogs.set(model, await loadModelCatalog(model)); } catch { /* A failed model must not hide other devices. */ }
  }));

  return devices.map(device => {
    const modelCatalog = confirmedDids.has(device.did) ? undefined : modelCatalogs.get(device.model);
    const capabilities = confirmedDids.has(device.did) ? conditionsByDid.get(device.did) ?? [] : modelCatalog?.capabilities ?? [];
    const actions = confirmedDids.has(device.did) ? actionsByDid.get(device.did) ?? [] : modelCatalog?.actions ?? [];
    return {
      key: device.key,
      deviceName: safeText(device.deviceName, device.model),
      room: safeText(device.room, "未分配"),
      capabilities: capabilities.map(projectClientCapability),
      actions,
      discovery: confirmedDids.has(device.did) ? "tca-v3" as const : modelCatalog ? "model-catalog" as const : "unavailable" as const,
    };
  });
}

export async function discoverDeviceAutomationCatalogDetails(
  session: XiaomiSession,
  homeId: string,
  ownerUid: string,
  values: AutomationCatalogDeviceInput[],
  options: AutomationCatalogOptions = {},
) {
  return discoverDeviceAutomationCatalogInternal(session, homeId, ownerUid, values, options);
}

export async function discoverDeviceAutomationCatalog(
  session: XiaomiSession,
  homeId: string,
  ownerUid: string,
  values: AutomationCatalogDeviceInput[],
  options: AutomationCatalogOptions = {},
): Promise<AutomationCatalogDevice[]> {
  const devices = await discoverDeviceAutomationCatalogInternal(session, homeId, ownerUid, values, options);
  return devices.map(device => ({ ...device, actions: device.actions.map(projectClientAction) }));
}
