import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { listDevices, unseal, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const result = await listDevices(await unseal<XiaomiSession>(value));
    const devices = result.devices.map((device) => ({
      did: String(device.did ?? ""), name: String(device.name ?? device.model ?? "未命名设备"), model: String(device.model ?? ""),
      online: Boolean(device.isOnline ?? device.is_online ?? device.online), room: String(device.roomName ?? "未分配"),
      home: String(device.homeName ?? "我的家"), icon: device.icon ?? null, parentId: device.parent_id ?? null,
    }));
    return NextResponse.json({ homes: result.homes, devices });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "UNKNOWN_ERROR" }, { status: 502 });
  }
}
