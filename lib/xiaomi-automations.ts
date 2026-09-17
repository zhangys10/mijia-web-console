import { xiaomiRequest, type XiaomiSession } from "./xiaomi-cloud.ts";
import { parseDerivedDeviceId } from "./device-topology.ts";
import {
  parsedSceneRecord,
  parseManualScenes,
  sceneListPayload,
  type ManualSceneAction,
  type XiaomiRequester,
  type XiaomiSceneRecord,
} from "./xiaomi-scenes.ts";

export type AutomationTrigger = {
  kind: "schedule" | "device" | "location" | "weather" | "manual" | "unknown";
  label: string;
  detail?: string;
  editable: boolean;
  time?: string;
  weekdays?: number[];
  deviceName?: string;
  room?: string;
  model?: string;
  did?: string;
};

export type AutomationCondition = {
  kind: "device" | "time" | "weather" | "unknown";
  label: string;
  detail?: string;
  deviceName?: string;
  room?: string;
  model?: string;
  did?: string;
  timeRange?: { start: string; end: string };
  weekdays?: number[];
};

export type AutomationEffectiveTime = {
  type: "all-day" | "custom";
  start?: string;
  end?: string;
  weekdays: number[];
};

export type XiaomiAutomation = {
  id: string;
  homeId: string;
  name: string;
  enabled: boolean;
  triggerMode: "all" | "any";
  triggers: AutomationTrigger[];
  conditionMode?: "all" | "any";
  conditions?: AutomationCondition[];
  actions: ManualSceneAction[];
  falseActions?: ManualSceneAction[];
  effectiveTime?: AutomationEffectiveTime;
  actionCount: number;
  updatedAt?: string;
};

export type AutomationTriggerTemplate = {
  key: string;
  automationId: string;
  sourceIndex: number;
  kind: AutomationTrigger["kind"];
  label: string;
  detail?: string;
  deviceKey?: string;
  deviceName?: string;
  room?: string;
  model?: string;
  did?: string;
};

export const AUTOMATION_LIST_PATH = "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList";

function record(value: unknown): XiaomiSceneRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XiaomiSceneRecord : undefined;
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function sceneEntries(response: XiaomiSceneRecord) {
  const result = response.result;
  if (result === null) return [];
  if (Array.isArray(result)) return result.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
  const container = record(result);
  if (!container) throw new Error("XIAOMI_AUTOMATION_RESPONSE_INVALID");
  for (const candidate of [container.scene_info_list, container.scene_list, container.list, container.scenes]) {
    if (Array.isArray(candidate)) return candidate.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
  }
  throw new Error("XIAOMI_AUTOMATION_RESPONSE_INVALID");
}

export function automationConditionContainer(scene: XiaomiSceneRecord) {
  const parsed = parsedSceneRecord(scene) ?? scene;
  return parsedSceneRecord(parsed.scene_condition ?? parsed.condition ?? scene.scene_condition ?? scene.condition);
}

export function automationConditionEntries(scene: XiaomiSceneRecord) {
  const container = automationConditionContainer(scene);
  const values = Array.isArray(container?.conditions) ? container.conditions : Array.isArray(scene.conditions) ? scene.conditions : [];
  return values
    .map((item, index) => ({ index, value: record(item) }))
    .filter((entry): entry is { index: number; value: XiaomiSceneRecord } => Boolean(entry.value));
}

export function rawAutomationConditions(scene: XiaomiSceneRecord) {
  return automationConditionEntries(scene).map(entry => entry.value);
}

function extractDidFromKey(key: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  const parts = key.split(".");
  if (parts.length >= 4 && ["event", "prop", "action"].includes(parts[0].toLowerCase())) {
    if (/^\d{4,}$/.test(parts[1]) || !/^\d+$/.test(parts[1])) {
      return parts[1];
    }
  }
  const match = key.match(/(?:^|\.)(\d{5,})(?:\.|$)/);
  if (match?.[1]) return match[1];
  return undefined;
}

function resolveDeviceDid(
  item: XiaomiSceneRecord,
  devicesByDid?: Map<string, { deviceName: string; room?: string; model?: string }>
): string | undefined {
  const payload = parsedSceneRecord(item.payload_json ?? item.payload ?? item.setting);
  const device = record(payload?.device);
  const params = record(payload?.params);
  const extra = parsedSceneRecord(payload?.extra ?? item.extra);
  const subProps = record(payload?.sub_props);

  // 1. Direct identifiers
  const directDid = text(
    item.did ?? item.device_id ?? item.deviceId ?? item.dev_id ??
    payload?.did ?? payload?.device_id ?? payload?.deviceId ?? payload?.dev_id ??
    extra?.did ?? extra?.device_id ?? extra?.deviceId ??
    device?.did ?? device?.device_id ??
    params?.did ?? params?.device_id ??
    subProps?.did ??
    (Array.isArray(payload?.dids) ? payload.dids[0] : undefined) ??
    (Array.isArray(item.dids) ? item.dids[0] : undefined)
  );
  if (directDid) return directDid;

  // 2. Arrays in payload (e.g. MIoT get_properties / set_properties conditions and actions)
  if (Array.isArray(payload?.value)) {
    for (const val of payload.value) {
      const v = record(val);
      const d = text(v?.did ?? v?.device_id);
      if (d) return d;
    }
  }
  if (Array.isArray(payload?.params)) {
    for (const p of payload.params) {
      const v = record(p);
      const d = text(v?.did ?? v?.device_id);
      if (d) return d;
    }
  }
  if (Array.isArray(payload?.list)) {
    for (const l of payload.list) {
      const v = record(l);
      const d = text(v?.did ?? v?.device_id);
      if (d) return d;
    }
  }

  // 3. Check item.src / payload.src before key extraction
  // (in mesh/gateway scenes, src is very often the real device DID while key is "event.2.1")
  const itemSrc = text(item.src);
  if (itemSrc && !["device", "user", "timer", "weather", "location", "scene", "cloud"].includes(itemSrc.toLowerCase())) {
    if (devicesByDid?.has(itemSrc) || /^\d{4,}$/.test(itemSrc)) return itemSrc;
  }
  const payloadSrc = text(payload?.src);
  if (payloadSrc && !["device", "user", "timer", "weather", "location", "scene", "cloud"].includes(payloadSrc.toLowerCase())) {
    if (devicesByDid?.has(payloadSrc) || /^\d{4,}$/.test(payloadSrc)) return payloadSrc;
  }

  // 4. Extract DID from keys
  const fromItemKey = extractDidFromKey(item.key);
  if (fromItemKey) return fromItemKey;
  const fromPayloadKey = extractDidFromKey(payload?.key);
  if (fromPayloadKey) return fromPayloadKey;

  // 5. If devicesByDid is available, match against serialized item payload
  if (devicesByDid && devicesByDid.size > 0) {
    try {
      const rawString = JSON.stringify(item);
      const candidateDids = Array.from(devicesByDid.keys()).filter(d => Boolean(d) && d.length >= 3).sort((a, b) => b.length - a.length);
      for (const candidate of candidateDids) {
        if (rawString.includes(candidate)) {
          return candidate;
        }
      }
    } catch {
      // ignore serialization errors
    }
  }

  return undefined;
}

export function parseAutomationCondition(
  condition: XiaomiSceneRecord,
  devicesByDid?: Map<string, { deviceName: string; room?: string; model?: string }>
): AutomationCondition {
  const src = text(condition.src).toLowerCase();
  const key = text(condition.key).toLowerCase();
  const name = text(condition.name ?? condition.condition_name);
  if (/timer|time|schedule|period/.test(`${src} ${key}`)) {
    const payload = parsedSceneRecord(condition.payload_json ?? condition.payload ?? condition.setting);
    const timeRange = record(payload?.time_range);
    const start = text(payload?.start ?? payload?.begin_time ?? timeRange?.start);
    const end = text(payload?.end ?? payload?.end_time ?? timeRange?.end);
    const rawDays = payload?.weekdays ?? payload?.repeat ?? timeRange?.weekdays;
    const weekdays = Array.isArray(rawDays) ? rawDays.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7) : undefined;
    return {
      kind: "time",
      label: name || (start && end ? `${start} ~ ${end}` : "时间段条件"),
      ...(start && end ? { timeRange: { start, end } } : {}),
      ...(weekdays?.length ? { weekdays } : {}),
    };
  }
  const payload = parsedSceneRecord(condition.payload_json ?? condition.payload ?? condition.setting);
  const extra = parsedSceneRecord(payload?.extra ?? condition.extra);
  const device = record(payload?.device);
  const did = resolveDeviceDid(condition, devicesByDid);
  const rawDeviceName = text(
    payload?.device_name ?? payload?.deviceName ?? payload?.dev_name ??
    device?.name ?? condition.device_name ?? condition.deviceName ??
    extra?.device_name ?? extra?.name
  );
  const isGeneric = !rawDeviceName || rawDeviceName === "智能设备" || rawDeviceName === "未命名设备";
  let dev = did && devicesByDid ? devicesByDid.get(did) : undefined;
  if (!dev && devicesByDid) {
    const searchTarget = rawDeviceName && !isGeneric ? rawDeviceName : name;
    if (searchTarget) {
      dev = Array.from(devicesByDid.values()).find(d =>
        d.deviceName === searchTarget ||
        searchTarget.includes(d.deviceName) ||
        d.deviceName.includes(searchTarget)
      );
    }
  }
  const deviceName = dev?.deviceName || (!isGeneric ? rawDeviceName : undefined);
  const rawRoom = text(payload?.room_name ?? payload?.room ?? condition.room_name ?? condition.room ?? extra?.room_name ?? extra?.room);
  const room = (rawRoom && rawRoom !== "未分配") ? rawRoom : (dev?.room && dev.room !== "未分配" ? dev.room : undefined);
  const model = text(payload?.model ?? condition.model ?? extra?.model ?? dev?.model);

  if (/device|miot|sensor|property/.test(`${src} ${key}`) || deviceName || did) {
    const detail = deviceName ? `${deviceName}${room && room !== "未分配" ? ` · ${room}` : ""}` : (room && room !== "未分配" ? `房间：${room}` : undefined);
    return {
      kind: "device",
      label: name || (deviceName ? `${deviceName} 状态判断` : "设备状态"),
      ...(detail ? { detail } : {}),
      ...(deviceName ? { deviceName } : {}),
      ...(room ? { room } : {}),
      ...(model ? { model } : {}),
      ...(did ? { did } : {}),
    };
  }
  if (/weather|temp|humidity|pm25/.test(`${src} ${key}`)) {
    return { kind: "weather", label: name || "环境状态" };
  }
  return { kind: "unknown", label: name || "未识别条件" };
}

export function rawAutomationTriggers(scene: XiaomiSceneRecord) {
  const trigger = parsedSceneRecord(scene.scene_trigger ?? scene.trigger);
  const values = Array.isArray(trigger?.triggers) ? trigger.triggers : Array.isArray(scene.triggers) ? scene.triggers : [];
  return values.filter((item): item is XiaomiSceneRecord => Boolean(record(item)));
}

export function isAutomationRecord(scene: XiaomiSceneRecord) {
  const triggers = rawAutomationTriggers(scene);
  return triggers.length > 0 && !triggers.some(trigger => text(trigger.src).toLowerCase() === "user" || text(trigger.key).toLowerCase() === "user.click");
}

function clock(value: unknown) {
  const source = text(value);
  const match = source.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?:\D|$)/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

function scheduleDetails(trigger: XiaomiSceneRecord) {
  const payload = parsedSceneRecord(trigger.payload_json ?? trigger.payload ?? trigger.setting);
  const timer = record(payload?.timer) ?? payload;
  const hour = Number(timer?.hour);
  const minute = Number(timer?.minute);
  const time = clock(timer?.time ?? timer?.cron ?? timer?.expression ?? trigger.name)
    ?? (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : undefined);
  const rawDays = timer?.weekdays ?? timer?.days ?? timer?.repeat;
  const weekdays = Array.isArray(rawDays)
    ? rawDays.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7)
    : undefined;
  return { time, weekdays };
}

export function parseAutomationTrigger(
  trigger: XiaomiSceneRecord,
  devicesByDid?: Map<string, { deviceName: string; room?: string; model?: string }>
): AutomationTrigger {
  const src = text(trigger.src).toLowerCase();
  const key = text(trigger.key).toLowerCase();
  const name = text(trigger.name ?? trigger.trigger_name);
  if (/timer|time|schedule/.test(`${src} ${key}`)) {
    const { time, weekdays } = scheduleDetails(trigger);
    const repeat = weekdays?.length && weekdays.length < 7 ? weekdays.map(day => "一二三四五六日"[day - 1]).join("、") : "每天";
    return { kind: "schedule", label: time ? `${repeat} ${time}` : name || "定时触发", ...(time ? { time } : {}), ...(weekdays?.length ? { weekdays } : {}), editable: Boolean(time) };
  }
  const payload = parsedSceneRecord(trigger.payload_json ?? trigger.payload ?? trigger.setting);
  const extra = parsedSceneRecord(payload?.extra ?? trigger.extra);
  const device = record(payload?.device);
  const did = resolveDeviceDid(trigger, devicesByDid);
  const rawDeviceName = text(
    payload?.device_name ?? payload?.deviceName ?? payload?.dev_name ??
    device?.name ?? trigger.device_name ?? trigger.deviceName ??
    extra?.device_name ?? extra?.name
  );
  const isGeneric = !rawDeviceName || rawDeviceName === "智能设备" || rawDeviceName === "未命名设备";
  let dev = did && devicesByDid ? devicesByDid.get(did) : undefined;
  if (!dev && devicesByDid) {
    const searchTarget = rawDeviceName && !isGeneric ? rawDeviceName : name;
    if (searchTarget) {
      dev = Array.from(devicesByDid.values()).find(d =>
        d.deviceName === searchTarget ||
        searchTarget.includes(d.deviceName) ||
        d.deviceName.includes(searchTarget)
      );
    }
  }
  const deviceName = dev?.deviceName || (!isGeneric ? rawDeviceName : undefined);
  const rawRoom = text(payload?.room_name ?? payload?.room ?? trigger.room_name ?? trigger.room ?? extra?.room_name ?? extra?.room);
  const room = (rawRoom && rawRoom !== "未分配") ? rawRoom : (dev?.room && dev.room !== "未分配" ? dev.room : undefined);
  const model = text(payload?.model ?? trigger.model ?? extra?.model ?? dev?.model);

  if (/device|miot|sensor|event|property/.test(`${src} ${key}`) || deviceName || did) {
    const detail = deviceName ? `${deviceName}${room && room !== "未分配" ? ` · ${room}` : ""}` : (room && room !== "未分配" ? `房间：${room}` : undefined);
    return {
      kind: "device",
      label: name || (deviceName ? `${deviceName} 触发事件` : "设备状态变化"),
      ...(detail ? { detail } : {}),
      ...(deviceName ? { deviceName } : {}),
      ...(room ? { room } : {}),
      ...(model ? { model } : {}),
      ...(did ? { did } : {}),
      editable: false,
    };
  }
  if (/location|geofence/.test(`${src} ${key}`)) return { kind: "location", label: name || "到达或离开某地", editable: false };
  if (/weather|sunset|sunrise/.test(`${src} ${key}`)) return { kind: "weather", label: name || "天气或日出日落", editable: false };
  return { kind: "unknown", label: name || "米家私有触发条件", detail: "当前版本只读，保存时会原样保留", editable: false };
}

export function buildAutomationTriggerCatalog(
  automations: XiaomiSceneRecord[],
  devices: XiaomiSceneRecord[],
  homeId: string,
): AutomationTriggerTemplate[] {
  const scopedDevices = devices.filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did));
  const targetDevices = scopedDevices.length > 0 ? scopedDevices : devices.filter(device => Boolean(text(device.did)));
  const devicesByDid = new Map(targetDevices.flatMap((device, index, candidates) => {
    const did = text(device.did);
    return parseDerivedDeviceId(did) || candidates.findIndex(candidate => text(candidate.did) === did) !== index ? [] : [[did, {
      deviceKey: `device-${index + 1}`,
      deviceName: text(device.name) || text(device.model) || "未命名设备",
      room: text(device.room ?? device.roomName ?? device.room_name) || "未分配",
      model: text(device.model),
    }] as const];
  }));
  const templates = automations
    .filter(automation => (text(automation.home_id) || homeId) === homeId)
    .flatMap(automation => rawAutomationTriggers(automation).map((trigger, sourceIndex) => ({
      trigger,
      sourceIndex,
      automationId: text(automation.scene_id ?? automation.us_id ?? automation.id),
    })))
    .flatMap(item => {
      const parsed = parseAutomationTrigger(item.trigger, devicesByDid);
      if (!item.automationId || parsed.kind === "schedule" || parsed.kind === "unknown") return [];
      const did = resolveDeviceDid(item.trigger, devicesByDid);
      const device = did ? devicesByDid.get(did) : undefined;
      const deviceName = device?.deviceName || parsed.deviceName;
      const room = device?.room || parsed.room;
      const detail = parsed.detail || (deviceName ? `${deviceName}${room && room !== "未分配" ? ` · ${room}` : ""}` : undefined);
      return [{
        key: `${item.automationId}:${item.sourceIndex}`,
        automationId: item.automationId,
        sourceIndex: item.sourceIndex,
        kind: parsed.kind,
        label: parsed.label,
        ...(detail ? { detail } : {}),
        ...(device?.deviceKey ? { deviceKey: device.deviceKey } : {}),
        ...(deviceName ? { deviceName } : {}),
        ...(room ? { room } : {}),
        ...(device?.model || parsed.model ? { model: device?.model || parsed.model } : {}),
      } satisfies AutomationTriggerTemplate];
    });
  return templates.filter((item, index) => templates.findIndex(candidate =>
    candidate.kind === item.kind
    && candidate.label === item.label
    && candidate.deviceKey === item.deviceKey
    && candidate.deviceName === item.deviceName
  ) === index);
}

function enabled(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  return ![false, 0, "0", "false", "disabled", "off"].includes(value as never);
}

export function elseActionEntries(scene: XiaomiSceneRecord): XiaomiSceneRecord[] {
  const parsed = parsedSceneRecord(scene) ?? scene;
  for (const key of ["scene_else_action", "else_action", "scene_false_action", "false_action"] as const) {
    const value = parsed[key] ?? scene[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      return (value as unknown[]).filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
    }
    const container = parsedSceneRecord(value);
    if (Array.isArray(container?.actions)) {
      return container.actions.filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
    }
    if (Array.isArray(container)) {
      return (container as unknown[]).filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
    }
  }
  const directList = parsed.else_actions ?? scene.else_actions;
  if (Array.isArray(directList)) {
    return directList.filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
  }
  const setting = parsedSceneRecord(parsed.setting ?? scene.setting);
  for (const key of ["scene_else_action", "else_action", "else_action_list", "false_action"] as const) {
    const value = setting?.[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      return (value as unknown[]).filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
    }
    const container = parsedSceneRecord(value);
    if (Array.isArray(container?.actions)) {
      return container.actions.filter((item): item is XiaomiSceneRecord => Boolean(item && typeof item === "object"));
    }
  }
  return [];
}

export function parseAutomations(response: XiaomiSceneRecord, homeId: string, devices: XiaomiSceneRecord[] = []): XiaomiAutomation[] {
  return sceneEntries(response).flatMap(scene => {
    if (!isAutomationRecord(scene)) return [];
    const id = text(scene.scene_id ?? scene.us_id ?? scene.id);
    const name = text(scene.name ?? scene.scene_name);
    const sceneHomeId = text(scene.home_id) || homeId;
    if (!id || !name || sceneHomeId !== homeId) return [];
    const triggerContainer = parsedSceneRecord(scene.scene_trigger ?? scene.trigger);
    const manualShape = { ...scene, scene_trigger: { triggers: [{ src: "user", key: "user.click" }] } };
    const actions = parseManualScenes({ result: [manualShape] }, homeId, devices)[0]?.actions ?? [];
    const updatedAt = text(scene.update_time ?? scene.updated_at ?? scene.modify_time);
    const scopedDevices = devices.filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did));
    const targetDevices = scopedDevices.length > 0 ? scopedDevices : devices.filter(device => Boolean(text(device.did)));
    const devicesByDid = new Map(targetDevices.map(device => [text(device.did), {
      deviceName: text(device.name) || text(device.model) || "未命名设备",
      room: text(device.room ?? device.roomName ?? device.room_name) || "未分配",
      model: text(device.model),
    }]));

    const conditionContainer = parsedSceneRecord(scene.scene_condition ?? scene.condition);
    const rawConditions = rawAutomationConditions(scene);
    const conditions = rawConditions.length > 0 ? rawConditions.map(c => {
      const safeCondition = { ...parseAutomationCondition(c, devicesByDid) };
      delete safeCondition.did;
      return safeCondition;
    }) : undefined;
    const conditionMode = Number(conditionContainer?.express) === 0 ? "all" : "any";

    const validElseActions = elseActionEntries(scene);
    let falseActions: ManualSceneAction[] | undefined;
    if (validElseActions.length > 0) {
      const manualElseShape = { ...scene, scene_trigger: { triggers: [{ src: "user", key: "user.click" }] }, scene_action: { actions: validElseActions } };
      falseActions = parseManualScenes({ result: [manualElseShape] }, homeId, devices)[0]?.actions;
    }

    const timeFilter = parsedSceneRecord(scene.time_filter ?? scene.timer_filter);
    let effectiveTime: AutomationEffectiveTime | undefined;
    if (timeFilter) {
      const start = text(timeFilter.start ?? timeFilter.begin_time);
      const end = text(timeFilter.end ?? timeFilter.end_time);
      const rawDays = timeFilter.weekdays ?? timeFilter.repeat;
      const weekdays = Array.isArray(rawDays) ? rawDays.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7) : [1, 2, 3, 4, 5, 6, 7];
      effectiveTime = {
        type: start && end ? "custom" : "all-day",
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5, 6, 7],
      };
    }

    return [{
      id,
      homeId,
      name,
      enabled: enabled(scene.enable ?? scene.enabled ?? scene.status),
      triggerMode: Number(triggerContainer?.express) === 1 ? "all" : "any",
      triggers: rawAutomationTriggers(scene).map(t => {
        const safeTrigger = { ...parseAutomationTrigger(t, devicesByDid) };
        delete safeTrigger.did;
        return safeTrigger;
      }),
      ...(conditions ? { conditionMode, conditions } : {}),
      actions,
      ...(falseActions && falseActions.length > 0 ? { falseActions } : {}),
      ...(effectiveTime ? { effectiveTime } : {}),
      actionCount: actions.length,
      ...(updatedAt ? { updatedAt } : {}),
    }];
  });
}

export async function listRawAutomations(session: XiaomiSession, homeId: string, request: XiaomiRequester = xiaomiRequest) {
  const response = await request(session, AUTOMATION_LIST_PATH, sceneListPayload(homeId));
  return sceneEntries(response).filter(scene => (text(scene.home_id) || homeId) === homeId && isAutomationRecord(scene));
}

export async function listAutomations(session: XiaomiSession, homeId: string, request: XiaomiRequester = xiaomiRequest) {
  return parseAutomations({ result: await listRawAutomations(session, homeId, request) }, homeId);
}
