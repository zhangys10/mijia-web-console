import {
  controlObjectChannelKey,
  controlObjectResult,
  type ButtonControlObject,
  type ChannelControlObjectResult,
  type ControlEdge,
  type ControlEvidence,
  type ControlEvidenceSource,
  type ControlObjectKind,
  type ControlObjectQueryReason,
  type ControlObjectQueryStatus,
  type ControlRelation,
} from "./xiaomi-control-objects.ts";
import type { SwitchModeCapability } from "./switch-channel-mode.ts";

type RawDevice = Record<string, unknown>;

export type {
  ButtonControlObject,
  ChannelControlObjectResult,
  ControlEdge,
  ControlEvidence,
  ControlEvidenceSource,
  ControlObjectKind,
  ControlObjectQueryReason,
  ControlObjectQueryStatus,
  ControlRelation,
};
export type DeviceConnectionType = "wired" | "wireless";
export type DeviceConnection = DeviceConnectionType | "unknown";
export type DeviceChannelEvidence = "miot-property" | "explicit-control-object" | "control-object-query" | "split-device" | "name-match" | "user-domain-rule" | "unknown";
export type DeviceChannelClassification =
  | "confirmed-wired"
  | "configured-wireless"
  | "configured-smart-light"
  | "wireless-unconfigured"
  | "control-data-unavailable"
  | "control-data-failed"
  | "control-data-incomplete"
  | "inferred-wired"
  | "unknown";
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
  targetKey: string;
  name: string;
  room: string;
  relation: "mapped" | "bound";
  controllerCount: number;
  kind?: ControlObjectKind;
  evidence?: "confirmed" | "inferred" | "unknown";
  evidenceSource?: ControlEvidenceSource;
};
export type DeviceControlChannel = {
  key: string;
  label: string;
  channelIndex: number | null;
  channelSiid: number | null;
  role: "primary" | "secondary" | "unknown";
  connectionType: DeviceConnection | "mixed";
  modeCapability: SwitchModeCapability;
  relayEnabled: boolean;
  controlObjectStatus: ControlObjectQueryStatus;
  controlObjectComplete: boolean;
  controlObjectReason: ControlObjectQueryReason;
  classification: DeviceChannelClassification;
  targets: DeviceChannelTarget[];
  controlObjects: ButtonControlObject[];
  edges: ControlEdge[];
  reportedOn: boolean | null;
  powerControl?: { did: string; siid: number; piid: number };
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
  modeCapability?: SwitchModeCapability;
  reportedOn: boolean | null;
  powerControl?: { did: string; siid: number; piid: number };
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

function connectionFromEdges(
  edges: ControlEdge[],
  fallback: DeviceConnection,
): DeviceControlChannel["connectionType"] {
  const hasWired = edges.some(edge => edge.relation === "wired-load" || edge.relation === "wired-smart-light-power");
  const hasWireless = edges.some(edge => edge.relation === "wireless-control");
  if (hasWired && hasWireless) return "mixed";
  if (hasWired) return "wired";
  if (hasWireless) return "wireless";
  return fallback;
}

function channelRole(connection: DeviceControlChannel["connectionType"]) {
  if (connection === "mixed") return "primary" as const;
  return roleFor(connection);
}

const controlEvidenceRank: Record<ControlEvidence, number> = {
  unknown: 0,
  inferred: 1,
  confirmed: 2,
};

const controlEvidenceSourceRank: Record<ControlEvidenceSource, number> = {
  none: 0,
  "name-match": 1,
  "miot-property": 2,
  "split-device": 3,
  "explicit-control-object": 4,
  "control-object-query": 5,
};

function strongestControlObjectEvidence(objects: ButtonControlObject[]): DeviceChannelEvidence | null {
  const strongest = [...objects].sort((left, right) =>
    controlEvidenceRank[right.evidence] - controlEvidenceRank[left.evidence]
    || controlEvidenceSourceRank[right.evidenceSource] - controlEvidenceSourceRank[left.evidenceSource]
  )[0];
  if (!strongest || strongest.evidence === "unknown" || strongest.evidenceSource === "none") return null;
  return strongest.evidenceSource;
}

function fallbackChannelState(device: RawDevice, ownerDid: string, siid: number): DeviceChannelRuntimeState {
  const wireless = hiddenSecondaryName.test(deviceName(device));
  return {
    homeId: homeId(device), did: ownerDid, siid, buttonIndex: null, label: `服务 ${siid}`,
    connectionType: wireless ? "wireless" : "unknown", modeCapability: wireless ? "wireless-only" : "unknown", reportedOn: null, modeValue: null,
    evidence: wireless ? "user-domain-rule" : "unknown",
  };
}

function aggregateConnection(channels: DeviceControlChannel[]): DeviceTopology["connectionType"] {
  if (channels.some(channel => channel.connectionType === "mixed")) return "mixed";
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

type ChannelDecision = {
  connection: DeviceConnection;
  classification: DeviceChannelClassification;
  relation: ControlRelation | null;
  relayEnabled: boolean;
};

function decideChannel(
  capability: SwitchModeCapability,
  result: ChannelControlObjectResult,
  hasMappedEndpoint: boolean,
): ChannelDecision {
  const smartTargets = result.objects.filter(object => ["smart-light", "smart-light-group", "smart-device"].includes(object.targetKind));
  const trustedSmartTargets = smartTargets.filter(object => object.evidence === "confirmed");
  const hasSmartCandidate = smartTargets.length > 0;
  const hasSmartTarget = trustedSmartTargets.length > 0;
  const trustedOrdinaryLoads = result.objects.filter(object => object.targetKind === "ordinary-load" && object.evidence === "confirmed");
  const trustedUnconfigured = result.objects.filter(object => object.targetKind === "unconfigured" && object.evidence === "confirmed");
  const hasOrdinaryLoad = trustedOrdinaryLoads.length > 0;
  const onlyUnconfigured = result.objects.length === 0 || trustedUnconfigured.length === result.objects.length;
  const onlyWiredTargets = trustedOrdinaryLoads.length + trustedUnconfigured.length === result.objects.length;
  const hasUntrustedCandidate = result.objects.some(object => object.evidence !== "confirmed");
  const relayEnabled = capability === "relay-enabled";

  if (hasSmartTarget) {
    return {
      connection: "wireless",
      classification: trustedSmartTargets.some(object => object.targetKind === "smart-light" || object.targetKind === "smart-light-group")
        ? "configured-smart-light"
        : "configured-wireless",
      relation: "wireless-control",
      relayEnabled,
    };
  }
  if (result.status === "available" && result.complete) {
    if (capability === "wireless-only" && onlyUnconfigured) {
      return { connection: "wireless", classification: "wireless-unconfigured", relation: null, relayEnabled: false };
    }
    if (relayEnabled && onlyWiredTargets && (hasMappedEndpoint || hasOrdinaryLoad || onlyUnconfigured)) {
      return { connection: "wired", classification: "confirmed-wired", relation: "wired-load", relayEnabled: true };
    }
  }
  if (relayEnabled && hasMappedEndpoint && !hasSmartCandidate && !hasUntrustedCandidate) {
    return { connection: "wired", classification: "inferred-wired", relation: "wired-load", relayEnabled: true };
  }
  if (result.status === "failed") {
    return { connection: capability === "wireless-only" ? "wireless" : "unknown", classification: "control-data-failed", relation: "unknown", relayEnabled };
  }
  if (result.status === "unavailable") {
    return { connection: capability === "wireless-only" ? "wireless" : "unknown", classification: "control-data-unavailable", relation: "unknown", relayEnabled };
  }
  if (!result.complete) {
    return { connection: capability === "wireless-only" ? "wireless" : "unknown", classification: "control-data-incomplete", relation: "unknown", relayEnabled };
  }
  return { connection: "unknown", classification: "unknown", relation: "unknown", relayEnabled };
}

function controlObjectTargetKey(controlObject: ButtonControlObject) {
  return controlObject.targetDid
    ? deviceTopologyIdentity(controlObject.homeId, controlObject.targetDid)
    : `${controlObject.homeId}:${controlObject.targetRoom}:${controlObject.targetName}`;
}

function edgeFor(
  controlObject: ButtonControlObject,
  relation: ControlRelation,
  endpointDid: string | null,
): ControlEdge {
  return {
    key: `${controlObject.key}:${relation}:${endpointDid ?? "-"}`,
    homeId: controlObject.homeId,
    sourceDid: controlObject.sourceDid,
    sourceSiid: controlObject.sourceSiid,
    endpointDid,
    targetKey: controlObjectTargetKey(controlObject),
    relation,
    evidence: controlObject.evidence,
    evidenceSource: controlObject.evidenceSource,
  };
}

export function buildDeviceTopology(
  rawDevices: RawDevice[],
  runtimeStates: Map<string, DeviceChannelRuntimeState> = new Map(),
  suppliedControlResults: Array<ChannelControlObjectResult | ButtonControlObject> = [],
) {
  const entries = rawDevices.map(device => ({ device, did: stringValue(device.did), home: homeId(device) })).filter(entry => Boolean(entry.did));
  const controlObjectResults: ChannelControlObjectResult[] = [];
  const legacyObjects = new Map<string, ButtonControlObject[]>();
  for (const supplied of suppliedControlResults) {
    if ("objects" in supplied) {
      controlObjectResults.push(supplied);
      continue;
    }
    const key = controlObjectChannelKey(supplied.homeId, supplied.sourceDid, supplied.sourceSiid);
    legacyObjects.set(key, [...(legacyObjects.get(key) ?? []), supplied]);
  }
  for (const objects of legacyObjects.values()) {
    controlObjectResults.push(controlObjectResult(
      objects[0].homeId,
      objects[0].sourceDid,
      objects[0].sourceSiid,
      "available",
      false,
      objects,
    ));
  }
  const controlResultsByChannel = new Map(controlObjectResults.map(result => [result.key, result]));
  const controlObjects = controlObjectResults.flatMap(result => result.objects);
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
    const explicit = controlObjects.filter(controlObject => controlObject.homeId === entry.home && controlObject.sourceDid === entry.did);
    if (!derived.length && !states.length && !explicit.length) continue;
    const siids = new Set([...derived.map(item => item.parsed.siid), ...states.map(state => state.siid), ...explicit.map(item => item.sourceSiid)]);
    const channels: DeviceControlChannel[] = [...siids].map(siid => {
      const mappedTargets = derived.filter(item => item.parsed.siid === siid);
      const channelKey = controlObjectChannelKey(entry.home, entry.did, siid);
      const controlResult = controlResultsByChannel.get(channelKey)
        ?? controlObjectResult(entry.home, entry.did, siid, "unavailable", false);
      const channelControlObjects = controlResult.objects;
      const runtime = runtimeStates.get(deviceChannelStateKey(entry.home, entry.did, siid)) ?? (mappedTargets[0]
        ? fallbackChannelState(mappedTargets[0].device, entry.did, siid)
        : { homeId: entry.home, did: entry.did, siid, buttonIndex: channelControlObjects[0]?.buttonIndex ?? null, label: `服务 ${siid}`, connectionType: "unknown" as const, modeCapability: "unknown" as const, reportedOn: null, modeValue: null, evidence: "unknown" as const });
      const modeCapability = runtime.modeCapability
        ?? (runtime.connectionType === "wireless" ? "wireless-only" : runtime.connectionType === "wired" ? "relay-enabled" : "unknown");
      const decision = decideChannel(modeCapability, controlResult, mappedTargets.length > 0);
      const configuredObjects = channelControlObjects.filter(controlObject =>
        controlObject.evidence === "confirmed"
        && ["smart-light", "smart-light-group", "smart-device"].includes(controlObject.targetKind)
      );
      const evidence = decision.classification === "confirmed-wired"
        ? "control-object-query" as const
        : decision.classification.startsWith("configured-")
          ? strongestControlObjectEvidence(configuredObjects) ?? runtime.evidence
          : decision.classification === "inferred-wired"
            ? "split-device" as const
            : decision.connection === "wireless" && runtime.connectionType === "unknown"
              ? "user-domain-rule" as const
              : runtime.evidence;
      const explicitTargets = channelControlObjects.map(controlObject => ({
        id: controlObject.targetDid ?? controlObject.key,
        targetKey: controlObjectTargetKey(controlObject),
        name: controlObject.targetName,
        room: controlObject.targetRoom,
        relation: "bound" as const,
        controllerCount: 1,
        kind: controlObject.targetKind,
        evidence: controlObject.evidence,
        evidenceSource: controlObject.evidenceSource,
      }));
      const targetIndex = new Map<string, DeviceChannelTarget>();
      for (const target of mappedTargets.map(target => ({ id: target.did, targetKey: deviceTopologyIdentity(entry.home, target.did), name: deviceName(target.device), room: roomName(target.device), relation: "mapped" as const, controllerCount: 1 }))) targetIndex.set(target.id, target);
      for (const target of explicitTargets) targetIndex.set(target.id, target);
      const endpointDid = mappedTargets[0]?.did ?? null;
      const edges = channelControlObjects.flatMap(controlObject => {
        const relation = controlObject.targetKind === "unconfigured"
          ? decision.relation
          : controlObject.evidence === "confirmed"
            && ["smart-light", "smart-light-group", "smart-device"].includes(controlObject.targetKind)
            ? "wireless-control" as const
            : controlObject.targetKind === "ordinary-load" && controlObject.evidence === "confirmed"
              ? "wired-load" as const
              : "unknown" as const;
        const result = relation ? [edgeFor(controlObject, relation, endpointDid)] : [];
        if (
          relation === "wireless-control"
          && (controlObject.targetKind === "smart-light" || controlObject.targetKind === "smart-light-group")
          && endpointDid
          && decision.relayEnabled
        ) result.push(edgeFor(controlObject, "wired-smart-light-power", endpointDid));
        return result;
      });
      if (!channelControlObjects.length && decision.relation) {
        const synthetic: ButtonControlObject = {
          key: `${channelKey}:query-result`,
          homeId: entry.home,
          sourceDid: entry.did,
          sourceSiid: siid,
          buttonIndex: runtime.buttonIndex,
          targetDid: endpointDid,
          targetSiid: siid,
          targetName: mappedTargets[0] ? deviceName(mappedTargets[0].device) : runtime.label,
          targetRoom: mappedTargets[0] ? roomName(mappedTargets[0].device) : roomName(entry.device),
          targetKind: decision.relation === "wired-load" ? "ordinary-load" : "unknown",
          evidence: decision.classification === "confirmed-wired" ? "confirmed" : decision.classification === "inferred-wired" ? "inferred" : "unknown",
          evidenceSource: decision.classification === "confirmed-wired" ? "control-object-query" : decision.classification === "inferred-wired" ? "split-device" : "none",
        };
        edges.push(edgeFor(synthetic, decision.relation, endpointDid));
      }
      const connection = connectionFromEdges(edges, decision.connection);
      return {
        key: `service:${siid}`,
        label: channelControlObjects[0]?.targetName || (mappedTargets[0] ? deviceName(mappedTargets[0].device) : runtime.label),
        channelIndex: runtime.buttonIndex ?? channelControlObjects[0]?.buttonIndex ?? null,
        channelSiid: siid,
        role: channelRole(connection),
        connectionType: connection,
        modeCapability,
        relayEnabled: decision.relayEnabled,
        controlObjectStatus: controlResult.status,
        controlObjectComplete: controlResult.complete,
        controlObjectReason: controlResult.reason,
        classification: decision.classification,
        targets: [...targetIndex.values()],
        controlObjects: channelControlObjects,
        edges,
        reportedOn: runtime.reportedOn,
        powerControl: runtime.powerControl,
        modeValue: runtime.modeValue,
        evidence,
      };
    }).sort((left, right) => (left.channelIndex ?? left.channelSiid ?? 999) - (right.channelIndex ?? right.channelSiid ?? 999));

    const topology = topologies.get(ownerKey)!;
    topology.channels = channels;
    topology.connectionType = aggregateConnection(channels);
    topology.secondaryCount = channels.filter(channel => channel.connectionType === "wireless").length;
    topology.role = channels.length && channels.every(channel => channel.connectionType === "wireless") ? "secondary-panel" : channels.some(channel => channel.role === "primary") ? "primary" : "unknown";

    for (const target of derived) {
      const channel = channels.find(candidate => candidate.channelSiid === target.parsed.siid);
      const child = topologies.get(deviceTopologyIdentity(entry.home, target.did));
      if (!channel || !child) continue;
      const childConnection = channel.connectionType === "mixed" ? "wired" : channel.connectionType;
      child.connectionType = childConnection;
      child.role = roleFor(childConnection);
      child.channelIndex = channel.channelIndex;
      child.channelLabel = channel.label;
      const source = child.controlledBy[0];
      if (source) {
        source.sourceRole = roleFor(childConnection);
        source.channelIndex = channel.channelIndex;
        source.connectionType = childConnection;
        source.evidence = channel.evidence;
      }
    }
  }

  const didCounts = new Map<string, number>();
  for (const entry of entries) didCounts.set(entry.did, (didCounts.get(entry.did) ?? 0) + 1);
  for (const entry of entries) if (didCounts.get(entry.did) === 1) {
    const topology = topologies.get(deviceTopologyIdentity(entry.home, entry.did));
    if (topology) topologies.set(entry.did, topology);
  }
  return topologies;
}
