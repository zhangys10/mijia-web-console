import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, unseal, type XiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { assertHomeAccess } from "../../../../../lib/xiaomi-scenes";
import { listRawAutomations, parseAutomations } from "../../../../../lib/xiaomi-automations";
import { assertAutomationDraft, automationDraftMatchesWrite, buildAutomationUpdatePayload, createAutomationEditorDraft, resolveAutomationTriggerSelections } from "../../../../../lib/xiaomi-automation-editor";
import { assertSceneActionSources, createEditorDraft, sceneDraftMatchesWrite, sceneRecordId, sceneRevision, submitSceneEdit, validateSceneDraftCapabilities } from "../../../../../lib/xiaomi-scene-editor";

function validIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

async function context(request: NextRequest, automationId: string) {
  const value = (await cookies()).get("xiaomi_session")?.value;
  if (!value) return { response: NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 }) };
  const homeId = request.nextUrl.searchParams.get("homeId");
  if (!validIdentifier(homeId) || !validIdentifier(automationId)) return { response: NextResponse.json({ error: "INVALID_AUTOMATION_COMMAND" }, { status: 400 }) };
  const session = await unseal<XiaomiSession>(value);
  const homes = await listHomes(session);
  try { assertHomeAccess(homes, homeId!); }
  catch { return { response: NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 }) }; }
  const automations = await listRawAutomations(session, homeId!);
  const automation = automations.find(item => sceneRecordId(item) === automationId);
  if (!automation) return { response: NextResponse.json({ error: "XIAOMI_AUTOMATION_NOT_FOUND" }, { status: 404 }) };
  return { session, homeId: homeId!, automation, automations };
}

export async function GET(request: NextRequest, route: { params: Promise<{ automationId: string }> }) {
  try {
    const { automationId } = await route.params;
    const current = await context(request, automationId);
    if (current.response) return current.response;
    return NextResponse.json({ ok: true, draft: await createAutomationEditorDraft(current.automation!, current.homeId!) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ automationId: string }> }) {
  try {
    const { automationId } = await route.params;
    const current = await context(request, automationId);
    if (current.response) return current.response;
    const draft = assertAutomationDraft(await request.json(), true);
    if (draft.homeId !== current.homeId) return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 });
    if (await sceneRevision(current.automation!) !== draft.revision) return NextResponse.json({ error: "XIAOMI_AUTOMATION_CONFLICT" }, { status: 409 });
    const editable = await createAutomationEditorDraft(current.automation!, current.homeId!);
    if (draft.schedule && !editable.triggerEditable) return NextResponse.json({ error: "XIAOMI_AUTOMATION_TRIGGER_READ_ONLY" }, { status: 409 });
    if (draft.actions && !editable.actionsEditable) return NextResponse.json({ error: "XIAOMI_AUTOMATION_ACTIONS_READ_ONLY" }, { status: 409 });
    if (draft.actions) assertSceneActionSources(draft.actions, editable.actions);
    let validated = draft;
    const devices = await listDevices(current.session!);
    if (draft.actions) validated = await validateSceneDraftCapabilities(draft, devices.devices, undefined, true);
    const templates = resolveAutomationTriggerSelections(current.automations!, draft.triggerSelections);
    const expected = { ...validated, schedule: draft.schedule, triggerSelections: draft.triggerSelections, triggerMode: draft.triggerMode };
    await submitSceneEdit(current.session!, buildAutomationUpdatePayload(current.automation!, expected, draft.triggerSelections ? templates : undefined));
    let updated;
    for (let attempt = 0; attempt < 8 && !updated; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
      const candidate = (await listRawAutomations(current.session!, current.homeId!)).find(scene => sceneRecordId(scene) === automationId);
      if (candidate && await automationDraftMatchesWrite(candidate, current.homeId!, expected) && sceneDraftMatchesWrite(await createEditorDraft(candidate, current.homeId!), validated)) updated = candidate;
    }
    if (!updated) throw new Error("XIAOMI_AUTOMATION_WRITE_NOT_VISIBLE");
    return NextResponse.json({ ok: true, automation: parseAutomations({ result: [updated] }, current.homeId!, devices.devices)[0], updated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400 : message.includes("CONFLICT") || message.includes("READ_ONLY") ? 409 : message.endsWith("_NOT_FOUND") || message.endsWith("_UNSUPPORTED") ? 422 : 502;
    console.error("[xiaomi-automations-update]", JSON.stringify({ error: message }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
