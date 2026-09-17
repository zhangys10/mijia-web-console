import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_LIST_PATH,
  buildAutomationTriggerCatalog,
  isAutomationRecord,
  listRawAutomations,
  parseAutomations,
} from "../lib/xiaomi-automations.ts";
import { sceneListPayload } from "../lib/xiaomi-scenes.ts";
import {
  assertAutomationDraft,
  buildAutomationCreatePayload,
  buildAutomationUpdatePayload,
  createAutomationEditorDraft,
  resolveAutomationTriggerSelections,
  restoreAutomationConditionSourceIndexes,
} from "../lib/xiaomi-automation-editor.ts";

const session = { userId: "test-user", cUserId: "fake-cuser", ssecurity: "fake", serviceToken: "fake", region: "cn", deviceId: "fake-device", userAgent: "fake-agent", createdAt: 0 };
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

test("announces the newer protocol version so recent automations are not filtered out", async () => {
  let call;
  const items = await listRawAutomations(session, "home-1", async (_session, path, data) => {
    call = { path, data };
    return { result: [timerAutomation, { scene_id: "manual", home_id: "home-1", name: "手动", scene_trigger: { triggers: [{ src: "user", key: "user.click" }] } }] };
  });
  assert.deepEqual(call, {
    path: AUTOMATION_LIST_PATH,
    data: { home_id: "home-1", app_version: 25, get_type: 2 },
  });
  assert.deepEqual(items.map(item => item.scene_id), ["automation-1"]);
});

test("uses one protocol-versioned payload for every home", () => {
  assert.deepEqual(sceneListPayload("home-1"), { home_id: "home-1", app_version: 25, get_type: 2 });
  assert.deepEqual(sceneListPayload("home-2"), { home_id: "home-2", app_version: 25, get_type: 2 });
});

test("parses and builds payloads with conditions, false actions and effective time", async () => {
  const complexScene = {
    scene_id: "auto-complex",
    home_id: "home-1",
    scene_name: "回家联动",
    enable: 1,
    scene_trigger: {
      express: 0,
      triggers: [{ id: 1, order: 1, src: "weather", name: "日落后" }],
    },
    scene_condition: {
      express: 1,
      conditions: [
        { id: 1, order: 1, src: "device", name: "门已关", payload_json: { device_name: "门磁传感器" } },
        { id: 2, order: 2, src: "timer", name: "18:00 ~ 23:00", payload_json: { start: "18:00", end: "23:00", weekdays: [1, 2, 3, 4, 5] } },
      ],
    },
    scene_action: {
      actions: [{ order: 1, name: "开灯", payload_json: { command: "set_properties", did: "light-1", device_name: "客厅灯", model: "yeelink.light.v1", value: [{ siid: 2, piid: 1, value: true }] } }],
    },
    scene_else_action: {
      actions: [{ order: 1, name: "关灯", payload_json: { command: "set_properties", did: "light-1", device_name: "客厅灯", model: "yeelink.light.v1", value: [{ siid: 2, piid: 1, value: false }] } }],
    },
    time_filter: {
      start: "18:00",
      end: "23:00",
      weekdays: [1, 2, 3, 4, 5],
    },
  };

  const [parsed] = parseAutomations({ result: [complexScene] }, "home-1");
  assert.equal(parsed.triggerMode, "any");
  assert.equal(parsed.conditionMode, "any");
  assert.equal(parsed.conditions?.length, 2);
  assert.equal(parsed.conditions?.[0].kind, "device");
  assert.equal(parsed.conditions?.[1].kind, "time");
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.falseActions?.length, 1);
  assert.equal(parsed.effectiveTime?.type, "custom");
  assert.equal(parsed.effectiveTime?.start, "18:00");
  assert.equal(parsed.effectiveTime?.end, "23:00");

  const editorDraft = await createAutomationEditorDraft(complexScene, "home-1");
  assert.equal(editorDraft.triggerMode, "any");
  assert.equal(editorDraft.conditionMode, "any");
  assert.equal(editorDraft.conditions?.length, 2);
  assert.equal(editorDraft.falseActions?.length, 1);
  assert.equal(editorDraft.falseActions[0].label, "关灯");
  assert.equal(editorDraft.falseActions[0].did, "light-1");
  assert.equal(editorDraft.falseActions[0].kind, "set-properties");

  const writeDraft = assertAutomationDraft({
    homeId: "home-1",
    name: "回家联动",
    triggerMode: "any",
    conditionMode: "all",
    conditions: [
      { kind: "device", label: "门已关", deviceName: "门磁传感器" },
      { kind: "time", label: "夜间生效", timeRange: { start: "18:00", end: "23:00" }, weekdays: [1, 2, 3, 4, 5] },
    ],
    schedule: { time: "18:30", weekdays: [1, 2, 3, 4, 5] },
    actions: [{ clientId: "act-1", kind: "set-properties", did: "light-1", deviceName: "客厅灯", model: "yeelink.light.v1", label: "开灯", properties: [{ siid: 2, piid: 1, value: true }] }],
    falseActions: [{ clientId: "act-false-1", kind: "set-properties", did: "light-1", deviceName: "客厅灯", model: "yeelink.light.v1", label: "关灯", properties: [{ siid: 2, piid: 1, value: false }] }],
    effectiveTime: { type: "custom", start: "18:00", end: "23:00", weekdays: [1, 2, 3, 4, 5] },
  }, false);

  const payload = buildAutomationCreatePayload(writeDraft, "test-user");
  assert.equal(payload.scene_trigger.express, 0);
  assert.equal(payload.scene_condition.express, 0);
  assert.equal(payload.scene_condition.conditions.length, 2);
  assert.equal(payload.scene_else_action.actions.length, 1);
  assert.equal(payload.time_filter.start, "18:00");
  assert.equal(payload.time_filter.end, "23:00");

  const updateSource = {
    ...complexScene,
    scene_else_action: {
      mode: 1,
      actions: [{
        id: 9,
        order: 1,
        group_id: 3,
        type: 0,
        name: "关灯",
        protocol_type: 2,
        from: 3,
        sa_id: 5,
        payload_json: { command: "set_properties", did: "light-1", device_name: "客厅灯", model: "yeelink.light.v1", value: [{ siid: 2, piid: 1, value: false }] },
      }],
    },
  };
  const { conditions: _conditions, ...actionOnlyDraft } = writeDraft;
  const updatePayload = buildAutomationUpdatePayload(updateSource, { ...actionOnlyDraft, falseActions: [{ ...writeDraft.falseActions[0], sourceIndex: 0 }] });
  assert.equal(updatePayload.scene_else_action.actions[0].group_id, 3);
  assert.equal(updatePayload.scene_else_action.actions[0].protocol_type, 2);
  assert.equal(updatePayload.scene_else_action.actions[0].sa_id, 5);
  assert.deepEqual(updatePayload.scene_else_action.actions[0].payload_json.value, [{ siid: 2, piid: 1, value: false }]);
});

test("updates conditions from their original Xiaomi nodes without dropping private fields", () => {
  const source = {
    scene_id: "condition-update",
    home_id: "home-1",
    name: "原自动化",
    scene_condition: {
      express: 1,
      private_container_field: "keep",
      conditions: [
        { id: 9, order: 1, src: "device", key: "prop.2.1", name: "旧设备条件", private_field: true, payload_json: { did: "device-a", device_name: "旧设备", opaque: "keep" } },
        { id: 10, order: 2, src: "timer", key: "timer.period", name: "旧时间条件", payload_json: { start: "08:00", end: "22:00", weekdays: [1, 2, 3], opaque: "keep" } },
      ],
    },
  };

  const payload = buildAutomationUpdatePayload(source, {
    homeId: "home-1",
    name: "原自动化",
    conditionMode: "any",
    conditions: [
      { sourceIndex: 0, kind: "device", label: "新设备条件", did: "device-b" },
      { sourceIndex: 1, kind: "time", label: "新时间条件", timeRange: { start: "09:00", end: "21:00" }, weekdays: [1, 2, 3, 4, 5] },
    ],
  });

  assert.equal(payload.scene_condition.express, 1);
  assert.equal(payload.scene_condition.private_container_field, "keep");
  assert.equal(payload.scene_condition.conditions[0].private_field, true);
  assert.equal(payload.scene_condition.conditions[0].payload_json.did, "device-b");
  assert.equal(payload.scene_condition.conditions[0].payload_json.opaque, "keep");
  assert.deepEqual(payload.scene_condition.conditions[1].payload_json, { start: "09:00", end: "21:00", weekdays: [1, 2, 3, 4, 5], opaque: "keep" });
});

test("matches device names and rooms for automation triggers and conditions from device list", async () => {
  const sceneWithRawKeys = {
    scene_id: "auto-switch",
    home_id: "home-1",
    scene_name: "按键开灯",
    enable: 1,
    scene_trigger: {
      express: 0,
      triggers: [
        { src: "device", key: "event.switch-1.2.1", name: "单击", payload_json: { key: "event.switch-1.2.1" } },
      ],
    },
    scene_condition: {
      express: 1,
      conditions: [
        { src: "device", key: "prop.sensor-1.2.1", name: "有人移动", payload_json: { key: "prop.sensor-1.2.1" } },
      ],
    },
    scene_action: {
      actions: [{ order: 1, name: "开灯", payload_json: { command: "set_properties", did: "light-1", device_name: "卫生间灯", model: "yeelink.light.v1", value: [{ siid: 2, piid: 1, value: true }] } }],
    },
  };

  const devices = [
    { did: "switch-1", homeId: "home-1", name: "卫生间无线开关", room: "卫生间", model: "lumi.switch.v1" },
    { did: "sensor-1", home_id: "home-1", name: "卫生间人体传感器", roomName: "卫生间", model: "lumi.sensor.v1" },
  ];

  const [parsed] = parseAutomations({ result: [sceneWithRawKeys] }, "home-1", devices);
  assert.equal(parsed.triggers[0].deviceName, "卫生间无线开关");
  assert.equal(parsed.triggers[0].room, "卫生间");
  assert.equal(parsed.triggers[0].detail, "卫生间无线开关 · 卫生间");
  assert.equal(parsed.conditions?.[0].deviceName, "卫生间人体传感器");
  assert.equal(parsed.conditions?.[0].room, "卫生间");
  assert.equal(parsed.conditions?.[0].detail, "卫生间人体传感器 · 卫生间");

  const templates = buildAutomationTriggerCatalog([sceneWithRawKeys], devices, "home-1");
  assert.equal(templates.length, 1);
  assert.equal(templates[0].deviceName, "卫生间无线开关");
  assert.equal(templates[0].room, "卫生间");
  assert.equal(templates[0].detail, "卫生间无线开关 · 卫生间");

  const draft = await createAutomationEditorDraft(sceneWithRawKeys, "home-1", devices);
  assert.equal(draft.triggers?.[0].deviceName, "卫生间无线开关");
  assert.equal(draft.triggers?.[0].room, "卫生间");
  assert.equal(draft.conditions?.[0].deviceName, "卫生间人体传感器");
  assert.equal(draft.conditions?.[0].room, "卫生间");
});

test("resolves trigger switch device and condition light device with nested array payloads", async () => {
  const bathroomScene = {
    scene_id: "auto-bathroom-light",
    home_id: "home-1",
    scene_name: "卫生间镜柜灯带控制",
    enable: 1,
    scene_trigger: {
      express: 0,
      triggers: [
        { src: "10345678", key: "2.1", name: "单击", payload_json: { key: "event.10345678.2.1" } },
      ],
    },
    scene_condition: {
      express: 1,
      conditions: [
        {
          src: "device",
          key: "2.1",
          name: "灯关",
          payload_json: {
            command: "get_properties",
            value: [{ did: "20345678", siid: 2, piid: 1, value: false }],
          },
        },
      ],
    },
    scene_action: {
      actions: [
        {
          order: 1,
          name: "开灯",
          payload_json: {
            command: "set_properties",
            did: "20345678",
            device_name: "DW情景智能灯带2.0",
            model: "yeelink.light.strip1",
            value: [{ siid: 2, piid: 1, value: true }],
          },
        },
      ],
    },
  };

  const devices = [
    { did: "10345678", homeId: "home-1", name: "卫生间筒灯", room: "卫生间", model: "linp.switch.t2dbw1" },
    { did: "20345678", homeId: "home-1", name: "DW情景智能灯带2.0", room: "卫生间", model: "yeelink.light.strip1" },
  ];

  const [parsed] = parseAutomations({ result: [bathroomScene] }, "home-1", devices);
  assert.equal(parsed.triggers[0].deviceName, "卫生间筒灯");
  assert.equal(parsed.triggers[0].room, "卫生间");
  assert.equal(parsed.triggers[0].detail, "卫生间筒灯 · 卫生间");
  assert.equal(parsed.conditions?.[0].deviceName, "DW情景智能灯带2.0");
  assert.equal(parsed.conditions?.[0].room, "卫生间");
  assert.equal(parsed.conditions?.[0].detail, "DW情景智能灯带2.0 · 卫生间");

  const draft = await createAutomationEditorDraft(bathroomScene, "home-1", devices);
  assert.equal(draft.triggers?.[0].deviceName, "卫生间筒灯");
  assert.equal(draft.triggers?.[0].room, "卫生间");
  assert.equal(draft.conditions?.[0].deviceName, "DW情景智能灯带2.0");
  assert.equal(draft.conditions?.[0].room, "卫生间");
});

test("does not confuse MIoT service identifiers with device identifiers", async () => {
  const scene = {
    scene_id: "auto-miot-key",
    home_id: "home-1",
    scene_name: "卫生间镜柜灯带控制",
    enable: 1,
    scene_trigger: {
      express: 0,
      triggers: [
        { src: "10345678", key: "event.2.1", name: "单击" },
      ],
    },
    scene_condition: {
      express: 1,
      conditions: [
        { src: "device", key: "prop.2.1", name: "灯关", payload_json: { did: "20345678" } },
      ],
    },
    scene_action: { actions: [] },
  };

  const devices = [
    { did: "10345678", homeId: "home-1", name: "卫生间筒灯", room: "卫生间" },
    { did: "20345678", homeId: "home-1", name: "DW情景智能灯带2.0", room: "卫生间" },
  ];

  const [parsed] = parseAutomations({ result: [scene] }, "home-1", devices);
  assert.equal(parsed.triggers[0].deviceName, "卫生间筒灯");
  assert.equal(parsed.triggers[0].room, "卫生间");
  assert.equal(parsed.conditions?.[0].deviceName, "DW情景智能灯带2.0");

  const draft = await createAutomationEditorDraft(scene, "home-1", devices);
  assert.equal(draft.triggers?.[0].deviceName, "卫生间筒灯");
  assert.equal(draft.conditions?.[0].deviceName, "DW情景智能灯带2.0");
});

test("keeps the detail page else branch in the editor and reads batch action device ids", async () => {
  const scene = {
    scene_id: "auto-else-batch",
    home_id: "home-1",
    scene_name: "卫生间镜柜灯带控制",
    enable: 1,
    scene_trigger: {
      express: 0,
      triggers: [{ src: "10345678", key: "event.2.1", name: "单击" }],
    },
    scene_condition: {
      express: 1,
      conditions: [{ src: "device", key: "prop.2.1", name: "灯关", payload_json: { did: "20345678" } }],
    },
    scene_action: {
      actions: [{
        order: 1,
        name: "开灯",
        payload_json: {
          command: "set_properties",
          value: [{ did: "20345678", siid: 2, piid: 1, value: true }],
        },
      }],
    },
    scene_else_action: {
      mode: 1,
      actions: [{
        order: 1,
        name: "关灯",
        payload_json: {
          command: "set_properties",
          value: [{ did: "20345678", siid: 2, piid: 1, value: false }],
        },
      }],
    },
  };

  const devices = [
    { did: "10345678", homeId: "home-1", name: "卫生间筒灯", room: "卫生间" },
    { did: "20345678", homeId: "home-1", name: "DW情景智能灯带2.0", room: "卫生间" },
  ];

  const [parsed] = parseAutomations({ result: [scene] }, "home-1", devices);
  assert.equal(parsed.falseActions?.length, 1);

  const draft = await createAutomationEditorDraft(scene, "home-1", devices);
  assert.equal(draft.falseActions?.length, 1);
  assert.equal(draft.falseActions?.[0].kind, "set-properties");
  assert.equal(draft.falseActions?.[0].did, "20345678");
  assert.equal(draft.falseActions?.[0].deviceName, "DW情景智能灯带2.0");
  assert.equal(draft.actions[0].did, "20345678");
  assert.equal(draft.actions[0].deviceName, "DW情景智能灯带2.0");
});

test("configures and resolves customized sunrise and sunset triggers", () => {
  const sceneWithSunset = {
    scene_id: "sun-scene",
    home_id: "home-1",
    scene_trigger: {
      triggers: [{ id: 1, order: 1, src: "weather", key: "sunset", name: "日落后60分钟 每天" }],
    },
  };

  // Custom label on existing template
  const [updated] = resolveAutomationTriggerSelections([sceneWithSunset], [
    { automationId: "sun-scene", sourceIndex: 0, label: "日落前30分钟 工作日" }
  ]);
  assert.equal(updated.name, "日落前30分钟 工作日");
  assert.equal(updated.key, "sunset");

  // Custom label switching to sunrise
  const [switched] = resolveAutomationTriggerSelections([sceneWithSunset], [
    { automationId: "sun-scene", sourceIndex: 0, label: "日出后15分钟 周末" }
  ]);
  assert.equal(switched.name, "日出后15分钟 周末");
  assert.equal(switched.key, "sunrise");

  // Dynamic sun trigger without pre-existing scene
  const [dyn] = resolveAutomationTriggerSelections([], [
    { automationId: "custom-sun", sourceIndex: 0, label: "日落时 每天" }
  ]);
  assert.equal(dyn.src, "weather");
  assert.equal(dyn.key, "sunset");
  assert.equal(dyn.name, "日落时 每天");
});

test("maps condition sourceIndex to the original Xiaomi array position", async () => {
  const scene = {
    scene_id: "condition-index",
    home_id: "home-1",
    scene_name: "索引一致性",
    scene_condition: {
      express: 1,
      conditions: [
        null,
        { id: 10, order: 2, src: "device", key: "prop.2.1", name: "灯关", payload_json: { did: "device-a", opaque: "keep" } },
        { id: 11, order: 3, src: "timer", key: "timer.period", name: "时间段", payload_json: { start: "08:00", end: "22:00", weekdays: [1, 2, 3] } },
      ],
    },
  };

  const draft = await createAutomationEditorDraft(scene, "home-1", []);
  assert.equal(draft.conditions?.length, 2);
  assert.equal(draft.conditions?.[0].sourceIndex, 1);
  assert.equal(draft.conditions?.[1].sourceIndex, 2);

  const payload = buildAutomationUpdatePayload(scene, {
    homeId: "home-1",
    name: "索引一致性",
    conditions: draft.conditions,
    conditionMode: "all",
  });
  assert.equal(payload.scene_condition.conditions.length, 2);
  assert.equal(payload.scene_condition.conditions[0].payload_json.did, "device-a");
  assert.equal(payload.scene_condition.conditions[0].payload_json.opaque, "keep");
  assert.equal(payload.scene_condition.conditions[1].payload_json.start, "08:00");
});

test("reports specific condition errors instead of a generic unsupported code", () => {
  const scene = {
    scene_id: "condition-errors",
    home_id: "home-1",
    name: "条件错误",
    scene_condition: {
      express: 1,
      conditions: [
        { id: 1, order: 1, src: "device", key: "prop.2.1", name: "灯关", payload_json: { did: "device-a" } },
      ],
    },
  };

  assert.throws(() => buildAutomationUpdatePayload(scene, {
    homeId: "home-1",
    name: "条件错误",
    conditions: [{ kind: "device", label: "没有来源索引", did: "device-b" }],
    conditionMode: "all",
  }), /XIAOMI_AUTOMATION_CONDITION_SOURCE_INVALID/);

  assert.throws(() => buildAutomationUpdatePayload(scene, {
    homeId: "home-1",
    name: "条件错误",
    conditions: [{ kind: "device", label: "越界索引", sourceIndex: 9, did: "device-b" }],
    conditionMode: "all",
  }), /XIAOMI_AUTOMATION_CONDITION_SOURCE_INVALID/);

  assert.throws(() => buildAutomationUpdatePayload(scene, {
    homeId: "home-1",
    name: "条件错误",
    conditions: [{ kind: "time", label: "缺失时间字段", sourceIndex: 0, timeRange: { start: "09:00", end: "21:00" } }],
    conditionMode: "all",
  }), /XIAOMI_AUTOMATION_CONDITION_TIME_UNSUPPORTED/);

  assert.throws(() => buildAutomationUpdatePayload({ scene_id: "no-condition", home_id: "home-1", name: "无条件" }, {
    homeId: "home-1",
    name: "无条件",
    conditions: [],
    conditionMode: "all",
  }), /XIAOMI_AUTOMATION_CONDITION_NODE_INVALID/);
});

test("parses and updates nested time_range payloads created by this app", async () => {
  const created = buildAutomationCreatePayload({
    homeId: "home-1",
    name: "嵌套时间",
    enabled: true,
    triggerMode: "any",
    schedule: { time: "08:00", weekdays: [1, 2, 3, 4, 5, 6, 7] },
    conditionMode: "all",
    conditions: [
      { kind: "time", label: "处于 09:00 ~ 21:00 之间", timeRange: { start: "09:00", end: "21:00" }, weekdays: [1, 2, 3, 4, 5] },
    ],
    actions: [],
  }, "user-1");
  created.scene_id = "nested-time-scene";
  assert.equal(created.scene_condition.conditions[0].payload_json.time_range.start, "09:00");
  assert.equal(created.scene_condition.conditions[0].payload_json.time_range.end, "21:00");

  const draft = await createAutomationEditorDraft(created, "home-1", []);
  assert.equal(draft.conditions?.[0].kind, "time");
  assert.equal(draft.conditions?.[0].timeRange?.start, "09:00");
  assert.equal(draft.conditions?.[0].timeRange?.end, "21:00");
  assert.deepEqual(draft.conditions?.[0].weekdays, [1, 2, 3, 4, 5]);

  const updated = buildAutomationUpdatePayload(created, {
    homeId: "home-1",
    name: "嵌套时间",
    conditions: [
      { ...draft.conditions[0], timeRange: { start: "08:00", end: "22:00" }, weekdays: [1, 2, 3, 4, 5, 6, 7] },
    ],
    conditionMode: "all",
  });
  assert.equal(updated.scene_condition.conditions[0].payload_json.time_range.start, "08:00");
  assert.equal(updated.scene_condition.conditions[0].payload_json.time_range.end, "22:00");
  assert.deepEqual(updated.scene_condition.conditions[0].payload_json.time_range.weekdays, [1, 2, 3, 4, 5, 6, 7]);
});

test("removes a condition while keeping Xiaomi private fields on the remaining node", () => {
  const source = {
    scene_id: "condition-remove",
    home_id: "home-1",
    name: "删除条件",
    scene_condition: {
      express: 1,
      conditions: [
        { id: 1, order: 1, src: "device", key: "prop.2.1", name: "条件一", private_field: "keep", payload_json: { did: "device-a" } },
        { id: 2, order: 2, src: "device", key: "prop.3.1", name: "条件二", payload_json: { did: "device-b" } },
      ],
    },
  };
  const payload = buildAutomationUpdatePayload(source, {
    homeId: "home-1",
    name: "删除条件",
    conditions: [{ sourceIndex: 0, kind: "device", label: "条件一" }],
    conditionMode: "all",
  });
  assert.equal(payload.scene_condition.conditions.length, 1);
  assert.equal(payload.scene_condition.conditions[0].private_field, "keep");
  assert.equal(payload.scene_condition.conditions[0].order, 1);
});

test("restores missing condition source indexes from the current editor draft", () => {
  const submitted = [
    { kind: "device", label: "灯关", did: "device-a" },
    { kind: "weather", label: "气温低于30℃" },
  ];
  const current = [
    { kind: "device", label: "灯关", did: "device-a", sourceIndex: 0 },
    { kind: "weather", label: "气温低于30℃", sourceIndex: 1 },
  ];

  const restored = restoreAutomationConditionSourceIndexes(submitted, current);
  assert.deepEqual(restored?.map(condition => condition.sourceIndex), [0, 1]);

  const partialSource = [{ kind: "device", label: "灯关", sourceIndex: 0 }, { kind: "weather", label: "气温低于30℃" }];
  assert.equal(restoreAutomationConditionSourceIndexes(partialSource, current), partialSource);

  const differentLength = [{ kind: "device", label: "灯关" }];
  assert.equal(restoreAutomationConditionSourceIndexes(differentLength, current), differentLength);
});

test("maps Xiaomi condition express so AND and OR match the Mijia app", async () => {
  const source = {
    scene_id: "condition-mode",
    home_id: "home-1",
    scene_name: "条件模式",
    scene_trigger: { express: 0, triggers: [{ id: 1, order: 1, src: "timer", key: "timer", name: "每天 08:00" }] },
    scene_condition: {
      express: 1,
      conditions: [{ id: 1, order: 1, src: "device", key: "prop.2.1", name: "灯关", payload_json: { did: "device-a" } }],
    },
  };

  const [parsed] = parseAutomations({ result: [source] }, "home-1");
  const draft = await createAutomationEditorDraft(source, "home-1");
  assert.equal(parsed.conditionMode, "any");
  assert.equal(draft.conditionMode, "any");

  const anyPayload = buildAutomationUpdatePayload(source, {
    homeId: "home-1",
    name: "条件模式",
    conditions: [{ sourceIndex: 0, kind: "device", label: "灯关" }],
    conditionMode: "any",
  });
  assert.equal(anyPayload.scene_condition.express, 1);

  const allPayload = buildAutomationUpdatePayload(source, {
    homeId: "home-1",
    name: "条件模式",
    conditions: [{ sourceIndex: 0, kind: "device", label: "灯关" }],
    conditionMode: "all",
  });
  assert.equal(allPayload.scene_condition.express, 0);
});
