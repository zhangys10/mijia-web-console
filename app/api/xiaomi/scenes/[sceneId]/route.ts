import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, unseal, type XiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { assertHomeAccess, listRawManualScenes, parseManualScenes } from "../../../../../lib/xiaomi-scenes";
import { assertBasicSceneDraft, assertSceneActionSources, buildUpdatePayload, createEditorDraft, sceneDraftMatchesWrite, sceneRecordId, sceneRevision, submitSceneEdit, validateSceneDraftCapabilities } from "../../../../../lib/xiaomi-scene-editor";

function validIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

async function context(request: NextRequest, sceneId: string) {
  const value = (await cookies()).get("xiaomi_session")?.value;
  if (!value) return { response: NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 }) };
  const homeId = request.nextUrl.searchParams.get("homeId");
  if (!validIdentifier(homeId) || !validIdentifier(sceneId)) return { response: NextResponse.json({ error: "INVALID_SCENE_COMMAND" }, { status: 400 }) };
  const session = await unseal<XiaomiSession>(value);
  const homes = await listHomes(session);
  try { assertHomeAccess(homes, homeId!); }
  catch { return { response: NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }) }; }
  const scenes = await listRawManualScenes(session, homeId!);
  const scene = scenes.find(item => sceneRecordId(item) === sceneId);
  if (!scene) return { response: NextResponse.json({ error: "XIAOMI_SCENE_NOT_FOUND" }, { status: 404 }) };
  return { session, homeId: homeId!, scene };
}

export async function GET(request: NextRequest, route: { params: Promise<{ sceneId: string }> }) {
  try {
    const { sceneId } = await route.params;
    const current = await context(request, sceneId);
    if (current.response) return current.response;
    return NextResponse.json({ ok: true, draft: await createEditorDraft(current.scene!, current.homeId!) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-scenes-edit-read]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ sceneId: string }> }) {
  try {
    const { sceneId } = await route.params;
    const current = await context(request, sceneId);
    if (current.response) return current.response;
    const draft = assertBasicSceneDraft(await request.json(), true);
    if (draft.homeId !== current.homeId) return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 });
    if (await sceneRevision(current.scene!) !== draft.revision) return NextResponse.json({ error: "XIAOMI_SCENE_CONFLICT" }, { status: 409 });
    const editable = await createEditorDraft(current.scene!, current.homeId!);
    if (draft.actions && !editable.actionsEditable) return NextResponse.json({ error: "XIAOMI_SCENE_ACTIONS_READ_ONLY" }, { status: 409 });
    if (draft.actions) assertSceneActionSources(draft.actions, editable.actions);
    let validated = draft;
    if (draft.actions) {
      const devices = await listDevices(current.session!);
      validated = await validateSceneDraftCapabilities(draft, devices.devices);
    }
    await submitSceneEdit(current.session!, buildUpdatePayload(current.scene!, validated));
    let updated;
    for (let attempt = 0; attempt < 8 && !updated; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
      const scenes = await listRawManualScenes(current.session!, current.homeId!);
      const candidate = scenes.find(scene => sceneRecordId(scene) === sceneId);
      if (candidate && sceneDraftMatchesWrite(await createEditorDraft(candidate, current.homeId!), validated)) updated = candidate;
    }
    if (!updated) throw new Error("XIAOMI_SCENE_WRITE_NOT_VISIBLE");
    const scenes = parseManualScenes({ result: { scene_info_list: [updated] } }, current.homeId!);
    return NextResponse.json({ ok: true, scene: scenes[0], updated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400 : message.endsWith("_UNSUPPORTED") || message.endsWith("_NOT_FOUND") ? 422 : 502;
    console.error("[xiaomi-scenes-update]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
