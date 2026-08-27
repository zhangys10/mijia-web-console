import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listHomes, unseal, type XiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { assertHomeAccess, listManualScenes, runManualScene, selectRunnableManualScene } from "../../../../../lib/xiaomi-scenes";

function validIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    if (!validIdentifier(body.homeId) || !validIdentifier(body.sceneId)) return NextResponse.json({ error: "INVALID_SCENE_COMMAND" }, { status: 400 });
    const homeId = body.homeId as string;
    const sceneId = body.sceneId as string;
    const session = await unseal<XiaomiSession>(value);
    const homes = await listHomes(session);
    try { assertHomeAccess(homes, homeId); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const scenes = await listManualScenes(session, homeId);
    try { selectRunnableManualScene(scenes, homeId, sceneId); }
    catch (error) {
      const message = error instanceof Error ? error.message : "XIAOMI_SCENE_NOT_FOUND";
      return NextResponse.json({ error: message }, { status: message === "XIAOMI_SCENE_DISABLED" ? 409 : 404 });
    }
    await runManualScene(session, sceneId);
    return NextResponse.json({ ok: true, accepted: true, sceneId, submittedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-scenes-run]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
