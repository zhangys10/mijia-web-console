type RawDevice = Record<string, unknown>;

type GroupDevice = {
  did?: string;
  homeId?: string;
  parentId?: string | null;
  groupMemberIds?: string[];
  groupIds?: string[];
  groupMembers?: GroupDevice[];
  members?: Array<{ did?: string }>;
};

const memberFields = ["dids", "did_list", "member_dids", "memberDids", "group_dids", "group_member_dids", "device_ids", "deviceIds", "members", "group_members", "groupMembers", "devices", "device_list", "deviceList", "children", "child_dids", "child_devices", "sub_devices", "sub_dids", "items"];
const membershipFields = ["group_id", "groupId", "group_did", "groupDid", "gid", "group_ids", "groupIds", "groups", "parent_group_id", "parentGroupId", "parent_did", "parentDid", "parentId", "pdid"];
const containerFields = ["group", "group_info", "groupInfo", "group_data", "groupData", "extra", "prop", "props", "properties", "attributes", "device_info", "deviceInfo", "setting", "settings"];

export function isDeviceGroupId(did: string | null | undefined) {
  return Boolean(did && /^group/i.test(did.trim()));
}

function rawRecord(value: unknown): RawDevice | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as RawDevice;
  if (typeof value !== "string" || value.length > 20000 || !value.trim().startsWith("{")) return;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RawDevice : undefined;
  } catch {
    return;
  }
}

function recordScopes(device: RawDevice) {
  const scopes: RawDevice[] = [device];
  for (let index = 0; index < scopes.length && index < 12; index++) {
    for (const key of containerFields) {
      const nested = rawRecord(scopes[index][key]);
      if (nested && !scopes.includes(nested)) scopes.push(nested);
    }
  }
  return scopes;
}

function recordIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recordIds);
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[") && trimmed.length < 20000) {
      try { return recordIds(JSON.parse(trimmed) as unknown); } catch { return []; }
    }
    return trimmed.includes(",") ? trimmed.split(",").map(item => item.trim()).filter(Boolean) : [trimmed];
  }
  const record = rawRecord(value);
  if (!record) return [];
  const direct = record.did ?? record.device_id ?? record.deviceId ?? record.id ?? record.target_did;
  return direct === undefined ? [] : recordIds(direct);
}

function sameGroupId(candidate: string, group: string) {
  if (candidate === group) return true;
  return candidate.replace(/^group[._:\/-]*/i, "") === group.replace(/^group[._:\/-]*/i, "");
}

export function collectDeviceGroupMembers(devices: RawDevice[]) {
  const knownIds = new Set(devices.map(device => String(device.did ?? "")).filter(Boolean));
  const groups = new Map<string, Set<string>>();

  for (const device of devices) {
    const groupId = String(device.did ?? "");
    if (!isDeviceGroupId(groupId)) continue;
    const members = groups.get(groupId) ?? new Set<string>();
    for (const scope of recordScopes(device)) {
      for (const key of memberFields) {
        for (const memberId of recordIds(scope[key])) if (knownIds.has(memberId) && memberId !== groupId) members.add(memberId);
      }
    }
    groups.set(groupId, members);
  }

  for (const device of devices) {
    const memberId = String(device.did ?? "");
    if (!memberId || isDeviceGroupId(memberId)) continue;
    for (const scope of recordScopes(device)) {
      for (const key of membershipFields) {
        for (const candidate of recordIds(scope[key])) {
          for (const [groupId, members] of groups) if (sameGroupId(candidate, groupId)) members.add(memberId);
        }
      }
    }
  }

  return new Map([...groups].map(([groupId, members]) => [groupId, [...members]]));
}

export function organizeDeviceGroups<T extends GroupDevice>(visible: T[], allDevices: T[]): T[] {
  const grouped = new Map<string, T[]>();
  const claimed = new Set<string>();
  const identity = (homeId: string | undefined, did: string) => `${homeId ?? ""}:${did}`;

  for (const group of visible) {
    if (!isDeviceGroupId(group.did) || !group.did) continue;
    const ids = new Set(group.groupMemberIds ?? []);
    for (const candidate of allDevices) {
      if (candidate.homeId !== group.homeId || !candidate.did || candidate.did === group.did) continue;
      if (candidate.groupIds?.some(groupId => sameGroupId(groupId, group.did!)) || candidate.parentId === group.did) ids.add(candidate.did);
    }
    const members: T[] = [];
    for (const did of ids) {
      const member = allDevices.find(candidate => candidate.homeId === group.homeId && candidate.did === did);
      if (!member) continue;
      members.push(member);
      claimed.add(identity(group.homeId, did));
    }
    grouped.set(identity(group.homeId, group.did), members);
  }

  return visible.filter(device => {
    if (isDeviceGroupId(device.did)) return true;
    const ids = [device.did, ...(device.members ?? []).map(member => member.did)].filter((did): did is string => Boolean(did));
    return !ids.some(did => claimed.has(identity(device.homeId, did)));
  }).map(device => {
    if (!isDeviceGroupId(device.did) || !device.did) return device;
    return { ...device, groupMembers: grouped.get(identity(device.homeId, device.did)) ?? [] };
  });
}
