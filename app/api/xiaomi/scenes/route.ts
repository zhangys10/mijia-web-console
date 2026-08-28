import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, unseal, type XiaomiSession } from "../../../../lib/xiaomi-cloud";
import { assertHomeAccess, listRawManualScenes, parseManualScenes } from "../../../../lib/xiaomi-scenes";
import { assertBasicSceneDraft, buildCreatePayload, createEditorDraft, sceneDraftMatchesWrite, sceneIdFromEditResponse, sceneRecordId, submitSceneEdit, validateSceneDraftCapabilities } from "../../../../lib/xiaomi-scene-editor";

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
    const [rawScenes, devices] = await Promise.all([listRawManualScenes(session, homeId!), listDevices(session).catch(() => ({ devices: [] }))]);
    const scenes = parseManualScenes({ result: rawScenes }, homeId!, devices.devices);
    return NextResponse.json({ ok: true, homeId, scenes, capturedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-scenes-list]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const draft = assertBasicSceneDraft(await request.json(), false);
    if (!draft.actions?.length) return NextResponse.json({ error: "INVALID_SCENE_ACTIONS" }, { status: 400 });
    const session = await unseal<XiaomiSession>(value);
    const homes = await listHomes(session);
    try { assertHomeAccess(homes, draft.homeId); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const before = await listRawManualScenes(session, draft.homeId);
    if (before.some(scene => String(scene.name ?? scene.scene_name ?? "").trim() === draft.name)) return NextResponse.json({ error: "XIAOMI_SCENE_NAME_CONFLICT" }, { status: 409 });
    const devices = await listDevices(session);
    const validated = await validateSceneDraftCapabilities(draft, devices.devices);
    const payload = buildCreatePayload(validated, session.userId);
    const response = await submitSceneEdit(session, payload);
    const responseId = sceneIdFromEditResponse(response);
    const previousIds = new Set(before.map(sceneRecordId));
    let created;
    for (let attempt = 0; attempt < 8 && !created; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
      const scenes = await listRawManualScenes(session, draft.homeId);
      const candidate = scenes.find(scene => responseId && sceneRecordId(scene) === responseId)
        ?? scenes.find(scene => !previousIds.has(sceneRecordId(scene)) && String(scene.name ?? scene.scene_name ?? "").trim() === draft.name);
      if (candidate && sceneDraftMatchesWrite(await createEditorDraft(candidate, draft.homeId), validated)) created = candidate;
    }
    if (!created) throw new Error("XIAOMI_SCENE_WRITE_NOT_VISIBLE");
    const scenes = parseManualScenes({ result: { scene_info_list: [created] } }, draft.homeId, devices.devices);
    return NextResponse.json({ ok: true, scene: scenes[0], created: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400 : message.endsWith("_UNSUPPORTED") || message.endsWith("_NOT_FOUND") ? 422 : 502;
    console.error("[xiaomi-scenes-create]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
