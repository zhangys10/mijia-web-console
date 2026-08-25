import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { collectDeviceGroupMembers, isDeviceGroupId } from "../../../../lib/device-groups";
import { buildDeviceTopology } from "../../../../lib/device-topology";
import { listDevices, unseal, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const result = await listDevices(await unseal<XiaomiSession>(value));
    const topology = buildDeviceTopology(result.devices);
    const groupMembers = collectDeviceGroupMembers(result.devices);
    const devices = result.devices.map((device) => {
      const did = String(device.did ?? "");
      const members = (groupMembers.get(did) ?? []).map(memberId => result.devices.find(item => String(item.did ?? "") === memberId)).filter((item): item is Record<string, unknown> => Boolean(item));
      const status = device.isOnline ?? device.is_online ?? device.online;
      const memberStates = members.map(member => member.isOnline ?? member.is_online ?? member.online).filter(value => value !== undefined);
      return {
        did, name: String(device.name ?? device.model ?? "未命名设备"), model: String(device.model ?? members.find(member => member.model)?.model ?? ""),
        online: status === undefined && isDeviceGroupId(did) ? !memberStates.length || memberStates.some(Boolean) : Boolean(status), room: String(device.roomName ?? "未分配"),
        homeId: String(device.homeId ?? "default"), home: String(device.homeName ?? "我的家"), roomId: String(device.room_id ?? ""),
        icon: device.icon ?? null, parentId: topology.get(did)?.parentId ?? null,
        logicalType: typeof device.type === "string" ? device.type : typeof device.device_type === "string" ? device.device_type : typeof device.deviceType === "string" ? device.deviceType : typeof device.category === "string" ? device.category : "",
        urn: typeof device.urn === "string" ? device.urn : typeof device.spec_type === "string" ? device.spec_type : typeof device.miot_type === "string" ? device.miot_type : null,
        groupMemberIds: groupMembers.get(did) ?? [], groupIds: [...groupMembers].filter(([, ids]) => ids.includes(did)).map(([groupId]) => groupId),
        topology: topology.get(did) ?? null,
      };
    });
    return NextResponse.json({ homes: result.homes, devices });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-devices]", JSON.stringify({ error: message }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
