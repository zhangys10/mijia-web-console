import assert from "node:assert/strict";
import test from "node:test";

import {
  assertHomeAccess,
  listManualScenes,
  loadSceneActionCapabilities,
  loadSceneDeviceCapabilities,
  parseManualScenes,
  runManualScene,
  sceneDeviceCapabilityKey,
  selectRunnableManualScene,
} from "../lib/xiaomi-scenes.ts";

const session = {
  userId: "redacted-user",
  ssecurity: "unused-in-injected-tests",
  serviceToken: "unused-in-injected-tests",
  region: "cn",
  createdAt: 0,
};

test("normalizes only manual scenes for the requested home", () => {
  const response = {
    result: {
      scene_info_list: [
        {
          scene_id: 11,
          home_id: 100,
          name: "回家",
          icon: "home",
          enable: 1,
          scene_trigger: { triggers: [{ src: "user" }] },
          scene_condition: { conditions: [{ order: 1, name: "仅在夜间", value: "生效" }] },
          scene_action: { actions: [
            { order: 2, name: "设置灯光", payload_json: { command: "set_properties", device_name: "客厅灯", did: "secret-device", uid: "secret-user", value: [{ siid: 2, piid: 2, value: 80 }, { siid: 2, piid: 3, value: 4000 }] } },
            { order: 1, name: "开", payload_json: JSON.stringify({ command: "set_properties", device_name: "玄关灯", did: "another-secret", value: [{ siid: 2, piid: 1, value: true }] }) },
            { order: 3, name: "设置空调", payload_json: { command: "set_properties", device_name: "次卧空调", did: "ac-secret", value: [{ siid: 2, piid: 2, value: 1 }, { siid: 2, piid: 1, value: true }, { siid: 2, piid: 4, value: 24 }] } },
          ] },
          update_time: 1234,
          owner_uid: "must-not-leak",
        },
        {
          scene_id: "12",
          home_id: "100",
          scene_name: "晚安",
          enabled: "false",
          scene_trigger: JSON.stringify({ triggers: [{ src: "user" }] }),
          setting: JSON.stringify({ action_list: [{}, {}, {}] }),
        },
        {
          scene_id: "automation",
          home_id: "100",
          name: "自动开灯",
          scene_trigger: { triggers: [{ src: "timer" }] },
        },
        {
          scene_id: "other-home",
          home_id: "200",
          name: "别人的场景",
          scene_trigger: { triggers: [{ src: "user" }] },
        },
        { home_id: "100", name: "缺少 ID", scene_trigger: { triggers: [{ src: "user" }] } },
        { scene_id: "missing-name", home_id: "100", scene_trigger: { triggers: [{ src: "user" }] } },
      ],
    },
  };

  const devices = [
    { did: "another-secret", homeId: "100", roomName: "玄关" },
    { did: "secret-device", homeId: "100", roomName: "客厅" },
    { did: "ac-secret", homeId: "100", roomName: "次卧", model: "xiaomi.aircondition.ma1", name: "次卧空调" },
    { did: "secret-device", homeId: "200", roomName: "其他家庭" },
  ];
  const capabilities = new Map([
    [sceneDeviceCapabilityKey("100", "another-secret"), [{ name: "light", properties: [{ name: "on", label: "电源", siid: 2, piid: 1, format: "bool", readable: true, writable: true }] }]],
    [sceneDeviceCapabilityKey("100", "secret-device"), [{ name: "light", properties: [
      { name: "brightness", label: "亮度", siid: 2, piid: 2, format: "uint8", readable: true, writable: true, range: { min: 1, max: 100, step: 1 } },
      { name: "color-temperature", label: "色温", siid: 2, piid: 3, format: "uint16", readable: true, writable: true, range: { min: 2700, max: 6500, step: 1 } },
    ] }]],
    [sceneDeviceCapabilityKey("100", "ac-secret"), [{ name: "air-conditioner", properties: [
      { name: "on", label: "电源", siid: 2, piid: 1, format: "bool", readable: true, writable: true },
      { name: "mode", label: "工作模式", siid: 2, piid: 2, format: "uint8", readable: true, writable: true, choices: [{ value: 1, label: "制冷" }] },
      { name: "target-temperature", label: "目标温度", siid: 2, piid: 4, format: "uint8", readable: true, writable: true, unit: "celsius", range: { min: 16, max: 30, step: 1 } },
    ] }]],
  ]);
  assert.deepEqual(parseManualScenes(response, "100", devices, capabilities), [
    {
      id: "11", homeId: "100", name: "回家", icon: "home", enabled: true, actionCount: 3, updatedAt: "1234",
      actions: [
        { order: 1, label: "开", deviceName: "玄关灯", room: "玄关", details: [{ kind: "power", label: "电源", value: "开启", state: "on" }] },
        { order: 2, label: "设置灯光", deviceName: "客厅灯", room: "客厅", details: [{ kind: "brightness", label: "亮度", value: "80%" }, { kind: "color-temperature", label: "色温", value: "4000 K" }] },
        { order: 3, label: "设置空调", deviceName: "次卧空调", room: "次卧", details: [{ kind: "property", label: "工作模式", value: "制冷" }, { kind: "power", label: "电源", value: "开启", state: "on" }, { kind: "property", label: "目标温度", value: "24°C" }] },
      ],
    },
    {
      id: "12", homeId: "100", name: "晚安", enabled: false, actionCount: 3,
      actions: [
        { order: 1, label: "执行动作", details: [] },
        { order: 2, label: "执行动作", details: [] },
        { order: 3, label: "执行动作", details: [] },
      ],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(parseManualScenes(response, "100", devices)), /must-not-leak|secret-device|secret-user|another-secret|ac-secret|其他家庭/);
});

test("keeps an unknown property unknown when its device specification is unavailable", () => {
  const scenes = parseManualScenes({ result: [{
    scene_id: "curtain-scene",
    home_id: "home",
    name: "关帘",
    scene_trigger: { triggers: [{ src: "user" }] },
    scene_action: { actions: [{
      name: "关闭纱帘",
      payload_json: { command: "set_properties", did: "curtain", device_name: "主卧纱帘", value: [{ siid: 2, piid: 1, value: 1 }] },
    }] },
  }] }, "home");
  assert.deepEqual(scenes[0].actions[0].details[0], { kind: "property", label: "未识别属性", value: "1" });
  assert.doesNotMatch(JSON.stringify(scenes), /属性 2\.1/);
});

test("uses the device specification rather than Xiaomi's action name to describe enum modes", () => {
  const scene = name => ({
    scene_id: name, home_id: "home", name, scene_trigger: { triggers: [{ src: "user" }] },
    scene_action: { actions: [{ name, payload_json: { command: "set_properties", did: "strip", device_name: "客厅智能灯带", value: [{ siid: 2, piid: 4, value: 11 }] } }] },
  });
  const devices = [{ did: "strip", homeId: "home", roomName: "客厅", model: "vendor.light.strip" }];
  const capabilities = new Map([[sceneDeviceCapabilityKey("home", "strip"), [{ name: "light", properties: [{ name: "mode", label: "工作模式", siid: 2, piid: 4, format: "uint8", readable: true, writable: true, choices: [{ value: 11, label: "会客模式" }] }] }]]]);
  for (const actionName of ["设置设备属性", "会客模式"]) {
    const parsed = parseManualScenes({ result: [scene(actionName)] }, "home", devices, capabilities);
    assert.deepEqual(parsed[0].actions[0].details, [{ kind: "property", label: "工作模式", value: "会客模式" }]);
  }
});

test("loads scene specifications once per model and isolates failures and homes", async () => {
  const calls = [];
  const devices = [
    { did: "one", homeId: "home", model: "vendor.light.shared" },
    { did: "two", homeId: "home", model: "vendor.light.shared" },
    { did: "failed", homeId: "home", model: "vendor.light.failed" },
    { did: "other-home", homeId: "other", model: "vendor.light.other" },
  ];
  const capabilities = await loadSceneDeviceCapabilities(devices, "home", async model => {
    calls.push(model);
    if (model.endsWith("failed")) throw new Error("MIOT_SPEC_UNAVAILABLE");
    return { groups: [{ name: "light", properties: [] }] };
  });
  assert.deepEqual(calls.sort(), ["vendor.light.failed", "vendor.light.shared"]);
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "one")), [{ name: "light", properties: [] }]);
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "two")), [{ name: "light", properties: [] }]);
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "failed")), []);
  assert.equal(capabilities.has(sceneDeviceCapabilityKey("other", "other-home")), false);
});

test("loads specifications from scene action models without repeating device discovery", async () => {
  const calls = [];
  const scenes = [{ home_id: "home", scene_action: { actions: [
    { model: "vendor.light.shared", payload_json: { did: "one" } },
    { payload_json: { did: "two", model: "vendor.light.shared" } },
    { model: "vendor.light.failed", payload_json: { did: "failed" } },
  ] } }];
  const existing = new Map([[sceneDeviceCapabilityKey("home", "one"), [{ name: "light", properties: [{ name: "on" }] }]]]);
  const capabilities = await loadSceneActionCapabilities(scenes, "home", existing, async model => {
    calls.push(model);
    if (model.endsWith("failed")) throw new Error("MIOT_SPEC_UNAVAILABLE");
    return { groups: [{ name: "light", properties: [] }] };
  });
  assert.deepEqual(calls.sort(), ["vendor.light.failed", "vendor.light.shared"]);
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "one")), existing.get(sceneDeviceCapabilityKey("home", "one")));
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "two")), [{ name: "light", properties: [] }]);
  assert.deepEqual(capabilities.get(sceneDeviceCapabilityKey("home", "failed")), []);
});

test("accepts numbered scene maps and rejects unrecognized responses", () => {
  assert.deepEqual(parseManualScenes({ result: { 0: { id: "one", name: "手动", triggers: [{ src: "USER" }] } } }, "home"), [
    {
      id: "one", homeId: "home", name: "手动", enabled: true, actionCount: 0,
      actions: [],
    },
  ]);
  assert.throws(() => parseManualScenes({ result: { unexpected: [] } }, "home"), /XIAOMI_SCENE_RESPONSE_INVALID/);
});

test("treats Xiaomi's null result for a home without scenes as an empty list", () => {
  assert.deepEqual(parseManualScenes({ result: null }, "empty-home"), []);
  assert.throws(() => parseManualScenes({}, "empty-home"), /XIAOMI_SCENE_RESPONSE_INVALID/);
});

test("enforces home and scene isolation before execution", () => {
  const scenes = [
    { id: "enabled", homeId: "home-a", name: "回家", enabled: true, actionCount: 1 },
    { id: "disabled", homeId: "home-a", name: "晚安", enabled: false, actionCount: 1 },
    { id: "enabled", homeId: "home-b", name: "另一个家", enabled: true, actionCount: 1 },
  ];
  assert.doesNotThrow(() => assertHomeAccess([{ id: "home-a" }], "home-a"));
  assert.throws(() => assertHomeAccess([{ id: "home-a" }], "home-b"), /XIAOMI_HOME_NOT_FOUND/);
  assert.equal(selectRunnableManualScene(scenes, "home-a", "enabled").name, "回家");
  assert.throws(() => selectRunnableManualScene(scenes, "home-a", "disabled"), /XIAOMI_SCENE_DISABLED/);
  assert.throws(() => selectRunnableManualScene(scenes, "home-a", "missing"), /XIAOMI_SCENE_NOT_FOUND/);
  assert.throws(() => selectRunnableManualScene(scenes, "home-b", "disabled"), /XIAOMI_SCENE_NOT_FOUND/);
});

test("uses the verified scene-list endpoint and propagates upstream failures", async () => {
  let call;
  const scenes = await listManualScenes(session, "home-1", async (_session, path, data) => {
    call = { path, data };
    return { result: { scene_list: [{ id: "scene-1", name: "测试", triggers: [{ src: "user" }] }] } };
  });
  assert.deepEqual(call, {
    path: "/app/appgateway/miot/appsceneservice/AppSceneService/GetSceneList",
    data: { home_id: "home-1" },
  });
  assert.equal(scenes[0].homeId, "home-1");
  await assert.rejects(
    listManualScenes(session, "home-1", async () => { throw new Error("XIAOMI_CLOUD_HTTP_503"); }),
    /XIAOMI_CLOUD_HTTP_503/,
  );
});

test("submits the exact verified manual scene payload", async () => {
  let call;
  await runManualScene(session, "scene-9", async (_session, path, data) => {
    call = { path, data };
    return { result: true };
  });
  assert.deepEqual(call, {
    path: "/app/appgateway/miot/appsceneservice/AppSceneService/NewRunScene",
    data: { scene_id: "scene-9", scene_type: 2, trigger_key: "user.click" },
  });
  await assert.rejects(runManualScene(session, "scene-9", async () => ({ result: false })), /XIAOMI_SCENE_NOT_ACCEPTED/);
});
