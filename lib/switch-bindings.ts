import type { MiotCapabilityAction, MiotCapabilityGroup, MiotCapabilityProperty } from "./miot-spec";
import type { DeviceControlSource, DeviceTopology } from "./device-topology";

export type BindingParameterSemantic = "target-did" | "target-channel" | "source-key" | "unknown";

export type BindingActionParameter = {
  piid: number;
  name: string;
  label: string;
  format: string;
  semantic: BindingParameterSemantic;
};

export type BindingAction = MiotCapabilityAction & {
  groupSiid: number;
  groupName: string;
  parameters: BindingActionParameter[];
  targetSelectable: boolean;
  targetChannelSelectable: boolean;
  sourceKeySelectable: boolean;
  safeWithoutParameters: boolean;
};

export type SwitchBindingCapability = {
  model: string;
  status: "writable" | "readonly" | "unsupported";
  mode: "target-action" | "target-property" | "pairing" | "readonly" | "unsupported";
  properties: MiotCapabilityProperty[];
  writableProperties: MiotCapabilityProperty[];
  actions: BindingAction[];
  targetActions: BindingAction[];
  pairingActions: BindingAction[];
  targetProperties: MiotCapabilityProperty[];
};

type BindingViewDevice = {
  did?: string;
  name: string;
  kind: string;
  room?: string;
  homeId?: string;
  detail?: string;
  model?: string;
  parentId?: string | null;
  topology?: DeviceTopology | null;
};

export type SwitchBindingTarget = {
  key: string;
  name: string;
  room: string;
  did: string;
  deviceDid: string;
  channelIndex: number | null;
  channelSiid: number | null;
  controllerName: string | null;
  kind: "wired-circuit" | "smart-device";
};

const bindingPropertyPattern = /(?:^|[-_])(?:bind|binding|bound|pair|paired|pairing|link|linked|learn|mutual|target-did|target-device|control-target|current-key|max-key-count|panel-add)(?:[-_]|$)/i;
const bindingActionPattern = /(?:^|[-_])(?:bind|binding|pair|pairing|link|learn|add-key|delete-key|remove-key|clear-key|mutual)(?:[-_]|$)/i;
const targetDidPattern = /^(?:target-did|target-device-id|target-device|target-device-did|bind-did|bound-did|device-did|device-id)$/i;
const targetChannelPattern = /^(?:target-channel|target-siid|target-service|target-service-id|target-key|target-button|target-channel-index)$/i;
const sourceKeyPattern = /^(?:current-key|source-key|source-button|source-channel|key-index|key-id|button-index|button-id)$/i;
const addBindingActionPattern = /(?:^|[-_])(?:bind|add|pair|link)(?:[-_]|$)/i;
const pairingActionPattern = /(?:^|[-_])(?:learn|pair)(?:[-_]|$)/i;

function parameterSemantic(property: MiotCapabilityProperty | undefined): BindingParameterSemantic {
  if (!property) return "unknown";
  if (targetDidPattern.test(property.name)) return "target-did";
  if (targetChannelPattern.test(property.name)) return "target-channel";
  if (sourceKeyPattern.test(property.name)) return "source-key";
  return "unknown";
}

function classifyAction(group: MiotCapabilityGroup, action: MiotCapabilityAction): BindingAction {
  const parameters = action.inputs.map(piid => {
    const property = group.properties.find(item => item.piid === piid);
    return {
      piid,
      name: property?.name ?? `property-${piid}`,
      label: property?.label ?? `参数 ${piid}`,
      format: property?.format ?? "unknown",
      semantic: parameterSemantic(property),
    };
  });
  const known = parameters.every(parameter => parameter.semantic !== "unknown");
  return {
    ...action,
    groupSiid: group.siid,
    groupName: group.name,
    parameters,
    targetSelectable: known && parameters.some(parameter => parameter.semantic === "target-did"),
    targetChannelSelectable: known && parameters.some(parameter => parameter.semantic === "target-channel"),
    sourceKeySelectable: known && parameters.some(parameter => parameter.semantic === "source-key"),
    safeWithoutParameters: parameters.length === 0,
  };
}

export function analyzeSwitchBindingCapabilities(model: string, groups: MiotCapabilityGroup[]): SwitchBindingCapability {
  const properties = groups.flatMap(group => group.properties.filter(property => bindingPropertyPattern.test(property.name)));
  const writableProperties = properties.filter(property => property.writable);
  const targetProperties = writableProperties.filter(property => targetDidPattern.test(property.name) && property.format === "string");
  const actions = groups.flatMap(group => group.actions.filter(action => bindingActionPattern.test(action.name)).map(action => classifyAction(group, action)));
  const targetActions = actions.filter(action => addBindingActionPattern.test(action.name) && action.targetSelectable);
  const pairingActions = actions.filter(action => pairingActionPattern.test(action.name) && action.safeWithoutParameters);

  let status: SwitchBindingCapability["status"] = "unsupported";
  let mode: SwitchBindingCapability["mode"] = "unsupported";
  if (targetActions.length) { status = "writable"; mode = "target-action"; }
  else if (targetProperties.length) { status = "writable"; mode = "target-property"; }
  else if (writableProperties.length || actions.length) { status = "writable"; mode = "pairing"; }
  else if (properties.some(property => property.readable)) { status = "readonly"; mode = "readonly"; }

  return { model, status, mode, properties, writableProperties, actions, targetActions, pairingActions, targetProperties };
}

export function listSwitchBindingTargets<T extends BindingViewDevice>(source: T, devices: T[]): SwitchBindingTarget[] {
  const targets = new Map<string, SwitchBindingTarget>();
  for (const device of devices) {
    if (!device.did || device.did === source.did || device.homeId && source.homeId && device.homeId !== source.homeId) continue;
    if (device.kind !== "light" && device.kind !== "lamp") continue;
    const model = (device.detail ?? device.model ?? "").toLowerCase();
    const virtualModel = /(switch|relay|channel|gang|virtual)/.test(model) && !/(light|lamp|strip|bulb)/.test(model);
    if (!(device.topology?.relation === "mapped" && device.parentId) && !virtualModel) {
      const key = `${device.homeId ?? ""}:${device.room ?? ""}:${device.name}`;
      if (!targets.has(key)) targets.set(key, { key, name: device.name, room: device.room ?? "未分配", did: device.did, deviceDid: device.did, channelIndex: null, channelSiid: null, controllerName: null, kind: "smart-device" });
      continue;
    }
    const controllerId = device.parentId ?? device.topology?.parentId;
    if (!controllerId) continue;
    const controller = devices.find(candidate => candidate.did === controllerId);
    if (!controller) continue;
    const channelIndex = device.topology?.channelIndex ?? null;
    const channelSiid = device.topology?.channelSiid ?? null;
    if (channelIndex === null && channelSiid === null) continue;
    const key = `${device.homeId ?? ""}:${device.room ?? ""}:${device.name}:${controllerId}:${channelSiid ?? channelIndex}`;
    if (!targets.has(key)) targets.set(key, { key, name: device.name, room: device.room ?? "未分配", did: controllerId, deviceDid: device.did, channelIndex, channelSiid, controllerName: controller.name, kind: "wired-circuit" });
  }
  return [...targets.values()].sort((left, right) => left.room.localeCompare(right.room, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"));
}

export function listVisibleControlSources(sources: DeviceControlSource[]): DeviceControlSource[] {
  const unique = new Map<string, DeviceControlSource>();
  for (const source of sources) {
    const key = `${source.sourceId}:${source.channelIndex}:${source.channelSiid}:${source.connectionType}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()].sort((left, right) => Number(left.connectionType !== "wired") - Number(right.connectionType !== "wired") || left.sourceName.localeCompare(right.sourceName, "zh-CN") || (left.channelIndex ?? left.channelSiid ?? 0) - (right.channelIndex ?? right.channelSiid ?? 0));
}

export function buildBindingActionParameters(action: BindingAction, target: SwitchBindingTarget, sourceKey: number): Array<string | number> {
  if (!action.targetSelectable) throw new Error("BINDING_ACTION_TARGET_UNSUPPORTED");
  if (target.kind === "wired-circuit" && !action.targetChannelSelectable) throw new Error("BINDING_ACTION_CHANNEL_UNSUPPORTED");
  return action.parameters.map(parameter => {
    if (parameter.semantic === "target-did") return target.did;
    if (parameter.semantic === "source-key") return sourceKey;
    if (parameter.semantic === "target-channel") {
      const value = /siid|service/i.test(parameter.name) ? target.channelSiid : target.channelIndex ?? target.channelSiid;
      if (value === null) throw new Error("BINDING_ACTION_CHANNEL_MISSING");
      return value;
    }
    throw new Error("BINDING_ACTION_PARAMETERS_UNKNOWN");
  });
}
