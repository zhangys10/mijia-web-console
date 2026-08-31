import { parsedSceneRecord, type XiaomiSceneRecord } from "./xiaomi-scenes.ts";
import {
  assertBasicSceneDraft,
  buildCreatePayload,
  buildUpdatePayload,
  createEditorDraft,
  sceneRecordId,
  type SceneEditorDraft,
  type SceneWriteDraft,
} from "./xiaomi-scene-editor.ts";
import { parseAutomationTrigger, rawAutomationTriggers } from "./xiaomi-automations.ts";

export type AutomationSchedule = { time: string; weekdays: number[] };
export type AutomationTriggerSelection = { automationId: string; sourceIndex: number };
export type AutomationEditorDraft = SceneEditorDraft & {
  schedule?: AutomationSchedule;
  triggerSelections?: AutomationTriggerSelection[];
  triggerMode: "all" | "any";
  triggerEditable: boolean;
  triggerLabel: string;
};
export type AutomationWriteDraft = SceneWriteDraft & {
  schedule?: AutomationSchedule;
  triggerSelections?: AutomationTriggerSelection[];
  triggerMode?: "all" | "any";
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function assertAutomationDraft(value: unknown, editing: boolean): AutomationWriteDraft {
  const draft = record(value);
  const scene = assertBasicSceneDraft(value, editing);
  let triggerSelections: AutomationTriggerSelection[] | undefined;
  if (draft?.triggerSelections !== undefined) {
    if (!Array.isArray(draft.triggerSelections) || draft.triggerSelections.length > 16) throw new Error("INVALID_AUTOMATION_TRIGGERS");
    triggerSelections = draft.triggerSelections.map(item => {
      const selection = record(item);
      const automationId = typeof selection?.automationId === "string" ? selection.automationId : "";
      const sourceIndex = Number(selection?.sourceIndex);
      if (!automationId || automationId.length > 128 || /[\u0000-\u001f]/.test(automationId) || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > 63) throw new Error("INVALID_AUTOMATION_TRIGGER");
      return { automationId, sourceIndex };
    });
  }
  const triggerMode = draft?.triggerMode === "all" ? "all" : "any";
  if (draft?.schedule === undefined) return { ...scene, ...(triggerSelections ? { triggerSelections } : {}), triggerMode };
  const schedule = record(draft.schedule);
  const time = typeof schedule?.time === "string" ? schedule.time : "";
  const weekdays = Array.isArray(schedule?.weekdays) ? [...new Set(schedule.weekdays.map(Number))].sort() : [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || weekdays.length < 1 || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("INVALID_AUTOMATION_SCHEDULE");
  return { ...scene, schedule: { time, weekdays }, ...(triggerSelections ? { triggerSelections } : {}), triggerMode };
}

export async function createAutomationEditorDraft(scene: XiaomiSceneRecord, homeId: string): Promise<AutomationEditorDraft> {
  const draft = await createEditorDraft(scene, homeId);
  const triggers = rawAutomationTriggers(scene).map(parseAutomationTrigger);
  const trigger = triggers.length === 1 ? triggers[0] : undefined;
  const parsed = parsedSceneRecord(scene) ?? scene;
  const triggerContainer = record(parsed.scene_trigger ?? parsed.trigger);
  const schedule = trigger?.kind === "schedule" && trigger.editable && trigger.time ? { time: trigger.time, weekdays: trigger.weekdays?.length ? trigger.weekdays : [1, 2, 3, 4, 5, 6, 7] } : undefined;
  return {
    ...draft,
    ...(schedule ? { schedule } : { triggerSelections: rawAutomationTriggers(scene).map((_, sourceIndex) => ({ automationId: draft.sceneId, sourceIndex })) }),
    triggerMode: Number(triggerContainer?.express) === 1 ? "all" : "any",
    triggerEditable: triggers.every(item => item.kind !== "unknown"),
    triggerLabel: triggers.map(item => item.label).join(" 且 ") || "未知触发条件",
  };
}

export function resolveAutomationTriggerSelections(scenes: XiaomiSceneRecord[], selections: AutomationTriggerSelection[] = []) {
  return selections.map(selection => {
    const scene = scenes.find(item => sceneRecordId(item) === selection.automationId);
    const trigger = scene && rawAutomationTriggers(scene)[selection.sourceIndex];
    if (!trigger) throw new Error("XIAOMI_AUTOMATION_TRIGGER_NOT_FOUND");
    return trigger;
  });
}

function scheduleTrigger(schedule: AutomationSchedule) {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const everyDay = schedule.weekdays.length === 7;
  return {
    id: 0,
    order: 1,
    src: "timer",
    name: `${everyDay ? "每天" : `周${schedule.weekdays.map(day => "一二三四五六日"[day - 1]).join("、")}`} ${schedule.time}`,
    key: "timer",
    value_type: 5,
    payload_json: {
      timer: { time: schedule.time, hour, minute, weekdays: schedule.weekdays, timezone_id: "Asia/Shanghai" },
    },
  };
}

function triggerRecords(draft: AutomationWriteDraft, templates: XiaomiSceneRecord[]) {
  const values = [...(draft.schedule ? [scheduleTrigger(draft.schedule)] : []), ...templates].map((trigger, index) => ({ ...JSON.parse(JSON.stringify(trigger)) as XiaomiSceneRecord, id: index, order: index + 1 }));
  if (!values.length) throw new Error("INVALID_AUTOMATION_TRIGGERS");
  return values;
}

export function buildAutomationCreatePayload(draft: AutomationWriteDraft, userId: string, templates: XiaomiSceneRecord[] = []) {
  const output = buildCreatePayload(draft, userId);
  output.scene_trigger = { express: draft.triggerMode === "all" ? 1 : 0, triggers: triggerRecords(draft, templates) };
  return output;
}

export function buildAutomationUpdatePayload(scene: XiaomiSceneRecord, draft: AutomationWriteDraft, templates?: XiaomiSceneRecord[]) {
  const output = buildUpdatePayload(scene, draft);
  if (draft.schedule || templates) {
    const container = record(output.scene_trigger) ?? {};
    output.scene_trigger = { ...container, express: draft.triggerMode === "all" ? 1 : 0, triggers: triggerRecords(draft, templates ?? []) };
  }
  return output;
}

export async function automationDraftMatchesWrite(scene: XiaomiSceneRecord, homeId: string, expected: AutomationWriteDraft) {
  const actual = await createAutomationEditorDraft(scene, homeId);
  if (actual.name !== expected.name || expected.enabled !== undefined && actual.enabled !== expected.enabled) return false;
  if (expected.triggerMode && actual.triggerMode !== expected.triggerMode) return false;
  if (expected.schedule && (actual.schedule?.time !== expected.schedule.time || actual.schedule.weekdays.join(",") !== expected.schedule.weekdays.join(","))) return false;
  return true;
}
