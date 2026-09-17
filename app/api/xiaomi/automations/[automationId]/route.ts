import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { listDevices, listHomes, readXiaomiSession } from "../../../../../lib/xiaomi-cloud";
import { assertHomeAccess } from "../../../../../lib/xiaomi-scenes";
import { automationConditionContainer, listRawAutomations, parseAutomations } from "../../../../../lib/xiaomi-automations";
import { assertAutomationDraft, automationConditionsMatchWrite, automationDraftMatchesWrite, automationEffectiveTimeMatchesWrite, automationTriggersMatchWrite, buildAutomationUpdatePayload, createAutomationEditorDraft, resolveAutomationTriggerSelections, restoreAutomationConditionSourceIndexes } from "../../../../../lib/xiaomi-automation-editor";
import { assertSceneActionSources, createEditorDraft, sceneDraftActionMatchesWrite, sceneDraftMatchesWrite, sceneRecordId, sceneRevision, submitSceneEdit, validateSceneDraftCapabilities } from "../../../../../lib/xiaomi-scene-editor";

function validIdentifier(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
}

function conditionDraftSummary(value: unknown) {
  return Array.isArray(value) ? value.map(item => {
    const node = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
    const sourceIndex = Number(node?.sourceIndex);
    return {
      kind: typeof node?.kind === "string" ? node.kind : "unknown",
      sourceIndex: Number.isInteger(sourceIndex) ? sourceIndex : null,
      hasDevice: typeof node?.did === "string" && node.did.length > 0,
      hasTimeRange: Boolean(node?.timeRange),
      hasWeekdays: Array.isArray(node?.weekdays),
    };
  }) : [];
}

function rawConditionSummary(scene: Record<string, unknown>) {
  const container = automationConditionContainer(scene);
  const values = Array.isArray(container?.conditions) ? container.conditions : [];
  return {
    containerFields: container ? Object.keys(container).sort() : [],
    count: values.length,
    entries: values.map(item => {
      const node = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
      return node ? Object.keys(node).sort() : null;
    }),
    srcClasses: values.map(item => {
      const node = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : undefined;
      const src = typeof node?.src === "string" ? node.src : null;
      if (!src) return "missing";
      if (["device", "timer", "weather", "location", "user", "scene", "cloud"].includes(src.toLowerCase())) return src.toLowerCase();
      return "opaque";
    }),
  };
}

async function context(request: NextRequest, automationId: string) {
  const value = (await cookies()).get("xiaomi_session")?.value;
  if (!value) return { response: NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 }) };
  const homeId = request.nextUrl.searchParams.get("homeId");
  if (!validIdentifier(homeId) || !validIdentifier(automationId)) return { response: NextResponse.json({ error: "INVALID_AUTOMATION_COMMAND" }, { status: 400 }) };
  const session = await readXiaomiSession(value);
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
    const devices = await listDevices(current.session!);
    return NextResponse.json({ ok: true, draft: await createAutomationEditorDraft(current.automation!, current.homeId!, devices.devices) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}

export async function PUT(request: NextRequest, route: { params: Promise<{ automationId: string }> }) {
  let diagnostics: Record<string, unknown> = {};
  try {
    const { automationId } = await route.params;
    const current = await context(request, automationId);
    if (current.response) return current.response;
    let draft = assertAutomationDraft(await request.json(), true);
    if (draft.homeId !== current.homeId) return NextResponse.json({ error: "XIAOMI_HOME_NOT_FOUND" }, { status: 404 });
    if (await sceneRevision(current.automation!) !== draft.revision) return NextResponse.json({ error: "XIAOMI_AUTOMATION_CONFLICT" }, { status: 409 });
    const devices = await listDevices(current.session!);
    const editable = await createAutomationEditorDraft(current.automation!, current.homeId!, devices.devices);
    draft = { ...draft, conditions: restoreAutomationConditionSourceIndexes(draft.conditions, editable.conditions) };
    if (draft.schedule && !editable.triggerEditable) return NextResponse.json({ error: "XIAOMI_AUTOMATION_TRIGGER_READ_ONLY" }, { status: 409 });
    if (draft.actions && !editable.actionsEditable) return NextResponse.json({ error: "XIAOMI_AUTOMATION_ACTIONS_READ_ONLY" }, { status: 409 });
    if (draft.actions) assertSceneActionSources(draft.actions, editable.actions);
    const changedActions = draft.actions?.filter(action => action.sourceIndex === undefined || !sceneDraftActionMatchesWrite(action, editable.actions[action.sourceIndex])) ?? [];
    if (changedActions.length) await validateSceneDraftCapabilities({ ...draft, actions: changedActions }, devices.devices, undefined, true);
    const triggersChanged = !automationTriggersMatchWrite(editable, draft);
    const conditionValuesChanged = !automationConditionsMatchWrite(editable.conditions, draft.conditions);
    const conditionsChanged = conditionValuesChanged || editable.conditionMode !== draft.conditionMode;
    const effectiveTimeChanged = !automationEffectiveTimeMatchesWrite(editable.effectiveTime, draft.effectiveTime);
    const templates = triggersChanged && draft.triggerSelections
      ? resolveAutomationTriggerSelections(current.automations!, draft.triggerSelections)
      : undefined;
    const { schedule, triggerSelections, conditions, effectiveTime, ...baseDraft } = draft;
    const writeDraft = {
      ...baseDraft,
      ...(triggersChanged && schedule ? { schedule } : {}),
      ...(triggersChanged && triggerSelections ? { triggerSelections } : {}),
      ...(conditionsChanged && conditions ? { conditions, conditionMode: draft.conditionMode } : {}),
      ...(effectiveTimeChanged && effectiveTime ? { effectiveTime } : {}),
    };
    const expected = { ...draft, schedule: draft.schedule, triggerSelections: draft.triggerSelections, triggerMode: draft.triggerMode, conditionMode: draft.conditionMode, conditions: draft.conditions, falseActions: draft.falseActions, effectiveTime: draft.effectiveTime };
    if (conditionsChanged) {
      diagnostics = {
        conditions: conditionDraftSummary(draft.conditions),
        submittedConditionMode: draft.conditionMode,
        storedConditionMode: editable.conditionMode,
        raw: rawConditionSummary(current.automation!),
      };
    }
    await submitSceneEdit(current.session!, buildAutomationUpdatePayload(current.automation!, writeDraft, templates));
    let updated;
    for (let attempt = 0; attempt < 8 && !updated; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 750));
      const candidate = (await listRawAutomations(current.session!, current.homeId!)).find(scene => sceneRecordId(scene) === automationId);
      if (candidate && await automationDraftMatchesWrite(candidate, current.homeId!, expected) && sceneDraftMatchesWrite(await createEditorDraft(candidate, current.homeId!), expected)) updated = candidate;
    }
    if (!updated) throw new Error("XIAOMI_AUTOMATION_WRITE_NOT_VISIBLE");
    return NextResponse.json({ ok: true, automation: parseAutomations({ result: [updated] }, current.homeId!, devices.devices)[0], updated: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    const status = message.startsWith("INVALID_") ? 400
      : message.includes("CONFLICT") || message.includes("READ_ONLY") ? 409
      : message.endsWith("_NOT_FOUND") || message.endsWith("_UNSUPPORTED") || message.startsWith("XIAOMI_AUTOMATION_CONDITION_") ? 422
      : 502;
    console.error("[xiaomi-automations-update]", JSON.stringify({ error: message, diagnostics }));
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
