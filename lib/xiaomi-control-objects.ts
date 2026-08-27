export type ControlObjectKind =
  | "unconfigured"
  | "ordinary-load"
  | "smart-light"
  | "smart-light-group"
  | "smart-device"
  | "unknown";

export type ControlEvidence = "confirmed" | "inferred" | "unknown";
export type ControlEvidenceSource =
  | "explicit-control-object"
  | "control-object-query"
  | "split-device"
  | "miot-property"
  | "name-match"
  | "none";

export type ButtonControlObject = {
  key: string;
  homeId: string;
  sourceDid: string;
  sourceSiid: number;
  buttonIndex: number | null;
  targetDid: string | null;
  targetSiid: number | null;
  targetName: string;
  targetRoom: string;
  targetKind: ControlObjectKind;
  evidence: ControlEvidence;
  evidenceSource: ControlEvidenceSource;
};

export type ControlObjectQueryStatus = "available" | "unavailable" | "failed";
export type ControlObjectQueryReason =
  | "complete"
  | "embedded-data-incomplete"
  | "query-not-supported"
  | "query-failed";

export type ChannelControlObjectResult = {
  key: string;
  homeId: string;
  sourceDid: string;
  sourceSiid: number;
  status: ControlObjectQueryStatus;
  complete: boolean;
  reason: ControlObjectQueryReason;
  objects: ButtonControlObject[];
};

export type ControlRelation =
  | "wired-load"
  | "wireless-control"
  | "wired-smart-light-power"
  | "unknown";

export type ControlEdge = {
  key: string;
  homeId: string;
  sourceDid: string;
  sourceSiid: number;
  endpointDid: string | null;
  targetKey: string;
  relation: ControlRelation;
  evidence: ControlEvidence;
  evidenceSource: ControlEvidenceSource;
};

type RawRecord = Record<string, unknown>;
type DeviceIndexEntry = { did: string; name: string; room: string; kind: ControlObjectKind };

const containerKeys = ["control_objects", "controlObjects", "controlled_devices", "controlledDevices", "bindings"] as const;
const sourceSiidKeys = ["source_siid", "sourceSiid", "siid", "service_id", "serviceId"] as const;
const buttonIndexKeys = ["button_index", "buttonIndex", "key_index", "keyIndex", "key"] as const;
const targetDidKeys = ["target_did", "targetDid", "device_did", "deviceDid", "did"] as const;
const targetSiidKeys = ["target_siid", "targetSiid"] as const;
const targetNameKeys = ["target_name", "targetName", "device_name", "deviceName", "name"] as const;
const targetRoomKeys = ["target_room", "targetRoom", "room_name", "roomName", "room"] as const;
const targetKindKeys = ["target_kind", "targetKind", "device_type", "deviceType", "kind", "type"] as const;
const lightName = /灯带|灯光|灯具|灯组|灯泡|球泡|吸顶灯|吊灯|筒灯|射灯|壁灯|台灯|床头灯|柜灯|夜灯|氛围灯|照明|光源|灯$/;
const unconfiguredName = /^(?:未配置|未设置|未绑定|无|none|unconfigured)$/i;

function objectValue(value: unknown): RawRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function firstString(record: RawRecord, keys: readonly string[]) {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return "";
}

function firstPositiveInteger(record: RawRecord, keys: readonly string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" && typeof value !== "string") continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function homeId(record: RawRecord) {
  return stringValue(record.homeId ?? record.home_id) || "default";
}

function deviceKind(record: RawRecord, did: string, name: string): ControlObjectKind {
  const explicit = firstString(record, targetKindKeys).toLowerCase();
  if (unconfiguredName.test(explicit) || unconfiguredName.test(name)) return "unconfigured";
  if (/^group\./i.test(did) || /(?:^|[-_.])group(?:$|[-_.])/.test(explicit) && lightName.test(name)) return "smart-light-group";
  if (/light|lamp|bulb|lighting/.test(explicit) || lightName.test(name)) return did ? "smart-light" : "ordinary-load";
  if (did) return "smart-device";
  return name ? "unknown" : "unconfigured";
}

function targetEntries(record: RawRecord) {
  const entries: RawRecord[] = [];
  for (const key of containerKeys) {
    const value = record[key];
    const values = Array.isArray(value) ? value : objectValue(value) ? [value] : [];
    for (const candidate of values) {
      const item = objectValue(candidate);
      if (item) entries.push(item);
    }
  }
  return entries;
}

function explicitSourceSiid(entry: RawRecord) {
  return firstPositiveInteger(entry, sourceSiidKeys);
}

export function controlObjectChannelKey(home: string, did: string, siid: number) {
  return `${home}:${did}:${siid}`;
}

export function controlObjectResult(
  home: string,
  did: string,
  siid: number,
  status: ControlObjectQueryStatus,
  complete: boolean,
  objects: ButtonControlObject[] = [],
): ChannelControlObjectResult {
  const availableAndComplete = status === "available" && complete;
  return {
    key: controlObjectChannelKey(home, did, siid),
    homeId: home,
    sourceDid: did,
    sourceSiid: siid,
    status,
    complete: availableAndComplete,
    reason: availableAndComplete
      ? "complete"
      : status === "failed"
        ? "query-failed"
        : status === "unavailable"
          ? "query-not-supported"
          : "embedded-data-incomplete",
    objects,
  };
}

export function parseXiaomiControlObjects(records: RawRecord[]): ButtonControlObject[] {
  const index = new Map<string, DeviceIndexEntry>();
  for (const record of records) {
    const did = stringValue(record.did);
    if (!did) continue;
    const name = stringValue(record.name ?? record.model) || "未命名设备";
    index.set(`${homeId(record)}:${did}`, {
      did,
      name,
      room: stringValue(record.roomName ?? record.room_name ?? record.room) || "未分配",
      kind: deviceKind(record, did, name),
    });
  }

  const parsed: ButtonControlObject[] = [];
  const seen = new Set<string>();
  for (const source of records) {
    const sourceDid = stringValue(source.did);
    if (!sourceDid) continue;
    const home = homeId(source);
    for (const entry of targetEntries(source)) {
      const sourceSiid = explicitSourceSiid(entry);
      if (sourceSiid === null) continue;
      const buttonIndex = firstPositiveInteger(entry, buttonIndexKeys);
      const targetDid = firstString(entry, targetDidKeys) || null;
      if (targetDid === sourceDid) continue;
      const indexed = targetDid ? index.get(`${home}:${targetDid}`) : undefined;
      const targetName = firstString(entry, targetNameKeys) || indexed?.name || "未配置";
      const targetRoom = firstString(entry, targetRoomKeys) || indexed?.room || "未分配";
      const targetSiid = firstPositiveInteger(entry, targetSiidKeys);
      const explicitKind = deviceKind(entry, targetDid ?? "", targetName);
      const targetKind = indexed?.kind ?? (targetDid && lightName.test(targetName) ? "unknown" : explicitKind);
      const evidence: ControlEvidence = targetDid && indexed
        ? "confirmed"
        : targetKind === "unconfigured" || targetKind === "ordinary-load"
          ? "confirmed"
          : "unknown";
      const identity = `${home}:${sourceDid}:${sourceSiid}:${buttonIndex ?? "-"}:${targetDid ?? "-"}:${targetSiid ?? "-"}:${targetName}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      parsed.push({
        key: identity,
        homeId: home,
        sourceDid,
        sourceSiid,
        buttonIndex,
        targetDid,
        targetSiid,
        targetName,
        targetRoom,
        targetKind,
        evidence,
        evidenceSource: "explicit-control-object",
      });
    }
  }
  return parsed;
}

export function parseEmbeddedControlObjectResults(records: RawRecord[]): ChannelControlObjectResult[] {
  const grouped = new Map<string, ButtonControlObject[]>();
  for (const object of parseXiaomiControlObjects(records)) {
    const key = controlObjectChannelKey(object.homeId, object.sourceDid, object.sourceSiid);
    grouped.set(key, [...(grouped.get(key) ?? []), object]);
  }

  return [...grouped.values()].map(objects => controlObjectResult(
    objects[0].homeId,
    objects[0].sourceDid,
    objects[0].sourceSiid,
    "available",
    false,
    objects,
  ));
}
