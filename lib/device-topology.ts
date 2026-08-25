type RawDevice = Record<string, unknown>;

export type DeviceBinding = { targetId: string; targetName: string; targetRoom: string; channelIndex: number | null; channelSiid: number | null; targetChannelIndex: number | null; targetChannelSiid: number | null; viaId: string | null; viaName: string | null };
export type DeviceControlSource = { sourceId: string; sourceName: string; sourceRoom: string; sourceRole: "primary" | "secondary"; channelIndex: number | null; channelSiid: number | null; viaId: string | null; viaName: string | null; targetCount: number };
export type DeviceChannelTarget = { id: string; name: string; room: string; relation: "mapped" | "bound"; controllerCount: number };
export type DeviceControlChannel = { key: string; label: string; channelIndex: number | null; channelSiid: number | null; role: "primary" | "secondary"; targets: DeviceChannelTarget[] };
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
  channels: DeviceControlChannel[];
};

const parentKeys = ["parent_id", "parentId", "parent_did", "parentDid", "pdid", "master_did", "masterDid", "main_did", "mainDid", "source_did", "sourceDid", "physical_did", "physicalDid", "host_did", "hostDid", "bind_did", "bindDid", "bound_did", "target_did", "targetDid", "linked_did", "linkedDid", "owner_did", "ctrl_did"];
const childKeys = ["children", "child_devices", "child_dids", "sub_devices", "subDevices", "sub_dids", "sub_list", "split_devices", "splitDevices", "virtual_devices", "virtualDevices", "slave_devices", "slaves", "bound_devices", "mapped_devices"];
const channelKeys = ["channel_index", "channelIndex", "button_index", "buttonIndex", "key_index", "keyIndex", "switch_index", "switchIndex", "channel", "channel_id", "key_id", "keyId", "button", "sub_id"];
const serviceKeys = ["parent_siid", "parentSiid", "target_siid", "targetSiid", "service_iid", "serviceIid", "siid"];
const targetChannelKeys = ["target_channel_index", "targetChannelIndex", "target_button_index", "targetButtonIndex", "target_key_index", "targetKeyIndex", "target_channel", "targetChannel", "master_channel", "masterChannel"];
const targetServiceKeys = ["target_siid", "targetSiid", "target_service_iid", "targetServiceIid", "master_siid", "masterSiid", "bound_siid"];
const containerKeys = ["extra", "prop", "props", "properties", "setting", "settings", "attributes", "device_info", "deviceInfo", "parent", "parent_device", "parentDevice", "bind_info", "bindInfo", "split_device", "splitDevice", "virtual_info", "virtualInfo", "mapping", "control", "ctrl", "slave", "sub_device_info", "channel_info", "channelInfo", "linkage", "automation", "wireless_info"];

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

function channelKey(index: number | null, siid: number | null) {
  return siid !== null ? `service:${siid}` : index !== null ? `button:${index === 0 ? 1 : index}` : "unassigned";
}

function channelMatches(topology: DeviceTopology, index: number | null, siid: number | null) {
  if (siid !== null && topology.channelSiid !== null) return topology.channelSiid === siid;
  if (index !== null && topology.channelIndex !== null) return topology.channelIndex === index || topology.channelIndex === 0 && index === 1 || topology.channelIndex === 1 && index === 0;
  return false;
}

function sourceChannelLabel(index: number | null, siid: number | null) {
  return index !== null ? `按键 ${index === 0 ? 1 : index}` : siid !== null ? `服务 ${siid}` : "未公开按键";
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
    for (const scope of values) for (const key of ["channels", "keys", "buttons", "bindings", "bind_list", "bindList", "bind_info_list", "mappings", "mapping_list", "linkages", "control_targets", "targets"]) if (Array.isArray(scope[key])) entries.push(...scope[key] as unknown[]);
    for (const entry of entries) {
      const item = object(entry);
      if (!item) continue;
      const itemScopes = scopes(item);
      const itemIndex = numberValue(itemScopes, channelKeys), itemSiid = numberValue(itemScopes, serviceKeys);
      const targets: Array<{ id: string | null; data: RawDevice }> = [{ id: boundTarget(item, devices, did), data: item }];
      for (const key of ["targets", "target_dids", "targetDids", "target_list", "devices", "device_ids", "bound_devices", "linked_devices", "control_targets"]) {
        const linked = item[key];
        if (!Array.isArray(linked)) continue;
        for (const candidate of linked) { const record = object(candidate); targets.push({ id: knownId(record?.did ?? record?.id ?? record?.device_id ?? record?.target_did ?? candidate, devices, did), data: record ?? item }); }
      }
      for (const candidate of targets) {
        const targetId = candidate.id;
        if (!targetId) continue;
        const targetValues = scopes(candidate.data);
        const explicitIndex = numberValue(targetValues, targetChannelKeys);
        const explicitSiid = numberValue(targetValues, targetServiceKeys);
        const targetChannelIndex = explicitIndex ?? (candidate.data !== item ? numberValue(targetValues, channelKeys) : null);
        const targetChannelSiid = explicitSiid ?? (candidate.data !== item ? numberValue(targetValues, serviceKeys) : null);
        const bindingKey = `${targetId}:${itemIndex}:${itemSiid}:${targetChannelIndex}:${targetChannelSiid}`;
        if (bindingIds.has(bindingKey)) continue;
        bindingIds.add(bindingKey);
        const target = devices.get(targetId)!;
        bindings.push({ targetId, targetName: String(target.name ?? target.model ?? "受控设备"), targetRoom: String(target.roomName ?? target.room_name ?? "未分配"), channelIndex: itemIndex, channelSiid: itemSiid, targetChannelIndex, targetChannelSiid, viaId: null, viaName: null });
      }
    }

    const relation = parentId ? (parentSwitch || wireless || index !== null || siid !== null ? "mapped" : "subdevice") : "none";
    const entirePanel = isSwitch && (wireless && (index === null || !parentId) || bindings.length > 0 && !parentId && wireless);
    const role = entirePanel ? "secondary-panel" : parentId && relation === "mapped" ? "secondary" : "independent";
    topologies.set(did, { parentId, parentName: parent ? String(parent.name ?? parent.model ?? "主控设备") : null, parentRoom: parent ? String(parent.roomName ?? parent.room_name ?? "未分配") : null, channelIndex: index, channelSiid: siid, channelLabel: channelLabel(values, index, siid), role, relation, childCount: 0, secondaryCount: 0, bindings, controlledBy: [], channels: [] });
  }

  for (const topology of topologies.values()) {
    if (!topology.parentId) continue;
    const parent = topologies.get(topology.parentId);
    if (!parent) continue;
    parent.childCount++;
    if (topology.relation === "mapped") { parent.secondaryCount++; if (parent.role !== "secondary-panel") parent.role = "primary"; }
  }

  for (const topology of topologies.values()) {
    const expanded: DeviceBinding[] = [];
    const seen = new Set<string>();
    for (const binding of topology.bindings) {
      const target = topologies.get(binding.targetId);
      const mapped = target && (binding.targetChannelIndex !== null || binding.targetChannelSiid !== null)
        ? [...topologies.entries()].filter(([, candidate]) => candidate.parentId === binding.targetId && candidate.relation === "mapped" && channelMatches(candidate, binding.targetChannelIndex, binding.targetChannelSiid))
        : [];
      const resolved = mapped.length ? mapped.map(([id]) => {
        const device = devices.get(id)!;
        return { ...binding, targetId: id, targetName: String(device.name ?? device.model ?? "受控设备"), targetRoom: String(device.roomName ?? device.room_name ?? "未分配"), viaId: binding.targetId, viaName: binding.targetName };
      }) : [binding];
      for (const candidate of resolved) {
        const key = `${candidate.targetId}:${candidate.channelIndex}:${candidate.channelSiid}`;
        if (!seen.has(key)) { seen.add(key); expanded.push(candidate); }
      }
    }
    topology.bindings = expanded;
    if (topology.bindings.length && topology.role === "independent") topology.role = "primary";
  }

  for (const [did, topology] of topologies) {
    if (topology.parentId && topology.relation === "mapped") {
      const parent = devices.get(topology.parentId)!;
      topology.controlledBy.push({ sourceId: topology.parentId, sourceName: String(parent.name ?? parent.model ?? "主控设备"), sourceRoom: String(parent.roomName ?? parent.room_name ?? "未分配"), sourceRole: "primary", channelIndex: topology.channelIndex, channelSiid: topology.channelSiid, viaId: null, viaName: null, targetCount: 1 });
    }
    const source = devices.get(did)!;
    for (const binding of topology.bindings) {
      const target = topologies.get(binding.targetId);
      if (!target || target.controlledBy.some(item => item.sourceId === did && item.channelIndex === binding.channelIndex && item.channelSiid === binding.channelSiid)) continue;
      const targetCount = topology.bindings.filter(item => channelKey(item.channelIndex, item.channelSiid) === channelKey(binding.channelIndex, binding.channelSiid)).length;
      target.controlledBy.push({ sourceId: did, sourceName: String(source.name ?? source.model ?? "副控设备"), sourceRoom: String(source.roomName ?? source.room_name ?? "未分配"), sourceRole: topology.role === "secondary-panel" || topology.role === "secondary" ? "secondary" : "primary", channelIndex: binding.channelIndex, channelSiid: binding.channelSiid, viaId: binding.viaId, viaName: binding.viaName, targetCount });
    }
  }

  for (const [did, topology] of topologies) {
    const channels = new Map<string, DeviceControlChannel>();
    const append = (index: number | null, siid: number | null, targetId: string, relation: "mapped" | "bound", label?: string | null) => {
      const key = channelKey(index, siid);
      const channel = channels.get(key) ?? { key, label: label ?? sourceChannelLabel(index, siid), channelIndex: index, channelSiid: siid, role: topology.role === "secondary-panel" || topology.role === "secondary" ? "secondary" as const : "primary" as const, targets: [] };
      const target = devices.get(targetId);
      if (!target || channel.targets.some(item => item.id === targetId)) return;
      channel.targets.push({ id: targetId, name: String(target.name ?? target.model ?? "受控设备"), room: String(target.roomName ?? target.room_name ?? "未分配"), relation, controllerCount: topologies.get(targetId)?.controlledBy.length ?? 0 });
      channels.set(key, channel);
    };
    for (const [targetId, target] of topologies) if (target.parentId === did && target.relation === "mapped") append(target.channelIndex, target.channelSiid, targetId, "mapped", target.channelLabel);
    for (const binding of topology.bindings) append(binding.channelIndex, binding.channelSiid, binding.targetId, "bound");
    topology.channels = [...channels.values()].sort((left, right) => (left.channelIndex ?? left.channelSiid ?? 999) - (right.channelIndex ?? right.channelSiid ?? 999));
  }
  return topologies;
}
