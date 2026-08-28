import type { ManagedDevice } from "./device-management.ts";
import type { SceneEditorDraft } from "./xiaomi-scene-editor.ts";
import type { ManualSceneAction } from "./xiaomi-scenes.ts";

export type ManualSceneActionItem =
  | { kind: "action"; action: ManualSceneAction }
  | { kind: "light-batch"; state?: "on" | "off"; actions: ManualSceneAction[]; deviceNames: string[] };

export type ManualSceneActionRoom = {
  room: string;
  items: ManualSceneActionItem[];
  actionCount: number;
};

export type ManualSceneActionGroup = {
  key: string;
  label: string;
  rooms: ManualSceneActionRoom[];
  actionCount: number;
};

export type SceneDraftActionItem = {
  indices: number[];
  actions: SceneEditorDraft["actions"];
  collapsible: boolean;
  state?: "on" | "off";
};

export type SceneDraftActionRoom = {
  room: string;
  items: SceneDraftActionItem[];
  actionCount: number;
};

export type SceneDraftActionGroup = {
  key: string;
  label: string;
  rooms: SceneDraftActionRoom[];
  actionCount: number;
};

type DeviceIdentity = Pick<ManagedDevice, "did" | "name" | "room" | "kind" | "topology">;

const unassignedRoom = "未分配";

function isLight(device: DeviceIdentity | undefined) {
  return device?.kind === "light" || device?.kind === "lamp";
}

function uniqueDeviceByName(devices: DeviceIdentity[]) {
  const matches = new Map<string, DeviceIdentity | undefined>();
  for (const device of devices) {
    if (!device.name) continue;
    if (!matches.has(device.name)) matches.set(device.name, device);
    else matches.set(device.name, undefined);
  }
  return matches;
}

function manualPowerState(action: ManualSceneAction) {
  const detail = action.details[0];
  return action.details.length === 1 && detail?.kind === "power" && detail.state ? detail.state : undefined;
}

function valueKey(value: unknown) {
  return `${typeof value}:${String(value)}`;
}

function manualActionSignature(action: ManualSceneAction) {
  if (!action.details.length) return undefined;
  return action.details.map(detail => `${detail.kind}:${detail.label}:${detail.state ?? ""}:${detail.value}`).sort().join("|");
}

function draftActionSignature(action: SceneEditorDraft["actions"][number]) {
  if (action.kind !== "set-properties" || !action.properties?.length) return undefined;
  return action.properties.map(property => `${property.label || `${property.siid}.${property.piid}`}:${valueKey(property.value)}`).sort().join("|");
}

function manualActionLabel(action: ManualSceneAction) {
  return action.details.length ? action.details.map(detail => detail.kind === "power" ? detail.value : `${detail.label} ${detail.value}`).join(" · ") : action.label;
}

function switchChannelIdentity(device: DeviceIdentity | undefined) {
  const topology = device?.topology;
  if (!topology || topology.relation !== "mapped" || topology.channelSiid === null) return undefined;
  const channel = topology.channelIndex === null ? topology.channelLabel || `服务 ${topology.channelSiid}` : `按键 ${topology.channelIndex}`;
  return topology.parentName ? `${topology.parentName} · ${channel}` : channel;
}

function draftValueLabel(value: unknown) {
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return String(value);
}

function draftActionLabel(action: SceneEditorDraft["actions"][number]) {
  if (action.kind !== "set-properties" || !action.properties?.length) return action.label;
  return action.properties.map(property => typeof property.value === "boolean" && /^(?:开关|电源)$/.test(property.label ?? "") ? draftValueLabel(property.value) : `${property.label || `属性 ${property.siid}.${property.piid}`} ${draftValueLabel(property.value)}`).join(" · ");
}

function draftPowerState(action: SceneEditorDraft["actions"][number]): "on" | "off" | undefined {
  if (action.kind !== "set-properties" || action.properties?.length !== 1) return undefined;
  const property = action.properties[0];
  return property?.piid === 1 && typeof property.value === "boolean" ? (property.value ? "on" as const : "off" as const) : undefined;
}

function roomOrder(rooms: string[]) {
  return rooms.sort((left, right) => {
    if (left === unassignedRoom) return 1;
    if (right === unassignedRoom) return -1;
    return left.localeCompare(right, "zh-CN");
  });
}

export function groupManualSceneActions(actions: ManualSceneAction[], devices: DeviceIdentity[]): ManualSceneActionGroup[] {
  const byName = uniqueDeviceByName(devices);
  const entries = actions.map((action, index) => {
    const sameRoomMatches = action.deviceName && action.room ? devices.filter(device => device.name === action.deviceName && device.room === action.room) : [];
    const device = sameRoomMatches.length === 1 ? sameRoomMatches[0] : action.deviceName ? byName.get(action.deviceName) : undefined;
    const signature = manualActionSignature(action);
    const channel = switchChannelIdentity(device);
    const displayAction = channel && action.deviceName ? { ...action, deviceName: `${channel} · ${action.deviceName}` } : action;
    return { action: displayAction, device, room: action.room || device?.room || unassignedRoom, state: manualPowerState(action), signature, channel, groupKey: signature ?? `action:${index}`, label: manualActionLabel(action) };
  });
  return Array.from(new Set(entries.map(entry => entry.groupKey))).map(groupKey => {
    const groupEntries = entries.filter(entry => entry.groupKey === groupKey);
    const rooms = roomOrder(Array.from(new Set(groupEntries.map(entry => entry.room)))).map(room => {
      const roomEntries = groupEntries.filter(entry => entry.room === room);
      const consumed = new Set<ManualSceneAction>();
      const items: ManualSceneActionItem[] = [];
      for (const entry of roomEntries) {
        if (consumed.has(entry.action)) continue;
        if (isLight(entry.device) && entry.signature && !entry.channel) {
          const matches = roomEntries.filter(candidate => !consumed.has(candidate.action) && isLight(candidate.device) && !candidate.channel);
          if (matches.length > 1 && new Set(matches.map(match => match.action.deviceName)).size === matches.length) {
            matches.forEach(match => consumed.add(match.action));
            items.push({ kind: "light-batch", ...(entry.state ? { state: entry.state } : {}), actions: matches.map(match => match.action), deviceNames: matches.map(match => match.action.deviceName ?? match.action.label) });
            continue;
          }
        }
        consumed.add(entry.action);
        items.push({ kind: "action", action: entry.action });
      }
      return { room, items, actionCount: roomEntries.length };
    });
    return { key: groupKey, label: groupEntries[0]?.label ?? "其他动作", rooms, actionCount: groupEntries.length };
  });
}

export function groupSceneDraftActions(actions: SceneEditorDraft["actions"], devices: DeviceIdentity[]): SceneDraftActionGroup[] {
  const byDid = new Map(devices.flatMap(device => device.did ? [[device.did, device] as const] : []));
  const entries = actions.map((action, index) => {
    const device = action.kind === "unsupported" ? undefined : byDid.get(action.did);
    const signature = draftActionSignature(action);
    return { action, index, device, room: device?.room || unassignedRoom, state: draftPowerState(action), signature, groupKey: signature ?? `action:${index}`, label: draftActionLabel(action) };
  });
  return Array.from(new Set(entries.map(entry => entry.groupKey))).map(groupKey => {
    const groupEntries = entries.filter(entry => entry.groupKey === groupKey);
    const rooms = roomOrder(Array.from(new Set(groupEntries.map(entry => entry.room)))).map(room => {
      const roomEntries = groupEntries.filter(entry => entry.room === room);
      const consumed = new Set<number>();
      const items: SceneDraftActionItem[] = [];
      for (const entry of roomEntries) {
        if (consumed.has(entry.index)) continue;
        if (isLight(entry.device) && entry.signature) {
          const matches = roomEntries.filter(candidate => !consumed.has(candidate.index) && isLight(candidate.device));
          if (matches.length > 1 && new Set(matches.map(match => match.action.kind === "unsupported" ? "" : match.action.did)).size === matches.length) {
            matches.forEach(match => consumed.add(match.index));
            items.push({ indices: matches.map(match => match.index), actions: matches.map(match => match.action), collapsible: true, state: entry.state });
            continue;
          }
        }
        consumed.add(entry.index);
        items.push({ indices: [entry.index], actions: [entry.action], collapsible: false, ...(entry.state ? { state: entry.state } : {}) });
      }
      return { room, items, actionCount: roomEntries.length };
    });
    return { key: groupKey, label: groupEntries[0]?.label ?? "其他动作", rooms, actionCount: groupEntries.length };
  });
}
