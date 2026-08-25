type RawDevice = Record<string, unknown>;

export type DeviceBinding = { targetId: string; targetName: string; targetRoom: string; channelIndex: number | null; channelSiid: number | null };
export type DeviceControlSource = { sourceId: string; sourceName: string; sourceRoom: string; sourceRole: "primary" | "secondary"; channelIndex: number | null; channelSiid: number | null };
export type DeviceTopology = {
  parentId: string | null;
  parentName: string | null;
  parentRoom: string | null;
  channelIndex: number | null;
  channelSiid: number | null;
  channelLabel: string | null;
  role: "independent" | "primary" | "secondary" | "secondary-panel";
  relation: "none" | "mapped" | "subdevice";
  childCount: number;
  secondaryCount: number;
  bindings: DeviceBinding[];
  controlledBy: DeviceControlSource[];
};

const parentKeys = ["parent_id", "parentId", "parent_did", "parentDid", "pdid", "master_did", "masterDid", "main_did", "mainDid", "source_did", "sourceDid", "physical_did", "physicalDid", "host_did", "hostDid", "bind_did", "bindDid", "bound_did", "target_did", "targetDid", "linked_did", "linkedDid", "owner_did", "ctrl_did"];
const childKeys = ["children", "child_devices", "child_dids", "sub_devices", "subDevices", "sub_dids", "split_devices", "splitDevices", "virtual_devices", "virtualDevices", "slave_devices", "bound_devices", "mapped_devices"];
const channelKeys = ["channel_index", "channelIndex", "button_index", "buttonIndex", "key_index", "keyIndex", "switch_index", "switchIndex", "channel", "channel_id", "key_id", "keyId", "button", "sub_id"];
const serviceKeys = ["parent_siid", "parentSiid", "target_siid", "targetSiid", "service_iid", "serviceIid", "siid"];
const containerKeys = ["extra", "prop", "props", "properties", "setting", "settings", "attributes", "device_info", "deviceInfo", "parent", "parent_device", "parentDevice", "bind_info", "bindInfo", "split_device", "splitDevice", "virtual_info", "virtualInfo", "mapping", "control", "ctrl", "slave", "sub_device_info", "channel_info", "channelInfo"];

function object(value: unknown): RawDevice | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as RawDevice;
  if (typeof value !== "string" || value.length > 20000 || !value.trim().startsWith("{")) return;
  try { const result = JSON.parse(value); return result && typeof result === "object" && !Array.isArray(result) ? result as RawDevice : undefined; } catch { return; }
}

function scopes(device: RawDevice) {
  const result = [device];
  for (const key of containerKeys) {
    const nested = object(device[key]);
    if (!nested) continue;
    result.push(nested);
    for (const subkey of containerKeys) { const child = object(nested[subkey]); if (child) result.push(child); }
  }
  return result;
}

function knownId(value: unknown, devices: Map<string, RawDevice>, current: string) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = String(value).trim();
  return id && id !== current && devices.has(id) ? id : null;
}

function numberValue(values: RawDevice[], keys: string[]) {
  for (const scope of values) for (const key of keys) {
    const raw = scope[key];
    if (typeof raw !== "number" && typeof raw !== "string") continue;
    const number = Number(raw);
    if (Number.isInteger(number) && number >= 0 && number < 256) return number;
  }
  return null;
}

function wirelessMarker(values: RawDevice[]) {
  for (const scope of values) {
    for (const key of ["is_slave", "isSlave", "slave", "is_wireless", "isWireless", "wireless", "wireless_mode", "wirelessMode", "all_secondary", "all_slave", "all_wireless", "is_virtual", "isVirtual", "is_split", "is_split_device", "is_mapped"]) if (scope[key] === true || scope[key] === 1 || scope[key] === "1") return true;
    for (const key of ["role", "device_role", "deviceRole", "control_mode", "controlMode", "switch_mode", "mode"]) if (typeof scope[key] === "string" && /slave|secondary|wireless|virtual|mapped|remote/i.test(scope[key] as string)) return true;
  }
  return false;
}

function channelLabel(values: RawDevice[], index: number | null, siid: number | null) {
  for (const scope of values) for (const key of ["channel_name", "channelName", "button_name", "buttonName", "key_name", "keyName", "service_name"]) if (typeof scope[key] === "string" && scope[key]) return String(scope[key]);
  if (index !== null) return `按键 ${index === 0 ? 1 : index}`;
  if (siid !== null) return `服务 ${siid}`;
  return null;
}

function boundTarget(scope: RawDevice, devices: Map<string, RawDevice>, current: string) {
  for (const key of parentKeys) { const id = knownId(scope[key], devices, current); if (id) return id; }
  const nested = object(scope.target ?? scope.master ?? scope.parent ?? scope.device);
  return nested ? knownId(nested.did ?? nested.id ?? nested.device_id, devices, current) : null;
}

export function buildDeviceTopology(rawDevices: RawDevice[]) {
  const devices = new Map(rawDevices.filter(device => device.did !== undefined && device.did !== null).map(device => [String(device.did), device]));
  const reverseParents = new Map<string, { parentId: string; data: RawDevice }>();
  for (const [did, device] of devices) for (const scope of scopes(device)) for (const key of childKeys) {
    const children = scope[key];
    if (!Array.isArray(children)) continue;
    for (const entry of children) {
      const item = object(entry);
      const childId = knownId(item?.did ?? item?.id ?? item?.device_id ?? entry, devices, did);
      if (childId && !reverseParents.has(childId)) reverseParents.set(childId, { parentId: did, data: item ?? {} });
    }
  }

  const topologies = new Map<string, DeviceTopology>();
  for (const [did, device] of devices) {
    const values = scopes(device);
    let parentId: string | null = null;
    for (const scope of values) {
      parentId = boundTarget(scope, devices, did);
      if (!parentId) parentId = knownId(typeof scope.pid === "string" ? scope.pid : null, devices, did);
      if (parentId) break;
    }
    const reverse = reverseParents.get(did);
    if (!parentId && reverse) { parentId = reverse.parentId; values.push(reverse.data); }
    if (!parentId) {
      for (const candidate of devices.keys()) if (candidate !== did && did.startsWith(candidate) && /^[._:\/-]\d+$/.test(did.slice(candidate.length))) { parentId = candidate; break; }
    }

    const index = numberValue(values, channelKeys), siid = numberValue(values, serviceKeys);
    const parent = parentId ? devices.get(parentId) : undefined;
    const isSwitch = /switch|panel|remote|key/i.test(String(device.model ?? ""));
    const parentSwitch = /switch|panel|relay/i.test(String(parent?.model ?? ""));
    const wireless = wirelessMarker(values);
    const bindings: DeviceBinding[] = [];
    const bindingIds = new Set<string>();
    const entries: unknown[] = [];
    for (const scope of values) for (const key of ["channels", "keys", "buttons", "bindings", "bind_list", "bindList", "mappings", "mapping_list", "control_targets", "targets"]) if (Array.isArray(scope[key])) entries.push(...scope[key] as unknown[]);
    for (const entry of entries) {
      const item = object(entry);
      if (!item) continue;
      const itemScopes = scopes(item);
      const itemIndex = numberValue(itemScopes, channelKeys), itemSiid = numberValue(itemScopes, serviceKeys);
      const targets = [boundTarget(item, devices, did)];
      for (const key of ["targets", "target_dids", "targetDids", "devices", "device_ids", "bound_devices", "linked_devices", "control_targets"]) {
        const linked = item[key];
        if (!Array.isArray(linked)) continue;
        for (const candidate of linked) { const record = object(candidate); targets.push(knownId(record?.did ?? record?.id ?? record?.device_id ?? candidate, devices, did)); }
      }
      for (const targetId of targets) {
        if (!targetId) continue;
        const bindingKey = `${targetId}:${itemIndex}:${itemSiid}`;
        if (bindingIds.has(bindingKey)) continue;
        bindingIds.add(bindingKey);
        const target = devices.get(targetId)!;
        bindings.push({ targetId, targetName: String(target.name ?? target.model ?? "受控设备"), targetRoom: String(target.roomName ?? target.room_name ?? "未分配"), channelIndex: itemIndex, channelSiid: itemSiid });
      }
    }

    const relation = parentId ? (parentSwitch || wireless || index !== null || siid !== null ? "mapped" : "subdevice") : "none";
    const entirePanel = isSwitch && (bindings.length > 0 || wireless && (index === null || !parentId));
    const role = entirePanel ? "secondary-panel" : parentId && relation === "mapped" ? "secondary" : "independent";
    topologies.set(did, { parentId, parentName: parent ? String(parent.name ?? parent.model ?? "主控设备") : null, parentRoom: parent ? String(parent.roomName ?? parent.room_name ?? "未分配") : null, channelIndex: index, channelSiid: siid, channelLabel: channelLabel(values, index, siid), role, relation, childCount: 0, secondaryCount: 0, bindings, controlledBy: [] });
  }

  for (const topology of topologies.values()) {
    if (!topology.parentId) continue;
    const parent = topologies.get(topology.parentId);
    if (!parent) continue;
    parent.childCount++;
    if (topology.relation === "mapped") { parent.secondaryCount++; if (parent.role === "independent") parent.role = "primary"; }
  }
  for (const [did, topology] of topologies) {
    if (topology.parentId && topology.relation === "mapped") {
      const parent = devices.get(topology.parentId)!;
      topology.controlledBy.push({ sourceId: topology.parentId, sourceName: String(parent.name ?? parent.model ?? "主控设备"), sourceRoom: String(parent.roomName ?? parent.room_name ?? "未分配"), sourceRole: "primary", channelIndex: topology.channelIndex, channelSiid: topology.channelSiid });
    }
    const source = devices.get(did)!;
    for (const binding of topology.bindings) {
      const target = topologies.get(binding.targetId);
      if (!target || target.controlledBy.some(item => item.sourceId === did && item.channelIndex === binding.channelIndex && item.channelSiid === binding.channelSiid)) continue;
      target.controlledBy.push({ sourceId: did, sourceName: String(source.name ?? source.model ?? "副控设备"), sourceRoom: String(source.roomName ?? source.room_name ?? "未分配"), sourceRole: topology.role === "secondary-panel" || topology.role === "secondary" ? "secondary" : "primary", channelIndex: binding.channelIndex, channelSiid: binding.channelSiid });
    }
  }
  return topologies;
}
