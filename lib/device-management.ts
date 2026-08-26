import { parseDerivedDeviceId, type DeviceConnection, type DeviceControlChannel, type DeviceTopology } from "./device-topology.ts";

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
  endpoint?: T;
  connection: DeviceConnection;
  relationship: "relay-load" | "wireless-secondary" | "smart-device-power" | "unknown";
  channelIndex: number | null;
  channelSiid: number | null;
  inferred: boolean;
};

export type LightingTopologyKind = "ordinary-load" | "smart-light" | "smart-light-group" | "unknown";

export type LightingTopology<T extends ManagedDevice = ManagedDevice> = {
  key: string;
  name: string;
  homeId: string;
  room: string;
  kind: LightingTopologyKind;
  lights: T[];
  loads: T[];
  aliases: T[];
  controls: LightingControl<T>[];
  on: boolean | null;
  online: boolean | null;
  stateSource: "smart-device" | "wired-endpoint" | "unknown";
  unresolved: boolean;
};

export type DeviceManagementModel<T extends ManagedDevice = ManagedDevice> = {
  records: ManagedDeviceRecord<T>[];
  endpoints: ManagedDeviceRecord<T>[];
  topologies: LightingTopology<T>[];
  totals: { devices: number; lights: number; switches: number; aliases: number; groups: number };
};

const hiddenRoom = /勿关|勿删|语音|隐藏/;
const lightName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;

function groupId(did: string | undefined) {
  return Boolean(did && /^group\./i.test(did));
}

function normalizedName(value: string) {
  return value.trim().replace(/[\s\u3000·•_\-]+/g, "").toLocaleLowerCase();
}

function targetName(value: string) {
  return normalizedName(value).replace(/副控.*$/, "").replace(/副控/g, "").replace(/电源$/, "");
}

function displayTargetName(value: string) {
  return value.trim().replace(/副控.*$/, "").replace(/副控/g, "").replace(/电源$/, "") || value;
}

function isDerivedEndpoint(device: ManagedDevice) {
  return Boolean(device.did && parseDerivedDeviceId(device.did) && device.topology?.relation === "mapped" && device.parentId);
}

function controlHardware(device: ManagedDevice) {
  if (groupId(device.did) || isDerivedEndpoint(device) || device.kind === "gateway") return false;
  return device.hardwareRole === "controller" || device.hardwareRole === "switch";
}

function independentLight(device: ManagedDevice) {
  if (isDerivedEndpoint(device)) return false;
  if (!device.did) return ["light", "lamp"].includes(device.kind);
  return groupId(device.did) || ["light", "lamp"].includes(device.kind)
    || lightName.test(device.name) && device.hardwareRole === "device";
}

function ownerFor<T extends ManagedDevice>(device: T, controllers: T[]) {
  const parentId = device.parentId ?? device.topology?.parentId;
  return controllers.find(controller => controller.homeId === device.homeId && controller.did === parentId);
}

function recordCategory(device: ManagedDevice): ManagedDeviceCategory {
  if (groupId(device.did)) return "group";
  if (device.hardwareRole === "controller") return "controller";
  if (controlHardware(device)) return "switch";
  if (independentLight(device)) return "smart-light";
  return "other";
}

function endpointConnection(device: ManagedDevice, owner: ManagedDevice | undefined): DeviceConnection {
  if (device.topology?.connectionType === "wired" || device.topology?.connectionType === "wireless") return device.topology.connectionType;
  const siid = device.topology?.channelSiid;
  const channel = owner?.topology?.channels.find(item => item.channelSiid === siid);
  if (channel?.connectionType === "wired" || channel?.connectionType === "wireless") return channel.connectionType;
  return /副控/.test(device.name) ? "wireless" : "unknown";
}

function channelFor(device: ManagedDevice, owner: ManagedDevice | undefined): DeviceControlChannel | undefined {
  return owner?.topology?.channels.find(channel => channel.channelSiid === device.topology?.channelSiid);
}

function addControl<T extends ManagedDevice>(topology: LightingTopology<T>, owner: T | undefined, endpoint: T, connection: DeviceConnection, inferred: boolean) {
  if (!owner) return;
  const channel = channelFor(endpoint, owner);
  const relationship = connection === "wireless" ? "wireless-secondary"
    : topology.kind === "smart-light" || topology.kind === "smart-light-group" ? "smart-device-power"
      : connection === "wired" ? "relay-load" : "unknown";
  const exists = topology.controls.some(control => control.device.did === owner.did && control.channelSiid === endpoint.topology?.channelSiid && control.connection === connection);
  if (!exists) topology.controls.push({
    device: owner,
    endpoint,
    connection,
    relationship,
    channelIndex: channel?.channelIndex ?? endpoint.topology?.channelIndex ?? null,
    channelSiid: channel?.channelSiid ?? endpoint.topology?.channelSiid ?? null,
    inferred,
  });
}

function createTopology<T extends ManagedDevice>(key: string, name: string, homeId: string, room: string, kind: LightingTopologyKind): LightingTopology<T> {
  return { key, name, homeId, room, kind, lights: [], loads: [], aliases: [], controls: [], on: null, online: null, stateSource: "unknown", unresolved: false };
}

function selectTarget<T extends ManagedDevice>(candidates: LightingTopology<T>[], endpoint: T, owner?: T) {
  if (candidates.length <= 1) return candidates[0];
  if (!hiddenRoom.test(endpoint.room)) {
    const sameEndpointRoom = candidates.filter(candidate => candidate.room === endpoint.room);
    if (sameEndpointRoom.length === 1) return sameEndpointRoom[0];
  }
  if (owner) {
    const sameOwnerRoom = candidates.filter(candidate => candidate.room === owner.room);
    if (sameOwnerRoom.length === 1) return sameOwnerRoom[0];
  }
  return undefined;
}

export function buildDeviceManagementModel<T extends ManagedDevice>(devices: T[]): DeviceManagementModel<T> {
  const controllers = devices.filter(controlHardware);
  const endpoints = devices.filter(isDerivedEndpoint);
  const endpointRecords: ManagedDeviceRecord<T>[] = endpoints.map(device => ({
    device,
    category: endpointConnection(device, ownerFor(device, controllers)) === "wireless" ? "voice-alias" : "wired-load",
    owner: ownerFor(device, controllers),
    groupMembers: [],
  }));

  const groupMembersById = new Map<string, T[]>();
  for (const group of devices.filter(device => groupId(device.did))) {
    groupMembersById.set(`${group.homeId}:${group.did}`, (group.groupMemberIds ?? []).map(did => devices.find(candidate => candidate.homeId === group.homeId && candidate.did === did)).filter((candidate): candidate is T => Boolean(candidate)));
  }
  const claimedMembers = new Set([...groupMembersById.values()].flatMap(members => members.map(member => `${member.homeId}:${member.did}`)));
  const visibleDevices = devices.filter(device => !isDerivedEndpoint(device) && (!device.did || !claimedMembers.has(`${device.homeId}:${device.did}`)));
  const records: ManagedDeviceRecord<T>[] = visibleDevices.map(device => ({
    device,
    category: recordCategory(device),
    owner: ownerFor(device, controllers),
    groupMembers: groupMembersById.get(`${device.homeId}:${device.did}`) ?? [],
  }));

  const topologies = new Map<string, LightingTopology<T>>();
  const byName = new Map<string, LightingTopology<T>[]>();
  for (const device of devices.filter(independentLight)) {
    const kind: LightingTopologyKind = groupId(device.did) ? "smart-light-group" : "smart-light";
    const key = `${device.homeId}:${device.room}:${targetName(device.name)}:${device.did}`;
    const topology = createTopology<T>(key, device.name, device.homeId, device.room, kind);
    topology.lights.push(device);
    topology.on = device.online === false ? null : Boolean(device.on);
    topology.online = device.online ?? null;
    topology.stateSource = "smart-device";
    topologies.set(key, topology);
    const nameKey = `${device.homeId}:${targetName(device.name)}`;
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), topology]);
  }

  const pending: Array<{ record: ManagedDeviceRecord<T>; connection: DeviceConnection }> = [];
  for (const record of endpointRecords) {
    const connection = endpointConnection(record.device, record.owner);
    if (connection === "wireless") { pending.push({ record, connection }); continue; }
    const nameKey = `${record.device.homeId}:${targetName(record.device.name)}`;
    const smart = selectTarget(byName.get(nameKey) ?? [], record.device, record.owner);
    let topology = smart;
    if (!topology) {
      const room = record.device.room;
      const key = `${record.device.homeId}:${room}:${targetName(record.device.name)}`;
      topology = topologies.get(key) ?? createTopology<T>(key, displayTargetName(record.device.name), record.device.homeId, room, connection === "unknown" ? "unknown" : "ordinary-load");
      topologies.set(key, topology);
      if (!(byName.get(nameKey) ?? []).includes(topology)) byName.set(nameKey, [...(byName.get(nameKey) ?? []), topology]);
    }
    topology.loads.push(record.device);
    topology.unresolved ||= connection === "unknown";
    addControl(topology, record.owner, record.device, connection, Boolean(smart));
    if (topology.kind === "ordinary-load" && connection === "wired") {
      topology.on = record.device.on;
      topology.online = record.owner?.online ?? record.device.online ?? null;
      topology.stateSource = "wired-endpoint";
    }
  }

  for (const item of pending) {
    const { record } = item;
    const nameKey = `${record.device.homeId}:${targetName(record.device.name)}`;
    const candidate = selectTarget(byName.get(nameKey) ?? [], record.device, record.owner);
    const room = !hiddenRoom.test(record.device.room) ? record.device.room : record.owner?.room ?? record.device.room;
    const key = `${record.device.homeId}:${room}:${targetName(record.device.name)}:unresolved`;
    const topology = candidate ?? topologies.get(key) ?? createTopology<T>(key, displayTargetName(record.device.name), record.device.homeId, room, "unknown");
    if (!candidate) { topology.unresolved = true; topologies.set(key, topology); byName.set(nameKey, [...(byName.get(nameKey) ?? []), topology]); }
    topology.aliases.push(record.device);
    addControl(topology, record.owner, record.device, "wireless", !candidate || candidate.kind === "smart-light" || candidate.kind === "smart-light-group");
  }

  const sorted = [...topologies.values()].sort((left, right) => left.room.localeCompare(right.room, "zh-CN") || left.name.localeCompare(right.name, "zh-CN"));
  for (const topology of sorted) topology.controls.sort((left, right) => Number(left.connection !== "wired") - Number(right.connection !== "wired") || left.device.name.localeCompare(right.device.name, "zh-CN"));

  return {
    records,
    endpoints: endpointRecords,
    topologies: sorted,
    totals: {
      devices: records.length,
      lights: sorted.length,
      switches: records.filter(record => record.category === "switch" || record.category === "controller").length,
      aliases: endpointRecords.filter(record => endpointConnection(record.device, record.owner) === "wireless").length,
      groups: records.filter(record => record.category === "group").length,
    },
  };
}
