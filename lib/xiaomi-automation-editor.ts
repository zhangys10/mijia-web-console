import { parsedSceneRecord, type XiaomiSceneRecord } from "./xiaomi-scenes.ts";
import {
  assertBasicSceneDraft,
  buildCreatePayload,
  buildUpdatePayload,
  createEditorDraft,
  parsedAction,
  replaceElseActions,
  sceneRecordId,
  type SceneDraftAction,
  type SceneDraftUnsupportedAction,
  type SceneEditorDraft,
  type SceneWriteDraft,
} from "./xiaomi-scene-editor.ts";
import { automationConditionContainer, automationConditionEntries, elseActionEntries, parseAutomationCondition, parseAutomationTrigger, rawAutomationTriggers, type AutomationTrigger } from "./xiaomi-automations.ts";

export type AutomationSchedule = { time: string; weekdays: number[] };
export type AutomationTriggerSelection = { automationId: string; sourceIndex: number; label?: string };
export type AutomationConditionDraft = {
  kind: "device" | "time" | "weather" | "custom" | "unknown";
  sourceIndex?: number;
  label: string;
  detail?: string;
  deviceName?: string;
  room?: string;
  model?: string;
  did?: string;
  siid?: number;
  piid?: number;
  value?: unknown;
  timeRange?: { start: string; end: string };
  weekdays?: number[];
};
export type AutomationEffectiveTimeDraft = {
  type: "all-day" | "custom";
  start?: string;
  end?: string;
  weekdays: number[];
};
export type AutomationEditorDraft = SceneEditorDraft & {
  schedule?: AutomationSchedule;
  triggerSelections?: AutomationTriggerSelection[];
  triggers?: AutomationTrigger[];
  triggerMode: "all" | "any";
  triggerEditable: boolean;
  triggerLabel: string;
  conditionMode?: "all" | "any";
  conditions?: AutomationConditionDraft[];
  falseActions?: Array<SceneDraftAction | SceneDraftUnsupportedAction>;
  effectiveTime?: AutomationEffectiveTimeDraft;
};
export type AutomationWriteDraft = SceneWriteDraft & {
  schedule?: AutomationSchedule;
  triggerSelections?: AutomationTriggerSelection[];
  triggerMode?: "all" | "any";
  conditionMode?: "all" | "any";
  conditions?: AutomationConditionDraft[];
  falseActions?: SceneDraftAction[];
  effectiveTime?: AutomationEffectiveTimeDraft;
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
      const label = typeof selection?.label === "string" ? selection.label : undefined;
      return { automationId, sourceIndex, ...(label ? { label } : {}) };
    });
  }
  const triggerMode: "all" | "any" = draft?.triggerMode === "all" ? "all" : "any";
  const conditionMode: "all" | "any" = draft?.conditionMode === "any" ? "any" : "all";
  const rawConditions = Array.isArray(draft?.conditions) ? draft.conditions : undefined;
  const conditions: AutomationConditionDraft[] | undefined = rawConditions?.map(item => {
    const c = record(item);
    if (!c) return { kind: "custom" as const, label: "条件" };
    const label = typeof c.label === "string" ? c.label : "条件";
    const kind = (c.kind === "device" || c.kind === "time" || c.kind === "weather" || c.kind === "unknown" ? c.kind : "custom") as AutomationConditionDraft["kind"];
    return {
      kind,
      label,
      ...(Number.isInteger(c.sourceIndex) && Number(c.sourceIndex) >= 0 ? { sourceIndex: Number(c.sourceIndex) } : {}),
      ...(typeof c.detail === "string" ? { detail: c.detail } : {}),
      ...(typeof c.deviceName === "string" ? { deviceName: c.deviceName } : {}),
      ...(typeof c.room === "string" ? { room: c.room } : {}),
      ...(typeof c.did === "string" ? { did: c.did } : {}),
      ...(Number.isInteger(c.siid) ? { siid: Number(c.siid) } : {}),
      ...(Number.isInteger(c.piid) ? { piid: Number(c.piid) } : {}),
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(record(c.timeRange) && typeof record(c.timeRange)?.start === "string" && typeof record(c.timeRange)?.end === "string" ? { timeRange: { start: String(record(c.timeRange)!.start), end: String(record(c.timeRange)!.end) } } : {}),
      ...(Array.isArray(c.weekdays) ? { weekdays: [...new Set(c.weekdays.map(Number))].sort() } : {}),
    };
  });
  let falseActions: SceneDraftAction[] | undefined;
  if (draft?.falseActions !== undefined) {
    if (!Array.isArray(draft.falseActions)) throw new Error("INVALID_SCENE_ACTIONS");
    if (draft.falseActions.length > 0) {
      falseActions = assertBasicSceneDraft({
        homeId: scene.homeId,
        name: scene.name,
        actions: draft.falseActions,
      }, false).actions;
    }
  }
  let effectiveTime: AutomationEffectiveTimeDraft | undefined;
  if (draft?.effectiveTime) {
    const eff = record(draft.effectiveTime);
    const weekdays = Array.isArray(eff?.weekdays) ? [...new Set(eff.weekdays.map(Number))].sort() : [1, 2, 3, 4, 5, 6, 7];
    effectiveTime = {
      type: eff?.type === "custom" ? "custom" : "all-day",
      ...(typeof eff?.start === "string" ? { start: eff.start } : {}),
      ...(typeof eff?.end === "string" ? { end: eff.end } : {}),
      weekdays,
    };
  }

  const extraFields = {
    ...(triggerSelections ? { triggerSelections } : {}),
    triggerMode,
    ...(conditions ? { conditions, conditionMode } : {}),
    ...(falseActions?.length ? { falseActions } : {}),
    ...(effectiveTime ? { effectiveTime } : {}),
  };

  if (draft?.schedule === undefined) return { ...scene, ...extraFields };
  const schedule = record(draft.schedule);
  const time = typeof schedule?.time === "string" ? schedule.time : "";
  const weekdays = Array.isArray(schedule?.weekdays) ? [...new Set(schedule.weekdays.map(Number))].sort() : [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || weekdays.length < 1 || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error("INVALID_AUTOMATION_SCHEDULE");
  return { ...scene, schedule: { time, weekdays }, ...extraFields };
}

export async function createAutomationEditorDraft(scene: XiaomiSceneRecord, homeId: string, devices: XiaomiSceneRecord[] = []): Promise<AutomationEditorDraft> {
  const draft = await createEditorDraft(scene, homeId);
  const scopedDevices = devices.filter(device => String(device.homeId ?? device.home_id ?? "") === String(homeId) && device.did);
  const targetDevices = scopedDevices.length > 0 ? scopedDevices : devices.filter(device => Boolean(device.did));
  const devicesByDid = new Map(targetDevices.map(device => [String(device.did), {
    deviceName: String(device.name || device.model || "未命名设备"),
    room: String(device.room ?? device.roomName ?? device.room_name ?? "未分配"),
    model: String(device.model || ""),
  }]));

  const triggers = rawAutomationTriggers(scene).map(t => parseAutomationTrigger(t, devicesByDid));
  const trigger = triggers.length === 1 ? triggers[0] : undefined;
  const parsed = parsedSceneRecord(scene) ?? scene;
  const triggerContainer = parsedSceneRecord(parsed.scene_trigger ?? parsed.trigger ?? scene.scene_trigger ?? scene.trigger);
  const schedule = trigger?.kind === "schedule" && trigger.editable && trigger.time ? { time: trigger.time, weekdays: trigger.weekdays?.length ? trigger.weekdays : [1, 2, 3, 4, 5, 6, 7] } : undefined;

  const conditionContainer = automationConditionContainer(scene);
  const parsedConditions: AutomationConditionDraft[] = automationConditionEntries(scene).flatMap(({ index, value }) => {
    const p = parseAutomationCondition(value, devicesByDid);
    return [{
      sourceIndex: index,
      kind: p.kind === "unknown" ? "custom" as const : p.kind,
      label: p.label,
      ...(p.did ? { did: p.did } : {}),
      ...(p.detail ? { detail: p.detail } : {}),
      ...(p.deviceName ? { deviceName: p.deviceName } : {}),
      ...(p.room ? { room: p.room } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.timeRange ? { timeRange: p.timeRange } : {}),
      ...(p.weekdays ? { weekdays: p.weekdays } : {}),
    }];
  });

  const validElseActions = elseActionEntries(scene);
  const parsedFalseActions: Array<SceneDraftAction | SceneDraftUnsupportedAction> = validElseActions.map((item, index) => {
    const action = parsedAction(item, index);
    const did = action.kind === "set-properties" || action.kind === "invoke-action" ? action.did : undefined;
    const fallbackDeviceName = did ? devicesByDid.get(did)?.deviceName : undefined;
    return {
      ...action,
      clientId: `false-${action.clientId}`,
      ...(fallbackDeviceName && !action.deviceName ? { deviceName: fallbackDeviceName } : {}),
    };
  });

  const timeFilter = parsedSceneRecord(parsed.time_filter ?? parsed.timer_filter ?? scene.time_filter ?? scene.timer_filter);
  let effectiveTime: AutomationEffectiveTimeDraft | undefined;
  if (timeFilter) {
    const start = typeof timeFilter.start === "string" ? timeFilter.start : undefined;
    const end = typeof timeFilter.end === "string" ? timeFilter.end : undefined;
    const rawDays = timeFilter.weekdays ?? timeFilter.repeat;
    const weekdays = Array.isArray(rawDays) ? rawDays.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7];
    effectiveTime = {
      type: start && end ? "custom" : "all-day",
      ...(start ? { start } : {}),
      ...(end ? { end } : {}),
      weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5, 6, 7],
    };
  }

  return {
    ...draft,
    actions: draft.actions.map(action => {
      if (action.kind === "set-properties" || action.kind === "invoke-action") {
        const fallbackName = devicesByDid.get(action.did)?.deviceName;
        const fallbackModel = devicesByDid.get(action.did)?.model;
        return {
          ...action,
          deviceName: action.deviceName || fallbackName || "智能设备",
          model: action.model || fallbackModel || "device",
          label: action.label || fallbackName || "执行动作",
        };
      }
      return action;
    }),
    ...(schedule ? { schedule } : { triggerSelections: rawAutomationTriggers(scene).map((_, sourceIndex) => ({ automationId: draft.sceneId, sourceIndex })) }),
    triggers,
    triggerMode: Number(triggerContainer?.express) === 1 ? "all" : "any",
    triggerEditable: triggers.every(item => item.kind !== "unknown"),
    triggerLabel: triggers.map(item => item.label).join(" 且 ") || "未知触发条件",
    ...(parsedConditions.length ? { conditions: parsedConditions, conditionMode: Number(conditionContainer?.express) === 0 ? "all" : "any" } : {}),
    ...(parsedFalseActions.length ? { falseActions: parsedFalseActions } : {}),
    ...(effectiveTime ? { effectiveTime } : {}),
  };
}

function sameList(left: number[] | undefined, right: number[] | undefined) {
  return (left ?? []).join(",") === (right ?? []).join(",");
}

function sameTimeRange(left: AutomationConditionDraft["timeRange"], right: AutomationConditionDraft["timeRange"]) {
  return left?.start === right?.start && left?.end === right?.end;
}

/** Compares the client condition representation without reconstructing Xiaomi's private node shape. */
export function automationConditionsMatchWrite(
  current: AutomationConditionDraft[] | undefined,
  submitted: AutomationConditionDraft[] | undefined,
) {
  const left = current ?? [];
  const right = submitted ?? [];
  return left.length === right.length && left.every((condition, index) => {
    const candidate = right[index];
    return Boolean(candidate
      && condition.kind === candidate.kind
      && condition.label === candidate.label
      && condition.did === candidate.did
      && condition.siid === candidate.siid
      && condition.piid === candidate.piid
      && condition.value === candidate.value
      && sameTimeRange(condition.timeRange, candidate.timeRange)
      && sameList(condition.weekdays, candidate.weekdays)
      && condition.sourceIndex === candidate.sourceIndex);
  });
}

export function restoreAutomationConditionSourceIndexes(
  submitted: AutomationConditionDraft[] | undefined,
  current: AutomationConditionDraft[] | undefined,
) {
  if (!submitted?.length || !current?.length || submitted.length !== current.length) return submitted;
  if (!submitted.every(condition => condition.sourceIndex === undefined)) return submitted;
  return submitted.map((condition, index) => current[index]?.sourceIndex === undefined
    ? condition
    : { ...condition, sourceIndex: current[index].sourceIndex });
}

export function automationEffectiveTimeMatchesWrite(
  current: AutomationEffectiveTimeDraft | undefined,
  submitted: AutomationEffectiveTimeDraft | undefined,
) {
  if (!current && !submitted) return true;
  if (!current || !submitted || current.type !== submitted.type) return false;
  return current.start === submitted.start && current.end === submitted.end && sameList(current.weekdays, submitted.weekdays);
}

export function automationTriggersMatchWrite(current: AutomationEditorDraft, submitted: AutomationWriteDraft) {
  if (current.schedule || submitted.schedule) {
    return Boolean(current.schedule && submitted.schedule
      && current.schedule.time === submitted.schedule.time
      && sameList(current.schedule.weekdays, submitted.schedule.weekdays));
  }
  const selections = submitted.triggerSelections ?? [];
  const original = current.triggerSelections ?? [];
  return selections.length === original.length && selections.every((selection, index) => {
    const previous = original[index];
    const trigger = current.triggers?.[index];
    return Boolean(previous
      && selection.automationId === previous.automationId
      && selection.sourceIndex === previous.sourceIndex
      && (!selection.label || selection.label === trigger?.label));
  });
}

export function resolveAutomationTriggerSelections(scenes: XiaomiSceneRecord[], selections: AutomationTriggerSelection[] = []) {
  return selections.map(selection => {
    const scene = scenes.find(item => sceneRecordId(item) === selection.automationId);
    const trigger = scene && rawAutomationTriggers(scene)[selection.sourceIndex];
    if (!trigger && (selection.automationId.includes("sun") || selection.label?.includes("日出") || selection.label?.includes("日落"))) {
      const label = selection.label || "日落后30分钟 每天";
      const isSunset = /日落|sunset/i.test(label);
      return {
        id: 0,
        order: 1,
        src: "weather",
        key: isSunset ? "sunset" : "sunrise",
        name: label,
        payload_json: {
          type: isSunset ? "sunset" : "sunrise",
        },
      };
    }
    if (!trigger) throw new Error("XIAOMI_AUTOMATION_TRIGGER_NOT_FOUND");
    const cloned = JSON.parse(JSON.stringify(trigger)) as XiaomiSceneRecord;
    if (selection.label) {
      cloned.name = selection.label;
      if (/日落|sunset/i.test(selection.label)) {
        cloned.key = "sunset";
      } else if (/日出|sunrise/i.test(selection.label)) {
        cloned.key = "sunrise";
      }
    }
    return cloned;
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

function conditionPayloadKey(condition: XiaomiSceneRecord) {
  return "payload_json" in condition ? "payload_json" : "payload" in condition ? "payload" : undefined;
}

function replaceConditionDeviceId(value: unknown, did: string): boolean {
  const node = record(value);
  if (!node) return false;
  let replaced = false;
  for (const key of ["did", "device_id", "deviceId", "dev_id"] as const) {
    if (typeof node[key] === "string" || typeof node[key] === "number") {
      node[key] = did;
      replaced = true;
    }
  }
  if (replaceConditionDeviceId(node.device, did)) replaced = true;
  for (const key of ["value", "params", "list"] as const) {
    if (!Array.isArray(node[key])) continue;
    for (const entry of node[key]) {
      if (replaceConditionDeviceId(entry, did)) replaced = true;
    }
  }
  return replaced;
}

function replaceConditionTimeRange(value: unknown, timeRange: NonNullable<AutomationConditionDraft["timeRange"]>, weekdays: number[] | undefined) {
  const node = record(value);
  if (!node) return false;
  let replaced = false;
  const nestedStrings: Array<{ key: "time_range" | "timer" | "period"; node: Record<string, unknown> }> = [];
  for (const key of ["time_range", "timer", "period"] as const) {
    if (typeof node[key] === "string") {
      const parsed = parsedSceneRecord(node[key]);
      if (parsed) nestedStrings.push({ key, node: parsed });
    }
  }
  const targets = [node, record(node.time_range), record(node.timer), record(node.period), ...nestedStrings.map(entry => entry.node)]
    .filter((target): target is Record<string, unknown> => Boolean(target));
  for (const target of targets) {
    for (const key of ["start", "begin_time", "begin"] as const) {
      if (typeof target[key] === "string") {
        target[key] = timeRange.start;
        replaced = true;
      }
    }
    for (const key of ["end", "end_time"] as const) {
      if (typeof target[key] === "string") {
        target[key] = timeRange.end;
        replaced = true;
      }
    }
    if (weekdays?.length) {
      for (const key of ["weekdays", "repeat"] as const) {
        if (Array.isArray(target[key])) {
          target[key] = weekdays;
          replaced = true;
        }
      }
    }
  }
  for (const entry of nestedStrings) {
    node[entry.key] = JSON.stringify(entry.node);
  }
  return replaced;
}

function replaceAutomationConditions(scene: XiaomiSceneRecord, conditions: AutomationConditionDraft[], mode: "all" | "any") {
  const container = automationConditionContainer(scene);
  const outputKey = "scene_condition" in scene ? "scene_condition" : "condition" in scene ? "condition" : undefined;
  const sourceValues = container?.conditions;
  if (!container || !Array.isArray(sourceValues) || !outputKey) throw new Error("XIAOMI_AUTOMATION_CONDITION_NODE_INVALID");
  const entries = automationConditionEntries(scene);
  const byIndex = new Map(entries.map(entry => [entry.index, entry.value]));
  const sourceIndexes = new Set<number>();
  const outputs = conditions.map(condition => {
    if (!Number.isInteger(condition.sourceIndex) || condition.sourceIndex! < 0 || condition.sourceIndex! >= sourceValues.length || !byIndex.has(condition.sourceIndex!)) {
      throw new Error("XIAOMI_AUTOMATION_CONDITION_SOURCE_INVALID");
    }
    if (sourceIndexes.has(condition.sourceIndex!)) throw new Error("XIAOMI_AUTOMATION_CONDITION_SOURCE_DUPLICATE");
    sourceIndexes.add(condition.sourceIndex!);
    const output = JSON.parse(JSON.stringify(byIndex.get(condition.sourceIndex!))) as XiaomiSceneRecord;
    output.name = condition.label;
    const payloadKey = conditionPayloadKey(output);
    const payload = payloadKey ? parsedSceneRecord(output[payloadKey]) : undefined;
    if (condition.did) {
      const replaced = replaceConditionDeviceId(payload, condition.did);
      if (!replaced && typeof output.src === "string" && !["device", "timer", "weather", "location"].includes(output.src)) output.src = condition.did;
    }
    if (condition.timeRange && !replaceConditionTimeRange(payload, condition.timeRange, condition.weekdays)) {
      throw new Error("XIAOMI_AUTOMATION_CONDITION_TIME_UNSUPPORTED");
    }
    if (payloadKey && payload) output[payloadKey] = typeof output[payloadKey] === "string" ? JSON.stringify(payload) : payload;
    return output;
  });
  if (outputs.length !== sourceValues.length) {
    outputs.forEach((output, index) => {
      if (typeof output.order === "number") output.order = index + 1;
    });
  }
  const updatedContainer = JSON.parse(JSON.stringify(container)) as XiaomiSceneRecord;
  updatedContainer.express = mode === "any" ? 1 : 0;
  updatedContainer.conditions = outputs;
  const target = scene[outputKey];
  scene[outputKey] = typeof target === "string" ? JSON.stringify(updatedContainer) : updatedContainer;
}

export function buildAutomationCreatePayload(draft: AutomationWriteDraft, userId: string, templates: XiaomiSceneRecord[] = []) {
  const output = buildCreatePayload(draft, userId);
  output.scene_trigger = { express: draft.triggerMode === "all" ? 1 : 0, triggers: triggerRecords(draft, templates) };
  if (draft.conditions?.length) {
    output.scene_condition = {
      express: draft.conditionMode === "any" ? 1 : 0,
      conditions: draft.conditions.map((condition, index) => ({
        id: index,
        order: index + 1,
        name: condition.label,
        src: condition.kind === "device" ? "device" : condition.kind === "time" ? "timer" : "weather",
    key: condition.kind === "time" ? "timer.period" : "prop",
    payload_json: {
      ...(condition.did ? { did: condition.did } : {}),
      ...(condition.timeRange ? { time_range: { ...condition.timeRange, ...(condition.weekdays ? { weekdays: condition.weekdays } : {}) } } : {}),
    },
      })),
    };
  }
  if (draft.falseActions?.length) replaceElseActions(output, draft.falseActions, userId);
  if (draft.effectiveTime) {
    output.time_filter = {
      start: draft.effectiveTime.start || "00:00",
      end: draft.effectiveTime.end || "23:59",
      weekdays: draft.effectiveTime.weekdays,
    };
  }
  return output;
}

export function buildAutomationUpdatePayload(scene: XiaomiSceneRecord, draft: AutomationWriteDraft, templates?: XiaomiSceneRecord[]) {
  const output = buildUpdatePayload(scene, draft);
  if (draft.schedule || templates) {
    const container = record(output.scene_trigger) ?? {};
    output.scene_trigger = { ...container, express: draft.triggerMode === "all" ? 1 : 0, triggers: triggerRecords(draft, templates ?? []) };
  }
  if (draft.conditions) replaceAutomationConditions(output, draft.conditions, draft.conditionMode ?? "all");
  if (draft.falseActions) replaceElseActions(output, draft.falseActions);
  if (draft.effectiveTime) {
    output.time_filter = {
      start: draft.effectiveTime.start || "00:00",
      end: draft.effectiveTime.end || "23:59",
      weekdays: draft.effectiveTime.weekdays,
    };
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
