import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";

type RawRecord = Record<string, unknown>;
type Request = typeof xiaomiRequest;

function record(value: unknown): RawRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : undefined;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 100_000 || !/^[\[{]/.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function ids(value: unknown): string[] {
  value = parsedJson(value);
  if (Array.isArray(value)) return value.flatMap(ids);
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") return value.split(",").map(item => item.trim()).filter(Boolean);
  const item = record(value);
  return item ? ids(item.did ?? item.device_id ?? item.deviceId ?? item.id) : [];
}

function canonicalGroupId(value: string) {
  return value.replace(/^group[._:\/-]*/i, "");
}

function activeMembership(value: unknown) {
  return value !== false && value !== 0 && value !== "0" && value !== null;
}

export function parseDeviceGroupMemberships(response: unknown, requestedGroupDids: string[]) {
  const requested = new Map(requestedGroupDids.map(did => [canonicalGroupId(did), did]));
  const result = record(response)?.result ?? response;
  const collectEntries = (value: unknown, depth = 0): Array<{ groupDid?: string; value: unknown }> => {
    value = parsedJson(value);
    if (depth > 4) return [];
    if (Array.isArray(value)) return value.flatMap(item => collectEntries(item, depth + 1));
    const item = record(value);
    if (!item) return [];
    const directDid = String(item.did ?? item.group_did ?? item.groupDid ?? item.group_id ?? item.groupId ?? item.gid ?? "");
    if (requested.has(canonicalGroupId(directDid))) return [{ value: item }];
    return Object.entries(item).flatMap(([key, nested]) => {
      const groupDid = requested.get(canonicalGroupId(key));
      return groupDid ? [{ groupDid, value: nested }] : collectEntries(nested, depth + 1);
    });
  };
  const entries = collectEntries(result);
  const groups = new Map(requestedGroupDids.map(did => [did, new Set<string>()]));
  for (const entry of entries) {
    const item = record(entry.value);
    if (!item) continue;
    const candidate = entry.groupDid ?? String(item.did ?? item.group_did ?? item.groupDid ?? item.group_id ?? item.groupId ?? item.gid ?? "");
    const groupDid = requested.get(canonicalGroupId(candidate));
    if (!groupDid) continue;
    const members = groups.get(groupDid)!;
    const membershipValue = parsedJson(item.membership ?? item.member_ship ?? item.memberMap);
    const membership = record(membershipValue);
    if (membership) {
      for (const [did, status] of Object.entries(membership)) if (activeMembership(status)) members.add(did);
    } else {
      for (const did of ids(membershipValue)) members.add(did);
    }
    for (const field of ["member_dids", "memberDids", "member_list", "memberList", "members", "devices", "children", "dids"]) {
      for (const did of ids(item[field])) members.add(did);
    }
    members.delete(groupDid);
  }
  return new Map([...groups].map(([groupDid, members]) => [groupDid, [...members]]));
}

export async function loadDeviceGroupMemberships(session: XiaomiSession, groupDids: string[], request: Request = xiaomiRequest) {
  if (!groupDids.length) return new Map<string, string[]>();
  const response = await request(session, "/app/v2/groupv2/query_status", { group_did: groupDids });
  return parseDeviceGroupMemberships(response, groupDids);
}

export function mergeDeviceGroupMemberships(...sources: Map<string, string[]>[]) {
  const merged = new Map<string, Set<string>>();
  for (const source of sources) for (const [groupDid, memberDids] of source) {
    const members = merged.get(groupDid) ?? new Set<string>();
    memberDids.forEach(did => members.add(did));
    merged.set(groupDid, members);
  }
  return new Map([...merged].map(([groupDid, members]) => [groupDid, [...members]]));
}
