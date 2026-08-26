type RawDevice = Record<string, unknown>;

export type DeviceConnectionType = "wired" | "wireless";
export type DeviceConnection = DeviceConnectionType | "unknown";
export type DeviceChannelEvidence = "miot-property" | "user-domain-rule" | "unknown";
export type DeviceBinding = {
  targetId: string;
  targetName: string;
  targetRoom: string;
  channelIndex: number | null;
  channelSiid: number | null;
  targetChannelIndex: number | null;
  targetChannelSiid: number | null;
  viaId: string | null;
  viaName: string | null;
  connectionType: DeviceConnection;
};
export type DeviceControlSource = {
  sourceId: string;
  sourceName: string;
  sourceRoom: string;
  sourceRole: "primary" | "secondary" | "unknown";
  channelIndex: number | null;
  channelSiid: number | null;
  viaId: string | null;
  viaName: string | null;
  targetCount: number;
  connectionType: DeviceConnection;
  evidence?: DeviceChannelEvidence;
};
export type DeviceChannelTarget = {
  id: string;
  name: string;
  room: string;
  relation: "mapped" | "bound";
  controllerCount: number;
};
export type DeviceControlChannel = {
  key: string;
  label: string;
  channelIndex: number | null;
  channelSiid: number | null;
  role: "primary" | "secondary" | "unknown";
  connectionType: DeviceConnection | "mixed";
  targets: DeviceChannelTarget[];
  reportedOn: boolean | null;
  modeValue: boolean | number | string | null;
  evidence: DeviceChannelEvidence;
};
export type DeviceTopology = {
  parentId: string | null;
  parentName: string | null;
  parentRoom: string | null;
  channelIndex: number | null;
  channelSiid: number | null;
  channelLabel: string | null;
  role: "independent" | "primary" | "secondary" | "secondary-panel" | "unknown";
  connectionType: DeviceConnection | "mixed";
  relation: "none" | "mapped" | "subdevice";
  childCount: number;
  secondaryCount: number;
  bindings: DeviceBinding[];
  controlledBy: DeviceControlSource[];
  channels: DeviceControlChannel[];
};

export type DeviceChannelRuntimeState = {
  homeId: string;
  did: string;
  siid: number;
  buttonIndex: number | null;
  label: string;
  connectionType: DeviceConnection;
  reportedOn: boolean | null;
  modeValue: boolean | number | string | null;
  evidence: DeviceChannelEvidence;
};

const explicitParentKeys = ["parent_id", "parentId", "parent_did", "parentDid", "pdid"];
const hiddenSecondaryName = /副控/;

function stringValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function homeId(device: RawDevice) {
  return stringValue(device.homeId ?? device.home_id) || "default";
}

function roomName(device: RawDevice) {
  return stringValue(device.roomName ?? device.room_name ?? device.room) || "未分配";
}

function deviceName(device: RawDevice) {
  return stringValue(device.name ?? device.model) || "未命名设备";
}

export function deviceTopologyIdentity(home: string, did: string) {
  return `${home}:${did}`;
}

export function deviceChannelStateKey(home: string, did: string, siid: number) {
  return `${home}:${did}:${siid}`;
}

export function parseDerivedDeviceId(did: string) {
  if (/^group\./i.test(did)) return null;
  const match = did.match(/^(.+)\.s(\d+)$/i);
  if (!match) return null;
  const siid = Number(match[2]);
  return Number.isInteger(siid) && siid > 0 ? { physicalDid: match[1], siid } : null;
}

function roleFor(connection: DeviceConnection) {
  return connection === "wired" ? "primary" as const : connection === "wireless" ? "secondary" as const : "unknown" as const;
}

function fallbackChannelState(device: RawDevice, ownerDid: string, siid: number): DeviceChannelRuntimeState {
  const wireless = hiddenSecondaryName.test(deviceName(device));
  return {
    homeId: homeId(device), did: ownerDid, siid, buttonIndex: null, label: `服务 ${siid}`,
    connectionType: wireless ? "wireless" : "unknown", reportedOn: null, modeValue: null,
    evidence: wireless ? "user-domain-rule" : "unknown",
  };
}

function aggregateConnection(channels: DeviceControlChannel[]): DeviceTopology["connectionType"] {
  const known = new Set(channels.map(channel => channel.connectionType).filter((value): value is DeviceConnectionType => value === "wired" || value === "wireless"));
  if (known.size > 1) return "mixed";
  if (known.size === 1) return [...known][0];
  return "unknown";
}

function explicitParent(device: RawDevice, index: Map<string, RawDevice>) {
  const currentHome = homeId(device);
  for (const key of explicitParentKeys) {
    const did = stringValue(device[key]);
    if (did && index.has(deviceTopologyIdentity(currentHome, did))) return did;
  }
  return null;
}

export function topologyForDevice(topologies: Map<string, DeviceTopology>, device: RawDevice) {
  const did = stringValue(device.did);
  return topologies.get(deviceTopologyIdentity(homeId(device), did)) ?? topologies.get(did);
}

export function buildDeviceTopology(rawDevices: RawDevice[], runtimeStates: Map<string, DeviceChannelRuntimeState> = new Map()) {
  const entries = rawDevices.map(device => ({ device, did: stringValue(device.did), home: homeId(device) })).filter(entry => Boolean(entry.did));
  const index = new Map(entries.map(entry => [deviceTopologyIdentity(entry.home, entry.did), entry.device]));
  const topologies = new Map<string, DeviceTopology>();
  const derivedByOwner = new Map<string, Array<{ device: RawDevice; did: string; parsed: { physicalDid: string; siid: number } }>>();

  for (const entry of entries) {
    const parsed = parseDerivedDeviceId(entry.did);
    const owner = parsed ? index.get(deviceTopologyIdentity(entry.home, parsed.physicalDid)) : undefined;
    const parentId = owner && parsed ? parsed.physicalDid : explicitParent(entry.device, index);
    const relation = owner && parsed ? "mapped" as const : parentId ? "subdevice" as const : "none" as const;
    const runtime = owner && parsed ? runtimeStates.get(deviceChannelStateKey(entry.home, parsed.physicalDid, parsed.siid)) ?? fallbackChannelState(entry.device, parsed.physicalDid, parsed.siid) : undefined;
    const parent = parentId ? index.get(deviceTopologyIdentity(entry.home, parentId)) : undefined;
    const connection = runtime?.connectionType ?? "unknown";
    const mappedRole = roleFor(connection);

    topologies.set(deviceTopologyIdentity(entry.home, entry.did), {
      parentId,
      parentName: parent ? deviceName(parent) : null,
      parentRoom: parent ? roomName(parent) : null,
      channelIndex: runtime?.buttonIndex ?? null,
      channelSiid: parsed?.siid ?? null,
      channelLabel: runtime?.label ?? (parsed ? `服务 ${parsed.siid}` : null),
      role: relation === "mapped" ? mappedRole === "secondary" ? "secondary" : mappedRole === "primary" ? "primary" : "unknown" : "independent",
      connectionType: connection,
      relation,
      childCount: 0,
      secondaryCount: 0,
      bindings: [],
      controlledBy: [],
      channels: [],
    });

    if (owner && parsed) {
      const key = deviceTopologyIdentity(entry.home, parsed.physicalDid);
      const children = derivedByOwner.get(key) ?? [];
      children.push({ device: entry.device, did: entry.did, parsed });
      derivedByOwner.set(key, children);
    }
  }

  for (const entry of entries) {
    const topology = topologies.get(deviceTopologyIdentity(entry.home, entry.did))!;
    if (topology.parentId) topologies.get(deviceTopologyIdentity(entry.home, topology.parentId))!.childCount += 1;
    if (topology.relation !== "mapped" || !topology.parentId || topology.channelSiid === null) continue;
    const runtime = runtimeStates.get(deviceChannelStateKey(entry.home, topology.parentId, topology.channelSiid)) ?? fallbackChannelState(entry.device, topology.parentId, topology.channelSiid);
    const parent = index.get(deviceTopologyIdentity(entry.home, topology.parentId));
    topology.controlledBy.push({
      sourceId: topology.parentId,
      sourceName: parent ? deviceName(parent) : topology.parentName ?? "控制设备",
      sourceRoom: parent ? roomName(parent) : topology.parentRoom ?? "未分配",
      sourceRole: roleFor(runtime.connectionType),
      channelIndex: runtime.buttonIndex,
      channelSiid: runtime.siid,
      viaId: null,
      viaName: null,
      targetCount: 1,
      connectionType: runtime.connectionType,
      evidence: runtime.evidence,
    });
  }

  for (const entry of entries) {
    const ownerKey = deviceTopologyIdentity(entry.home, entry.did);
    const derived = derivedByOwner.get(ownerKey) ?? [];
    const states = [...runtimeStates.values()].filter(state => state.homeId === entry.home && state.did === entry.did);
    if (!derived.length && !states.length) continue;
    const siids = new Set([...derived.map(item => item.parsed.siid), ...states.map(state => state.siid)]);
    const channels: DeviceControlChannel[] = [...siids].map(siid => {
      const targets = derived.filter(item => item.parsed.siid === siid);
      const runtime = runtimeStates.get(deviceChannelStateKey(entry.home, entry.did, siid)) ?? (targets[0]
        ? fallbackChannelState(targets[0].device, entry.did, siid)
        : { homeId: entry.home, did: entry.did, siid, buttonIndex: null, label: `服务 ${siid}`, connectionType: "unknown" as const, reportedOn: null, modeValue: null, evidence: "unknown" as const });
      const connection = runtime.connectionType === "unknown" && targets.some(target => hiddenSecondaryName.test(deviceName(target.device))) ? "wireless" as const : runtime.connectionType;
      const evidence = connection === "wireless" && runtime.connectionType === "unknown" ? "user-domain-rule" as const : runtime.evidence;
      return {
        key: `service:${siid}`,
        label: targets[0] ? deviceName(targets[0].device) : runtime.label,
        channelIndex: runtime.buttonIndex,
        channelSiid: siid,
        role: roleFor(connection),
        connectionType: connection,
        targets: targets.map(target => ({ id: target.did, name: deviceName(target.device), room: roomName(target.device), relation: "mapped" as const, controllerCount: 1 })),
        reportedOn: runtime.reportedOn,
        modeValue: runtime.modeValue,
        evidence,
      };
    }).sort((left, right) => (left.channelIndex ?? left.channelSiid ?? 999) - (right.channelIndex ?? right.channelSiid ?? 999));

    const topology = topologies.get(ownerKey)!;
    topology.channels = channels;
    topology.connectionType = aggregateConnection(channels);
    topology.secondaryCount = channels.filter(channel => channel.connectionType === "wireless").length;
    topology.role = channels.length && channels.every(channel => channel.connectionType === "wireless") ? "secondary-panel" : channels.some(channel => channel.connectionType === "wired") ? "primary" : "unknown";
  }

  const didCounts = new Map<string, number>();
  for (const entry of entries) didCounts.set(entry.did, (didCounts.get(entry.did) ?? 0) + 1);
  for (const entry of entries) if (didCounts.get(entry.did) === 1) {
    const topology = topologies.get(deviceTopologyIdentity(entry.home, entry.did));
    if (topology) topologies.set(entry.did, topology);
  }
  return topologies;
}
