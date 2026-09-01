import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_LIST_PATH,
  buildAutomationTriggerCatalog,
  isAutomationRecord,
  listRawAutomations,
  parseAutomations,
} from "../lib/xiaomi-automations.ts";
import {
  assertAutomationDraft,
  buildAutomationCreatePayload,
  buildAutomationUpdatePayload,
  createAutomationEditorDraft,
  resolveAutomationTriggerSelections,
} from "../lib/xiaomi-automation-editor.ts";

const session = { userId: "test-user", ssecurity: "fake", serviceToken: "fake", region: "cn", createdAt: 0 };
const timerAutomation = {
  scene_id: "automation-1",
  home_id: "home-1",
  scene_name: "晨间灯光",
  enable: false,
  scene_trigger: {
    express: 0,
    triggers: [{ id: 8, order: 1, src: "timer", key: "timer", name: "工作日 07:30", payload_json: { timer: { time: "07:30", weekdays: [1, 2, 3, 4, 5], timezone_id: "Asia/Shanghai" } } }],
  },
  scene_action: { actions: [{ order: 1, name: "开灯", payload_json: { command: "set_properties", did: "light-test", device_name: "床头灯", model: "vendor.light.test", value: [{ siid: 2, piid: 1, value: true }] } }] },
};

test("separates automations from manual scenes and scopes them to a home", () => {
  assert.equal(isAutomationRecord(timerAutomation), true);
  assert.equal(isAutomationRecord({ scene_trigger: { triggers: [{ src: "user", key: "user.click" }] } }), false);
  const values = parseAutomations({ result: { scene_info_list: [timerAutomation, { ...timerAutomation, scene_id: "other", home_id: "home-2" }] } }, "home-1", [{ did: "light-test", homeId: "home-1", roomName: "主卧" }]);
  assert.deepEqual(values, [{
    id: "automation-1", homeId: "home-1", name: "晨间灯光", enabled: false, triggerMode: "any",
    triggers: [{ kind: "schedule", label: "一、二、三、四、五 07:30", time: "07:30", weekdays: [1, 2, 3, 4, 5], editable: true }],
    actions: [{ order: 1, label: "开灯", deviceName: "床头灯", room: "主卧", details: [{ kind: "property", label: "未识别属性", value: "开启" }] }],
    actionCount: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(values), /test-user|ssecurity|serviceToken/);
});

test("classifies device, location, weather and unknown triggers as sanitized read-only nodes", () => {
  const response = { result: [{
    scene_id: "mixed", home_id: "home-1", name: "组合条件",
    scene_trigger: { express: 1, triggers: [
      { src: "device", key: "property", name: "门已打开", payload_json: { device_name: "门磁", did: "secret-did" } },
      { src: "location", key: "geofence", name: "有人回家", payload_json: { latitude: 1, longitude: 2 } },
      { src: "weather", key: "sunset", name: "日落后" },
      { src: "vendor-private", key: "opaque", payload_json: { token: "must-not-leak" } },
    ] }, scene_action: { actions: [] },
  }] };
  const [automation] = parseAutomations(response, "home-1");
  assert.equal(automation.triggerMode, "all");
  assert.deepEqual(automation.triggers.map(item => item.kind), ["device", "location", "weather", "unknown"]);
  assert.equal(automation.triggers.every(item => !item.editable), true);
  assert.doesNotMatch(JSON.stringify(automation), /secret-did|latitude|longitude|must-not-leak/);
});

test("groups device trigger templates by explicit same-home DID without exposing it", () => {
  const automations = [{
    scene_id: "mixed",
    home_id: "home-1",
    scene_trigger: { triggers: [
      { src: "device", key: "property", name: "已打开", payload_json: { did: "door-1" } },
      { src: "device", key: "property", name: "已打开", payload_json: { did: "door-2" } },
      { src: "device", key: "property", name: "检测到移动", payload_json: { did: "unknown-device" } },
      { src: "weather", key: "sunset", name: "日落后" },
    ] },
  }];
  const templates = buildAutomationTriggerCatalog(automations, [
    { did: "door-1", homeId: "home-1", name: "入户门", roomName: "玄关" },
    { did: "door-2", homeId: "home-1", name: "阳台门", roomName: "阳台" },
    { did: "unknown-device", homeId: "home-2", name: "其他家庭设备", roomName: "客厅" },
  ], "home-1");

  assert.deepEqual(templates.map(item => ({
    kind: item.kind,
    label: item.label,
    deviceKey: item.deviceKey,
    deviceName: item.deviceName,
    room: item.room,
  })), [
    { kind: "device", label: "已打开", deviceKey: "device-1", deviceName: "入户门", room: "玄关" },
    { kind: "device", label: "已打开", deviceKey: "device-2", deviceName: "阳台门", room: "阳台" },
    { kind: "device", label: "检测到移动", deviceKey: undefined, deviceName: undefined, room: undefined },
    { kind: "weather", label: "日落后", deviceKey: undefined, deviceName: undefined, room: undefined },
  ]);
  assert.doesNotMatch(JSON.stringify(templates), /door-1|door-2|unknown-device|其他家庭设备/);
});

test("creates a disabled, validated timer payload and rejects malformed schedules", () => {
  const draft = assertAutomationDraft({ homeId: "home-1", name: " 晨间灯光 ", enabled: false, schedule: { time: "07:30", weekdays: [5, 1, 1, 3, 2, 4] }, actions: [{ clientId: "one", kind: "set-properties", did: "light-test", deviceName: "床头灯", model: "vendor.light.test", label: "开灯", properties: [{ siid: 2, piid: 1, value: true }] }] }, false);
  assert.deepEqual(draft.schedule, { time: "07:30", weekdays: [1, 2, 3, 4, 5] });
  const payload = buildAutomationCreatePayload(draft, "test-user");
  assert.equal(payload.enable, false);
  assert.equal(payload.scene_trigger.triggers[0].src, "timer");
  assert.deepEqual(payload.scene_trigger.triggers[0].payload_json.timer, { time: "07:30", hour: 7, minute: 30, weekdays: [1, 2, 3, 4, 5], timezone_id: "Asia/Shanghai" });
  assert.throws(() => assertAutomationDraft({ homeId: "home-1", name: "坏规则", schedule: { time: "25:00", weekdays: [0] }, actions: draft.actions }, false), /INVALID_AUTOMATION_SCHEDULE/);
});

test("reuses verified same-home trigger nodes without exposing or mutating their raw values", () => {
  const deviceAutomation = { ...timerAutomation, scene_id: "device-source", scene_trigger: { express: 0, triggers: [{ id: 9, order: 1, src: "device", key: "property", name: "门已打开", payload_json: { did: "private-did", secret: "keep-server-side" } }] } };
  const [template] = resolveAutomationTriggerSelections([deviceAutomation], [{ automationId: "device-source", sourceIndex: 0 }]);
  const draft = assertAutomationDraft({ homeId: "home-1", name: "组合规则", enabled: false, triggerMode: "all", schedule: { time: "19:30", weekdays: [1, 2, 3, 4, 5, 6, 7] }, triggerSelections: [{ automationId: "device-source", sourceIndex: 0 }], actions: [{ clientId: "one", kind: "set-properties", did: "light-test", deviceName: "床头灯", model: "vendor.light.test", label: "开灯", properties: [{ siid: 2, piid: 1, value: true }] }] }, false);
  const payload = buildAutomationCreatePayload(draft, "test-user", [template]);
  assert.equal(payload.scene_trigger.express, 1);
  assert.equal(payload.scene_trigger.triggers.length, 2);
  assert.equal(payload.scene_trigger.triggers[1].payload_json.secret, "keep-server-side");
  assert.equal(deviceAutomation.scene_trigger.triggers[0].id, 9);
  assert.throws(() => resolveAutomationTriggerSelections([deviceAutomation], [{ automationId: "missing", sourceIndex: 0 }]), /XIAOMI_AUTOMATION_TRIGGER_NOT_FOUND/);
});

test("keeps unknown trigger bytes unchanged during metadata-only edits", async () => {
  const source = { ...timerAutomation, scene_trigger: JSON.stringify({ express: 1, vendor: { keep: true }, triggers: [{ src: "vendor-private", payload_json: "opaque-value" }] }) };
  const editor = await createAutomationEditorDraft(source, "home-1");
  assert.equal(editor.triggerEditable, false);
  assert.equal(editor.schedule, undefined);
  assert.doesNotMatch(JSON.stringify(editor), /opaque-value/);
  const updated = buildAutomationUpdatePayload(source, { homeId: "home-1", name: "只改名称", revision: editor.revision });
  assert.equal(updated.scene_trigger, source.scene_trigger);
});

test("uses the shared verified list endpoint and filters manual scenes", async () => {
  let call;
  const items = await listRawAutomations(session, "home-1", async (_session, path, data) => {
    call = { path, data };
    return { result: [timerAutomation, { scene_id: "manual", home_id: "home-1", name: "手动", scene_trigger: { triggers: [{ src: "user", key: "user.click" }] } }] };
  });
  assert.deepEqual(call, { path: AUTOMATION_LIST_PATH, data: { home_id: "home-1" } });
  assert.deepEqual(items.map(item => item.scene_id), ["automation-1"]);
});
