import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listHomes, unseal, type XiaomiSession } from "../../../../lib/xiaomi-cloud";
import { assertHomeAccess, listManualScenes } from "../../../../lib/xiaomi-scenes";

function validIdentifier(value: string | null) {
  return Boolean(value && value.length <= 128 && !/[\u0000-\u001f]/.test(value));
}

export async function GET(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const homeId = request.nextUrl.searchParams.get("homeId");
    if (!validIdentifier(homeId)) return NextResponse.json({ error: "INVALID_HOME_ID" }, { status: 400 });
    const session = await unseal<XiaomiSession>(value);
    const homes = await listHomes(session);
    try { assertHomeAccess(homes, homeId!); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const scenes = await listManualScenes(session, homeId!);
    return NextResponse.json({ ok: true, homeId, scenes, capturedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-scenes-list]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
