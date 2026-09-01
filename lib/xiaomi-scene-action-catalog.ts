import { parseDerivedDeviceId } from "./device-topology.ts";
import { getMiotCapabilities, type MiotCapabilityGroup } from "./miot-spec.ts";
import {
  discoverDeviceAutomationCatalogDetails,
  type AutomationCatalogAction,
  type AutomationCatalogDevice,
  type AutomationCatalogOptions,
} from "./xiaomi-automation-catalog.ts";
import type { XiaomiSession } from "./xiaomi-cloud.ts";
import { isScenePropertyValueSupported, isSceneWritableProperty } from "./xiaomi-scene-properties.ts";
import type { SceneDraftAction, SceneValue } from "./xiaomi-scene-editor.ts";

export type SceneActionCatalogSource = "tca-v3" | "model-catalog" | "miot-spec" | "unavailable";

export type SceneActionCatalogProperty = {
  siid: number;
  piid: number;
  name: string;
  label: string;
  format: string;
  configurable: boolean;
  value?: SceneValue;
  unit?: string;
  choices?: Array<{ value: SceneValue; label: string }>;
  range?: { min: number; max: number; step: number };
};

export type SceneActionCatalogTemplate = {
  key: string;
  kind: "set-properties" | "invoke-action";
  label: string;
  detail: string;
  source: Exclude<SceneActionCatalogSource, "unavailable">;
  serviceLabel: string;
  properties?: SceneActionCatalogProperty[];
  siid?: number;
  aiid?: number;
  sceneActionId?: number;
};

export type SceneActionCatalogDevice = {
  did: string;
  model: string;
  deviceName: string;
  room: string;
  source: SceneActionCatalogSource;
  actions: SceneActionCatalogTemplate[];
  discoveredActionCount?: number;
  excludedActionCount?: number;
  error?: string;
};

type DeviceRecord = Record<string, unknown>;
type Specification = Awaited<ReturnType<typeof getMiotCapabilities>>;

type SceneActionCatalogOptions = AutomationCatalogOptions & {
  loadCapabilities?: typeof getMiotCapabilities;
};

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function deviceHomeId(device: DeviceRecord) {
  return text(device.homeId ?? device.home_id);
}

function deviceUrn(device: DeviceRecord) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

function defaultValue(property: MiotCapabilityGroup["properties"][number]): SceneValue {
  if (property.choices?.length) return property.choices[0].value;
  if (property.format === "bool") return true;
  if (property.range) return property.range.min;
  return property.format === "string" ? "" : 0;
}

function propertyDescriptor(
  group: MiotCapabilityGroup,
  property: MiotCapabilityGroup["properties"][number],
  configurable: boolean,
  value?: SceneValue,
): SceneActionCatalogProperty {
  return {
    siid: property.siid,
    piid: property.piid,
    name: property.name,
    label: property.sourceLabel || property.name,
    format: property.format,
    configurable,
    ...(value !== undefined ? { value } : {}),
    ...(property.unit ? { unit: property.unit } : {}),
    ...(property.choices?.length ? { choices: property.choices.map(choice => ({ value: choice.value, label: choice.sourceLabel || String(choice.value) })) } : {}),
    ...(property.range ? { range: property.range } : {}),
  };
}

function exactProperty(groups: MiotCapabilityGroup[], siid: number, piid: number) {
  const group = groups.find(item => item.siid === siid);
  const property = group?.properties.find(item => item.piid === piid);
  return group && property ? { group, property } : undefined;
}

function catalogProperties(action: AutomationCatalogAction) {
  if (action.properties?.length) return action.properties;
  return action.siid && action.piid && action.value !== undefined
    ? [{ siid: action.siid, piid: action.piid, value: action.value }]
    : [];
}

function officialTemplates(device: AutomationCatalogDevice, specification: Specification) {
  return device.actions.flatMap((action, index): SceneActionCatalogTemplate[] => {
    const key = `action-${index + 1}`;
    const rawId = Number(action.key.split(":").pop());
    const sceneActionId = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : undefined;
    if (action.kind === "set-property" || action.kind === "set-properties") {
      const requested = catalogProperties(action);
      if (!requested.length) return [];
      const properties = requested.flatMap(item => {
        const found = exactProperty(specification.groups, item.siid, item.piid);
        if (!found || !isSceneWritableProperty(found.group.name, found.property) || !isScenePropertyValueSupported(found.property, item.value)) return [];
        return [propertyDescriptor(found.group, found.property, false, item.value)];
      });
      if (properties.length !== requested.length) return [];
      const first = exactProperty(specification.groups, requested[0].siid, requested[0].piid);
      return [{
        key,
        kind: "set-properties",
        label: action.label,
        detail: action.detail,
        source: action.source,
        serviceLabel: first?.group.sourceLabel || first?.group.name || specification.description,
        properties,
        ...(sceneActionId ? { sceneActionId } : {}),
      }];
    }
    if (action.kind !== "action" || !action.siid || !action.aiid || action.inputCount !== 0) return [];
    const group = specification.groups.find(item => item.siid === action.siid);
    const capability = group?.actions.find(item => item.aiid === action.aiid);
    if (!group || !capability || capability.inputs.length) return [];
    return [{
      key,
      kind: "invoke-action",
      label: action.label,
      detail: action.detail,
      source: action.source,
      serviceLabel: group.sourceLabel || group.name,
      siid: action.siid,
      aiid: action.aiid,
      ...(sceneActionId ? { sceneActionId } : {}),
    }];
  });
}

function miotTemplates(specification: Specification) {
  const actions: SceneActionCatalogTemplate[] = [];
  for (const group of specification.groups) {
    for (const property of group.properties) {
      if (!isSceneWritableProperty(group.name, property)) continue;
      actions.push({
        key: `action-${actions.length + 1}`,
        kind: "set-properties",
        label: property.sourceLabel || property.name,
        detail: group.sourceLabel || group.name,
        source: "miot-spec",
        serviceLabel: group.sourceLabel || group.name,
        properties: [propertyDescriptor(group, property, true, defaultValue(property))],
      });
    }
    for (const action of group.actions) {
      if (action.inputs.length) continue;
      actions.push({
        key: `action-${actions.length + 1}`,
        kind: "invoke-action",
        label: action.sourceLabel || action.name,
        detail: group.sourceLabel || group.name,
        source: "miot-spec",
        serviceLabel: group.sourceLabel || group.name,
        siid: action.siid,
        aiid: action.aiid,
      });
    }
  }
  return actions;
}

export async function loadSceneActionCatalog(
  session: XiaomiSession,
  homeId: string,
  ownerUid: string,
  records: DeviceRecord[],
  options: SceneActionCatalogOptions = {},
): Promise<SceneActionCatalogDevice[]> {
  const devices = records.filter(device => deviceHomeId(device) === homeId && text(device.did) && text(device.model) && !parseDerivedDeviceId(text(device.did)))
    .filter((device, index, values) => values.findIndex(candidate => text(candidate.did) === text(device.did)) === index);
  const inputs = devices.map((device, index) => ({
    key: `device-${index + 1}`,
    homeId,
    did: text(device.did),
    model: text(device.model),
    deviceName: text(device.name) || text(device.model),
    room: text(device.roomName ?? device.room_name) || "未分配",
  }));
  const discovered = await discoverDeviceAutomationCatalogDetails(session, homeId, ownerUid, inputs, options);
  const discoveredByKey = new Map(discovered.map(device => [device.key, device]));
  const loadCapabilities = options.loadCapabilities ?? getMiotCapabilities;
  const specifications = new Map<string, Promise<Specification>>();
  return Promise.all(devices.map(async (device, index): Promise<SceneActionCatalogDevice> => {
    const input = inputs[index];
    const urn = deviceUrn(device);
    const specificationKey = `${input.model}:${urn ?? ""}`;
    if (!specifications.has(specificationKey)) specifications.set(specificationKey, loadCapabilities(input.model, urn));
    let specification: Specification;
    try { specification = await specifications.get(specificationKey)!; }
    catch {
      return { did: input.did, model: input.model, deviceName: input.deviceName, room: input.room, source: "unavailable", actions: [], error: "MIOT_SPEC_UNAVAILABLE" };
    }
    const official = discoveredByKey.get(input.key);
    const source = official?.discovery ?? "unavailable";
    const actions = source === "unavailable" ? miotTemplates(specification) : officialTemplates(official!, specification);
    const discoveredActionCount = source === "unavailable" ? actions.length : official!.actions.length;
    return { did: input.did, model: input.model, deviceName: input.deviceName, room: input.room, source: source === "unavailable" ? "miot-spec" : source, actions, discoveredActionCount, excludedActionCount: Math.max(0, discoveredActionCount-actions.length) };
  }));
}

function sameValue(left: SceneValue | undefined, right: SceneValue | undefined) {
  return typeof left === typeof right && left === right;
}

export function sceneCatalogTemplateSupportsAction(template: SceneActionCatalogTemplate, action: SceneDraftAction) {
  if (template.kind !== action.kind) return false;
  if (action.kind === "invoke-action") return template.siid === action.siid && template.aiid === action.aiid;
  if (!template.properties?.length || template.properties.length !== action.properties?.length) return false;
  return template.properties.every((property, index) => {
    const requested = action.properties?.[index];
    if (!requested || requested.siid !== property.siid || requested.piid !== property.piid) return false;
    if (!property.configurable && !sameValue(property.value, requested.value)) return false;
    const capability = { name: property.name, format: property.format, readable: true, writable: true, ...(property.choices ? { choices: property.choices } : {}), ...(property.range ? { range: property.range } : {}) };
    return isScenePropertyValueSupported(capability, requested.value);
  });
}
