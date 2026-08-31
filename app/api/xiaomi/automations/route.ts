import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, unseal, xiaomiErrorInfo, type XiaomiSession } from "../../../../lib/xiaomi-cloud";
import { assertHomeAccess } from "../../../../lib/xiaomi-scenes";
import { listRawAutomations, parseAutomations } from "../../../../lib/xiaomi-automations";
import { assertAutomationDraft, automationDraftMatchesWrite, buildAutomationCreatePayload, resolveAutomationTriggerSelections } from "../../../../lib/xiaomi-automation-editor";
import { createEditorDraft, sceneDraftMatchesWrite, sceneIdFromEditResponse, sceneRecordId, submitSceneEdit, validateSceneDraftCapabilities } from "../../../../lib/xiaomi-scene-editor";

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
    const [raw, devices] = await Promise.all([listRawAutomations(session, homeId!), listDevices(session)]);
    return NextResponse.json({ ok: true, homeId, automations: parseAutomations({ result: raw }, homeId!, devices.devices), capturedAt: new Date().toISOString() });
  } catch (error) {
    const failure = xiaomiErrorInfo(error);
    console.error("[xiaomi-automations-list]", JSON.stringify({ error: failure.message }));
    if (failure.status === 401) (await cookies()).delete("xiaomi_session");
    return NextResponse.json({ ok: false, error: failure.message, retryable: failure.retryable }, { status: failure.status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const draft = assertAutomationDraft(await request.json(), false);
    if (!draft.schedule && !draft.triggerSelections?.length || !draft.actions?.length) return NextResponse.json({ error: "INVALID_AUTOMATION_DRAFT" }, { status: 400 });
    const session = await unseal<XiaomiSession>(value);
    const homes = await listHomes(session);
    try { assertHomeAccess(homes, draft.homeId); }
    catch { return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }); }
    const before = await listRawAutomations(session, draft.homeId);
    if (before.some(scene => String(scene.name ?? scene.scene_name ?? "").trim() === draft.name)) return NextResponse.json({ error: "XIAOMI_AUTOMATION_NAME_CONFLICT" }, { status: 409 });
    const devices = await listDevices(session);
    const validated = await validateSceneDraftCapabilities(draft, devices.devices);
    const templates = resolveAutomationTriggerSelections(before, draft.triggerSelections);
    const expected = { ...validated, schedule: draft.schedule, triggerSelections: draft.triggerSelections, triggerMode: draft.triggerMode };
    const response = await submitSceneEdit(session, buildAutomationCreatePayload(expected, session.userId, templates));
    const responseId = sceneIdFromEditResponse(response);
    const previousIds = new Set(before.map(sceneRecordId));
    let created;
    for (let attempt = 0; attempt < 8 && !created; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
      const candidates = await listRawAutomations(session, draft.homeId);
      const candidate = candidates.find(scene => responseId && sceneRecordId(scene) === responseId)
        ?? candidates.find(scene => !previousIds.has(sceneRecordId(scene)) && String(scene.name ?? scene.scene_name ?? "").trim() === draft.name);
      if (candidate && await automationDraftMatchesWrite(candidate, draft.homeId, expected) && sceneDraftMatchesWrite(await createEditorDraft(candidate, draft.homeId), validated)) created = candidate;
    }
    if (!created) throw new Error("XIAOMI_AUTOMATION_WRITE_NOT_VISIBLE");
    return NextResponse.json({ ok: true, automation: parseAutomations({ result: [created] }, draft.homeId, devices.devices)[0], created: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400 : message.endsWith("_NOT_FOUND") || message.endsWith("_UNSUPPORTED") ? 422 : 502;
    console.error("[xiaomi-automations-create]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
