import type { DeviceControlChannel, DeviceControlSource, DeviceTopology } from "./device-topology";

export type ManagedHardwareRole = "controller" | "switch" | "device";

export type ManagedDevice = {
  id: number;
  did?: string;
  name: string;
  home: string;
  homeId: string;
  room: string;
  kind: string;
  icon: string;
  on: boolean;
  status: string;
  detail: string;
  color: string;
  online?: boolean;
  parentId?: string | null;
  urn?: string | null;
  logicalType?: string;
  hardwareRole?: ManagedHardwareRole;
  topology?: DeviceTopology | null;
  virtual?: boolean;
  members?: ManagedDevice[];
  groupMemberIds?: string[];
  groupIds?: string[];
  groupMembers?: ManagedDevice[];
};

export type ManagedDeviceCategory = "smart-light" | "controller" | "switch" | "voice-alias" | "wired-load" | "group" | "other";

export type ManagedDeviceRecord<T extends ManagedDevice = ManagedDevice> = {
  device: T;
  category: ManagedDeviceCategory;
  owner?: T;
  groupMembers: T[];
};

export type LightingControl<T extends ManagedDevice = ManagedDevice> = {
  device: T;
  connection: "wired" | "wireless";
  channelIndex: number | null;
  channelSiid: number | null;
  inferred: boolean;
};

export type LightingTopology<T extends ManagedDevice = ManagedDevice> = {
  key: string;
  name: string;
  homeId: string;
  room: string;
  lights: T[];
  loads: T[];
  aliases: T[];
  controls: LightingControl<T>[];
};

export type DeviceManagementModel<T extends ManagedDevice = ManagedDevice> = {
  records: ManagedDeviceRecord<T>[];
  topologies: LightingTopology<T>[];
  totals: { devices: number; lights: number; switches: number; aliases: number; groups: number };
};

const switchName = /开关|面板|副控|主控|中控|中枢|网关|家庭屏|智能屏|控制屏|触控屏|遥控|控制器|[单双三四五六]开/;
const lightName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;
const voiceRoom = /勿关|勿删|语音|隐藏/;

function groupId(did: string | undefined) {
  return Boolean(did && /^group/i.test(did));
}

function physicalId(did: string | undefined | null) {
  const value = did?.trim() ?? "";
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return value;
  const prefix = value.slice(0, separator);
  const segments = value.split(".");
  if (segments.length === 2 && /^[a-z]+$/i.test(prefix)) return value;
  if (segments.length === 3 && /^blt$/i.test(segments[0]) && /^\d+$/.test(segments[1])) return value;
  return prefix;
}

function samePhysicalId(left: string | undefined | null, right: string | undefined | null) {
  return Boolean(left && right && physicalId(left) === physicalId(right));
}

function normalizedName(value: string) {
  return value.trim().replace(/[\s\u3000·•_\-]+/g, "").toLocaleLowerCase();
}

function controlHardware(device: ManagedDevice) {
  if (groupId(device.did)) return false;
  if (device.hardwareRole === "controller" || device.hardwareRole === "switch") return true;
  if (["primary", "secondary-panel"].includes(device.topology?.role ?? "")) return true;
  if (switchName.test(device.name)) return true;
  return /(?:^|[._-])(?:switch|panel|remote|controller|gateway|screen|hub)(?:[._-]|$)/i.test(device.detail);
}

function matchingChannel(channel: DeviceControlChannel, target: ManagedDevice) {
  return channel.targets.some(candidate => candidate.id === target.did
    || samePhysicalId(candidate.id, target.did) && normalizedName(candidate.name) === normalizedName(target.name));
}

function controllerPriority(device: ManagedDevice) {
  return Number(switchName.test(device.name)) * 4
    + Number(device.hardwareRole === "controller" || device.hardwareRole === "switch") * 2
    + Number(Boolean(device.topology?.channels.length));
}

function resolveController<T extends ManagedDevice>(controllers: T[], did: string | undefined | null, excluded?: T) {
  if (!did) return;
  const exact = controllers.filter(device => device !== excluded && device.did === did);
  if (exact.length) return exact.sort((left, right) => controllerPriority(right) - controllerPriority(left))[0];
  const physical = controllers.filter(device => device !== excluded && (samePhysicalId(device.did, did)
    || Boolean(device.did && did.startsWith(`${device.did}.`))));
  return physical.sort((left, right) => (right.did?.length ?? 0) - (left.did?.length ?? 0)
    || controllerPriority(right) - controllerPriority(left))[0];
}

function ownerFor<T extends ManagedDevice>(device: T, controllers: T[]) {
  const parent = resolveController(controllers, device.parentId ?? device.topology?.parentId, device);
  if (parent) return parent;
  if (!device.did) return;
  const matching = controllers.filter(candidate => candidate !== device && candidate.homeId === device.homeId && candidate.did
    && (device.did!.startsWith(`${candidate.did}.`) || samePhysicalId(candidate.did, device.did)));
  return matching.sort((left, right) => (right.did?.length ?? 0) - (left.did?.length ?? 0)
    || controllerPriority(right) - controllerPriority(left))[0];
}

function isVoiceAlias(device: ManagedDevice, owner: ManagedDevice | undefined) {
  if (!owner || !device.did || !owner.did || device.did === owner.did) return false;
  if (!samePhysicalId(device.did, owner.did) && !device.did.startsWith(`${owner.did}.`)) return false;
  if (voiceRoom.test(device.room)) return true;
  if (owner.topology?.role === "secondary-panel" || owner.topology?.connectionType === "wireless") return true;
  if (device.topology?.connectionType === "wireless" || device.topology?.controlledBy.some(source => source.connectionType === "wireless")) return true;
  return (owner.topology?.channels ?? []).some(channel => channel.connectionType === "wireless"
    && channel.targets.some(target => normalizedName(target.name) === normalizedName(device.name)));
}

function recordCategory(device: ManagedDevice, owner: ManagedDevice | undefined): ManagedDeviceCategory {
  if (groupId(device.did)) return "group";
  if (isVoiceAlias(device, owner)) return "voice-alias";
  const lighting = device.kind === "light" || device.kind === "lamp" || lightName.test(device.name);
  if (lighting && !switchName.test(device.name)) {
    const mapped = device.topology?.relation === "mapped"
      || /(?:^|[._-])(?:switch|relay|virtual|split|channel)(?:[._-]|$)/i.test(device.detail)
      || device.hardwareRole === "controller" || device.hardwareRole === "switch";
    return mapped ? "wired-load" : "smart-light";
  }
  if (controlHardware(device)) return device.hardwareRole === "controller" || /中控|中枢|网关|屏/.test(device.name) ? "controller" : "switch";
  return "other";
}

function addControl<T extends ManagedDevice>(topology: LightingTopology<T>, device: T | undefined, connection: "wired" | "wireless", channelIndex: number | null = null, channelSiid: number | null = null, inferred = false) {
  if (!device) return;
  const exists = topology.controls.find(control => control.device.did === device.did
    && control.connection === connection && control.channelIndex === channelIndex && control.channelSiid === channelSiid);
  if (!exists) topology.controls.push({ device, connection, channelIndex, channelSiid, inferred });
}

function sourceController<T extends ManagedDevice>(source: DeviceControlSource, controllers: T[]) {
  return resolveController(controllers, source.sourceId);
}

function targetRoom<T extends ManagedDevice>(record: ManagedDeviceRecord<T>, controllers: T[]) {
  if (record.category === "smart-light") return record.device.room;
  const source = record.device.topology?.controlledBy.find(item => item.connectionType === "wired");
  const wired = source ? sourceController(source, controllers) : undefined;
  if (wired) return wired.room;
  if (record.owner && record.owner.topology?.role !== "secondary-panel") return record.owner.room;
  const sourceChannel = controllers.find(controller => (controller.topology?.channels ?? []).some(channel => channel.connectionType !== "wireless" && matchingChannel(channel, record.device)));
  return sourceChannel?.room ?? record.device.room;
}

function attachPublishedControls<T extends ManagedDevice>(topology: LightingTopology<T>, target: T, controllers: T[]) {
  for (const source of target.topology?.controlledBy ?? []) addControl(topology, sourceController(source, controllers), source.connectionType, source.channelIndex, source.channelSiid);
  for (const controller of controllers) {
    for (const channel of controller.topology?.channels ?? []) {
      if (!matchingChannel(channel, target)) continue;
      const connection = channel.connectionType === "wireless" || channel.connectionType === "mixed" && channel.role === "secondary" ? "wireless" : "wired";
      addControl(topology, controller, connection, channel.channelIndex, channel.channelSiid);
    }
  }
}

export function buildDeviceManagementModel<T extends ManagedDevice>(devices: T[]): DeviceManagementModel<T> {
  const controllers = devices.filter(controlHardware);
  const records = devices.map(device => {
    const owner = ownerFor(device, controllers);
    const category = recordCategory(device, owner);
    const groupMembers = category === "group" ? (device.groupMemberIds ?? [])
      .map(did => devices.find(candidate => candidate.homeId === device.homeId && candidate.did === did))
      .filter((candidate): candidate is T => Boolean(candidate)) : [];
    return { device, category, owner, groupMembers };
  });

  const claimed = new Set(records.filter(record => record.category === "group")
    .flatMap(record => record.groupMembers.map(member => `${member.homeId}:${member.did}`)));
  const visible = records.filter(record => record.category === "group"
    || !record.device.did || !claimed.has(`${record.device.homeId}:${record.device.did}`));

  const groups = new Map<string, LightingTopology<T>>();
  for (const record of records) {
    if (record.category !== "smart-light" && record.category !== "wired-load") continue;
    const room = targetRoom(record, controllers);
    const key = `${record.device.homeId}:${room}:${normalizedName(record.device.name)}`;
    const topology = groups.get(key) ?? { key, name: record.device.name, homeId: record.device.homeId, room, lights: [], loads: [], aliases: [], controls: [] };
    if (record.category === "smart-light") topology.lights.push(record.device);
    else topology.loads.push(record.device);
    attachPublishedControls(topology, record.device, controllers);
    if (record.category === "wired-load" && !topology.controls.some(control => control.connection === "wired")) {
      addControl(topology, record.owner ?? (controlHardware(record.device) ? record.device : undefined), "wired", record.device.topology?.channelIndex ?? null, record.device.topology?.channelSiid ?? null, true);
    }
    groups.set(key, topology);
  }

  for (const record of records) {
    if (record.category !== "voice-alias") continue;
    const matching = [...groups.values()].filter(topology => topology.homeId === record.device.homeId
      && normalizedName(topology.name) === normalizedName(record.device.name));
    const explicit = matching.filter(topology => (record.owner?.topology?.channels ?? []).some(channel => channel.targets.some(target => [...topology.lights, ...topology.loads].some(device => target.id === device.did))));
    const candidate = explicit[0] ?? matching.find(topology => topology.room === record.owner?.room)
      ?? matching.find(topology => topology.room === record.device.room);
    const room = candidate?.room ?? record.owner?.room ?? record.device.room;
    const key = candidate?.key ?? `${record.device.homeId}:${room}:${normalizedName(record.device.name)}`;
    const topology = candidate ?? { key, name: record.device.name, homeId: record.device.homeId, room, lights: [], loads: [], aliases: [], controls: [] };
    topology.aliases.push(record.device);
    const channel = (record.owner?.topology?.channels ?? []).find(item => item.connectionType === "wireless"
      && item.targets.some(target => normalizedName(target.name) === normalizedName(record.device.name)));
    addControl(topology, record.owner, "wireless", channel?.channelIndex ?? record.device.topology?.channelIndex ?? null, channel?.channelSiid ?? record.device.topology?.channelSiid ?? null, !channel);
    groups.set(key, topology);
  }

  const topologies = [...groups.values()].sort((left, right) => left.room.localeCompare(right.room, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"));
  for (const topology of topologies) topology.controls.sort((left, right) => Number(left.connection !== "wired") - Number(right.connection !== "wired") || left.device.name.localeCompare(right.device.name, "zh-CN"));

  return {
    records: visible,
    topologies,
    totals: {
      devices: visible.length,
      lights: records.filter(record => record.category === "smart-light" || record.category === "wired-load").length,
      switches: records.filter(record => record.category === "switch" || record.category === "controller").length,
      aliases: records.filter(record => record.category === "voice-alias").length,
      groups: records.filter(record => record.category === "group").length,
    },
  };
}
