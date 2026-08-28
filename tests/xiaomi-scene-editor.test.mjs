import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBasicSceneDraft,
  assertSceneActionSources,
  buildCreatePayload,
  buildUpdatePayload,
  createEditorDraft,
  sceneIdFromEditResponse,
  sceneDraftMatchesWrite,
  sceneRevision,
  submitSceneEdit,
  validateSceneDraftCapabilities,
} from "../lib/xiaomi-scene-editor.ts";
import { isScenePropertyValueSupported, isSceneWritableProperty, mapScenePropertySemantics, scenePropertySemantics } from "../lib/xiaomi-scene-properties.ts";

const modernScene = {
  scene_id: "scene-1",
  home_id: "home-1",
  name: "晚安",
  icon: "moon",
  enable: true,
  owner_uid: "must-stay-server-side",
  unknown_top_level: { preserve: true },
  scene_trigger: { triggers: [{ src: "user", key: "user.click" }] },
  scene_action: {
    unknown_container: "keep",
    actions: [
      { order: 1, name: "设置灯光", type: 0, model: "vendor.light.v1", keep: "yes", payload_json: JSON.stringify({ command: "set_properties", did: "light-1", device_name: "床头灯", token: "opaque", value: [{ siid: 2, piid: 1, value: false }, { siid: 2, piid: 2, value: 20 }] }) },
      { order: 2, name: "私有命令", payload_json: { command: "vendor_private", did: "private-1", secret: "opaque" } },
    ],
  },
};

test("creates a safe editor draft and locks action editing when a raw action is unknown", async () => {
  const draft = await createEditorDraft(modernScene, "home-1");
  assert.equal(draft.sceneId, "scene-1");
  assert.equal(draft.actionsEditable, false);
  assert.deepEqual(draft.actions[0], {
    clientId: "source-0", sourceIndex: 0, kind: "set-properties", did: "light-1", deviceName: "床头灯", model: "vendor.light.v1", label: "设置灯光",
    properties: [{ siid: 2, piid: 1, value: false }, { siid: 2, piid: 2, value: 20 }],
  });
  assert.equal(draft.actions[1].kind, "unsupported");
  assert.doesNotMatch(JSON.stringify(draft), /must-stay-server-side|token|secret/);
  assert.match(draft.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(draft.revision, await sceneRevision({ ...modernScene, name: "改名" }));
});

test("metadata-only updates preserve every unknown field and encoded action payload", () => {
  const payload = buildUpdatePayload(modernScene, { homeId: "home-1", name: "睡眠", revision: "a".repeat(64) });
  assert.equal(payload.name, "睡眠");
  assert.equal(payload.icon, "moon", "the existing cloud icon must be preserved");
  assert.deepEqual(payload.unknown_top_level, { preserve: true });
  assert.equal(payload.scene_action.unknown_container, "keep");
  assert.equal(payload.scene_action.actions[0].keep, "yes");
  assert.equal(typeof payload.scene_action.actions[0].payload_json, "string");
  assert.equal(JSON.parse(payload.scene_action.actions[0].payload_json).token, "opaque");
  assert.equal(payload.edit_from, 0);
  assert.equal(payload.value_format, 1);
  assert.equal(modernScene.name, "晚安", "the original cloud record must not be mutated");
});

test("supported modern actions can be changed and reordered without dropping source metadata", () => {
  const source = structuredClone(modernScene);
  source.scene_action.actions = [source.scene_action.actions[0]];
  const payload = buildUpdatePayload(source, {
    homeId: "home-1", name: "柔光", revision: "b".repeat(64), actions: [{
      clientId: "source-0", sourceIndex: 0, kind: "set-properties", did: "light-1", deviceName: "床头灯", model: "vendor.light.v1", label: "柔光", properties: [{ siid: 2, piid: 2, value: 35 }],
    }],
  });
  const action = payload.scene_action.actions[0];
  assert.equal(action.keep, "yes");
  assert.equal(action.order, 1);
  assert.equal(action.name, "柔光");
  assert.deepEqual(JSON.parse(action.payload_json), { command: "set_properties", did: "light-1", delay_time: 0, device_name: "床头灯", model: "vendor.light.v1", token: "opaque", value: [{ did: "light-1", siid: 2, piid: 2, value: 35 }] });
  assert.equal(payload.authed, undefined);
});

test("source action identities cannot be duplicated or moved to another device or action kind", async () => {
  const source = structuredClone(modernScene);
  source.scene_action.actions = [source.scene_action.actions[0]];
  const original = (await createEditorDraft(source, "home-1")).actions;
  const action = original[0];
  assert.doesNotThrow(() => assertSceneActionSources([action], original));
  assert.throws(() => assertSceneActionSources([action, action], original), /INVALID_SCENE_ACTION_SOURCE/);
  assert.throws(() => assertSceneActionSources([{ ...action, did: "other-light" }], original), /INVALID_SCENE_ACTION_SOURCE/);
  assert.throws(() => assertSceneActionSources([{ ...action, kind: "invoke-action", properties: undefined, siid: 2, aiid: 1 }], original), /INVALID_SCENE_ACTION_SOURCE/);
});

test("write verification checks metadata and every requested action value", async () => {
  const source = structuredClone(modernScene);
  source.scene_action.actions = [source.scene_action.actions[0]];
  const actual = await createEditorDraft(source, "home-1");
  const expected = { homeId: "home-1", name: "晚安", enabled: true, actions: [actual.actions[0]] };
  assert.equal(sceneDraftMatchesWrite(actual, expected), true);
  assert.equal(sceneDraftMatchesWrite(actual, { ...expected, name: "不同名称" }), false);
  assert.equal(sceneDraftMatchesWrite(actual, { ...expected, actions: [{ ...actual.actions[0], properties: [{ siid: 2, piid: 1, value: true }, { siid: 2, piid: 2, value: 20 }] }] }), false);
});

test("new scenes use the modern manual trigger and supported action representation", () => {
  const payload = buildCreatePayload({ homeId: "home-1", name: "测试场景", actions: [{ clientId: "new", kind: "set-properties", did: "light-1", deviceName: "灯", model: "vendor.light.v1", label: "关灯", properties: [{ siid: 2, piid: 1, value: false }] }] }, "user-1");
  assert.equal(payload.scene_name, "测试场景");
  assert.equal(payload.name, undefined);
  assert.equal(payload.icon, undefined);
  assert.equal(payload.icon_url, undefined);
  assert.deepEqual(payload.scene_condition, { express: 0 });
  assert.deepEqual(payload.scene_trigger, { express: 0, triggers: [{ id: 0, order: 1, src: "user", name: "", key: "user.click", value_type: 5 }] });
  assert.equal(payload.scene_action.mode, 1);
  assert.equal(payload.scene_action.actions[0].id, 1);
  assert.equal(payload.scene_action.actions[0].group_id, 1);
  assert.equal(payload.scene_action.actions[0].protocol_type, 2);
  assert.equal(payload.scene_action.actions[0].from, 3);
  assert.equal(payload.scene_action.actions[0].sa_id, 5);
  assert.deepEqual(payload.scene_action.actions[0].payload_json, { command: "set_properties", did: "light-1", delay_time: 0, device_name: "灯", model: "vendor.light.v1", uid: "user-1", value: [{ did: "light-1", siid: 2, piid: 1, value: false }] });
  assert.equal(payload.authed, undefined);
});

test("validates scene drafts and checks device MIoT capabilities server-side", async () => {
  const draft = assertBasicSceneDraft({ homeId: "home-1", name: " 阅读 ", icon: "forged-icon", actions: [{ clientId: "one", kind: "set-properties", did: "light-1", deviceName: "伪造名称", model: "fake.model", label: "开灯", properties: [{ siid: 2, piid: 1, value: true }] }] }, false);
  assert.equal("icon" in draft, false, "clients cannot write scene icons");
  const validated = await validateSceneDraftCapabilities(draft, [{ did: "light-1", homeId: "home-1", name: "真实灯具", model: "vendor.light.v1", urn: "urn:miot-spec-v2:device:light:0000A001:vendor-v1:1" }], async () => ({ model: "vendor.light.v1", urn: "urn:test", description: "灯", groups: [{ key: "2", name: "light", label: "灯光", siid: 2, properties: [{ key: "2.1", name: "on", label: "开关", siid: 2, piid: 1, format: "bool", readable: true, writable: true, notify: true }], actions: [], events: [] }] }));
  assert.equal(validated.name, "阅读");
  assert.equal(validated.actions[0].deviceName, "真实灯具");
  assert.equal(validated.actions[0].model, "vendor.light.v1");
  assert.throws(() => assertBasicSceneDraft({ homeId: "home-1", name: "不支持", actions: [{ clientId: "one", kind: "invoke-action", did: "light-1", deviceName: "灯", model: "vendor.light.v1", label: "切换", siid: 2, aiid: 1 }] }, false), /INVALID_SCENE_ACTION/);
  await assert.rejects(validateSceneDraftCapabilities({ ...draft, homeId: "home-2" }, [{ did: "light-1", homeId: "home-1", model: "vendor.light.v1" }], async () => { throw new Error("must not load"); }), /XIAOMI_SCENE_DEVICE_NOT_FOUND/);
  await assert.rejects(validateSceneDraftCapabilities({ ...draft, actions: [{ ...draft.actions[0], properties: [{ siid: 2, piid: 1, value: "not-boolean" }] }] }, [{ did: "light-1", homeId: "home-1", model: "vendor.light.v1" }], async () => ({ model: "vendor.light.v1", urn: "urn:test", description: "灯", groups: [{ key: "2", name: "light", label: "灯", siid: 2, properties: [{ key: "2.1", name: "on", label: "开关", siid: 2, piid: 1, format: "bool", readable: true, writable: true, notify: true }], actions: [], events: [] }] })), /XIAOMI_SCENE_PROPERTY_UNSUPPORTED/);
  const virtualDraft = { ...draft, actions: [{ ...draft.actions[0], did: "light-1.s2", sourceIndex: 0 }] };
  const virtualDevices = [{ did: "light-1.s2", homeId: "home-1", name: "派生灯", model: "vendor.light.v1" }];
  const loader = async () => ({ model: "vendor.light.v1", urn: "urn:test", description: "灯", groups: [{ key: "2", name: "light", label: "灯", siid: 2, properties: [{ key: "2.1", name: "on", label: "开关", siid: 2, piid: 1, format: "bool", readable: true, writable: true, notify: true }], actions: [], events: [] }] });
  await assert.rejects(validateSceneDraftCapabilities(virtualDraft, virtualDevices, loader), /XIAOMI_SCENE_DEVICE_NOT_FOUND/, "new scenes cannot forge virtual targets");
  await assert.doesNotReject(validateSceneDraftCapabilities(virtualDraft, virtualDevices, loader, true), "an authenticated update may preserve an original virtual target");
  const groupDraft = { ...draft, actions: [{ ...draft.actions[0], did: "group.light-1" }] };
  await assert.doesNotReject(validateSceneDraftCapabilities(groupDraft, [{ did: "group.light-1", homeId: "home-1", name: "灯组", model: "vendor.light.v1" }], loader), "real same-home light groups can be new scene targets");
});

test("exposes only standard user-facing properties with a safe value editor", () => {
  const property = { name: "brightness", format: "uint8", readable: true, writable: true, range: { min: 1, max: 100, step: 1 } };
  assert.equal(isSceneWritableProperty("light", property), true);
  assert.equal(isSceneWritableProperty("light", { ...property, name: "factory-reset", format: "bool", range: undefined }), false);
  assert.equal(isSceneWritableProperty("custom-service", { ...property, name: "on", format: "bool", range: undefined }), false);
  assert.equal(isSceneWritableProperty("light", { ...property, readable: false }), false);
  assert.equal(isSceneWritableProperty("light", { ...property, range: undefined }), false);
  assert.equal(isScenePropertyValueSupported(property, 50), true);
  assert.equal(isScenePropertyValueSupported(property, 50.5), false, "range step must be enforced");
  assert.equal(isScenePropertyValueSupported(property, 101), false);
});

test("maps batch light values by semantic names instead of copying device-specific MIoT ids", () => {
  const reference = [{ name: "light", properties: [
    { name: "on", label: "开关", siid: 2, piid: 1, format: "bool", readable: true, writable: true },
    { name: "brightness", label: "亮度", siid: 2, piid: 2, format: "uint8", readable: true, writable: true, range: { min: 1, max: 100, step: 1 } },
  ] }];
  const target = [{ name: "light", properties: [
    { name: "on", label: "开关", siid: 3, piid: 5, format: "bool", readable: true, writable: true },
    { name: "brightness", label: "亮度", siid: 3, piid: 8, format: "uint8", readable: true, writable: true, range: { min: 1, max: 100, step: 1 } },
  ] }];
  const semantics = scenePropertySemantics([{ siid: 2, piid: 1, value: true }, { siid: 2, piid: 2, value: 35 }], reference);
  assert.deepEqual(mapScenePropertySemantics(semantics, target), [
    { siid: 3, piid: 5, value: true, label: "开关" },
    { siid: 3, piid: 8, value: 35, label: "亮度" },
  ]);
  assert.equal(mapScenePropertySemantics(semantics, [{ name: "light", properties: target[0].properties.slice(0, 1) }]), undefined);
  const switchSemantics = [{ serviceName: "switch", propertyName: "on", label: "开关", value: false }];
  const switches = [2, 3].map(siid => ({ name: "switch", properties: [{ name: "on", label: "开关", siid, piid: 1, format: "bool", readable: true, writable: true }] }));
  assert.deepEqual(mapScenePropertySemantics(switchSemantics, switches, { name: "switch", siid: 3 }), [{ siid: 3, piid: 1, value: false, label: "开关" }]);
});

test("submits the exact AppSceneService Edit endpoint and recognizes returned ids", async () => {
  let call;
  const session = { userId: "u", ssecurity: "s", serviceToken: "t", region: "cn", createdAt: 0 };
  const response = await submitSceneEdit(session, { name: "测试" }, async (_session, path, data) => { call = { path, data }; return { result: { scene_id: "created-1" } }; });
  assert.deepEqual(call, { path: "/app/appgateway/miot/appsceneservice/AppSceneService/Edit", data: { name: "测试" } });
  assert.equal(sceneIdFromEditResponse(response), "created-1");
  await assert.rejects(submitSceneEdit(session, {}, async () => ({ result: false })), /XIAOMI_SCENE_NOT_ACCEPTED/);
});
