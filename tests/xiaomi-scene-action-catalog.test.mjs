import assert from "node:assert/strict";
import test from "node:test";

import { loadSceneActionCatalog, sceneCatalogTemplateSupportsAction } from "../lib/xiaomi-scene-action-catalog.ts";

const session = { userId: "user", ssecurity: "test", serviceToken: "test", region: "cn", createdAt: 1 };
const devices = [{ did: "light-1", homeId: "home-1", name: "Lamp", roomName: "Living", model: "vendor.light.v1" }];
const specification = {
  model: "vendor.light.v1",
  urn: "urn:test",
  description: "Light",
  groups: [{
    key: "2", name: "light", label: "灯光", sourceLabel: "Light", siid: 2,
    properties: [
      { key: "2.1", name: "on", label: "开关", sourceLabel: "Power", siid: 2, piid: 1, format: "bool", readable: true, writable: true, notify: true },
      { key: "2.2", name: "brightness", label: "亮度", sourceLabel: "Brightness", siid: 2, piid: 2, format: "uint8", readable: true, writable: true, notify: true, range: { min: 1, max: 100, step: 1 } },
    ],
    actions: [
      { key: "2.a1", name: "toggle", label: "切换", sourceLabel: "Toggle", siid: 2, aiid: 1, inputs: [] },
      { key: "2.a2", name: "custom", label: "自定义", sourceLabel: "Custom", siid: 2, aiid: 2, inputs: [1] },
    ],
    events: [],
  }],
};

function tca(actionList, blackDids) {
  return async () => ({ result: { TCA_list: { model_TCA_list: [{ model: "vendor.light.v1", dids: ["light-1"], value: { launch: [], action_list: actionList.map(item => ({ ...item, ...(blackDids ? { black_dids: blackDids } : {}) })) } }] }, has_more: false } });
}

test("scene action catalog uses authoritative per-device TCA actions and raw labels", async () => {
  let modelFallbacks = 0;
  const catalog = await loadSceneActionCatalog(session, "home-1", "owner-1", devices, {
    request: tca([
      { sa_id: 1, intro: "Power off", payload: JSON.stringify({ command: "set_properties", value: [{ siid: 2, piid: 1, value: false }] }) },
      { sa_id: 2, intro: "Toggle now", command: "vendor.light.v1.action", value: "{\"siid\":2,\"aiid\":1,\"in\":[]}" },
      { sa_id: 3, intro: "Custom", command: "vendor.light.v1.action", value: "{\"siid\":2,\"aiid\":2,\"in\":[{\"piid\":1,\"value\":1}]}" },
    ]),
    loadModelCatalog: async () => { modelFallbacks++; throw new Error("must not load"); },
    loadCapabilities: async () => specification,
  });
  assert.equal(modelFallbacks, 0);
  assert.equal(catalog[0].source, "tca-v3");
  assert.deepEqual(catalog[0].actions.map(action => action.label), ["Power off", "Toggle now"]);
  assert.equal(catalog[0].actions[0].properties[0].label, "Power");
  assert.equal(catalog[0].actions[0].properties[0].value, false);
  assert.equal(catalog[0].actions[1].kind, "invoke-action");
});

test("an authoritative empty or blacklisted TCA list does not fall back", async () => {
  const empty = await loadSceneActionCatalog(session, "home-1", "owner-1", devices, { request: tca([]), loadModelCatalog: async () => { throw new Error("must not load"); }, loadCapabilities: async () => specification });
  assert.equal(empty[0].source, "tca-v3");
  assert.deepEqual(empty[0].actions, []);
  const blocked = await loadSceneActionCatalog(session, "home-1", "owner-1", devices, { request: tca([{ sa_id: 1, intro: "Power off", command: "vendor.light.v1.set_properties", value: "[{\"siid\":2,\"piid\":1,\"value\":false}]" }], ["light-1"]), loadCapabilities: async () => specification });
  assert.deepEqual(blocked[0].actions, []);
});

test("scene action catalog falls back from model catalog to MIoT Spec", async () => {
  const model = await loadSceneActionCatalog(session, "home-1", "owner-1", devices, {
    request: async () => { throw new Error("TCA unavailable"); },
    loadModelCatalog: async () => ({ capabilities: [], actions: [{ key: "model:1", kind: "set-property", label: "Set brightness", detail: "Light", source: "model-catalog", siid: 2, piid: 2, value: 50 }] }),
    loadCapabilities: async () => specification,
  });
  assert.equal(model[0].source, "model-catalog");
  assert.equal(model[0].actions[0].properties[0].value, 50);

  const miot = await loadSceneActionCatalog(session, "home-1", "owner-1", devices, {
    request: async () => { throw new Error("TCA unavailable"); },
    loadModelCatalog: async () => { throw new Error("model unavailable"); },
    loadCapabilities: async () => specification,
  });
  assert.equal(miot[0].source, "miot-spec");
  assert.deepEqual(miot[0].actions.map(action => action.label), ["Power", "Brightness", "Toggle"]);
  assert.equal(miot[0].actions.find(action => action.label === "Power").properties[0].configurable, true);
});

test("catalog templates validate fixed, configurable, and invoke actions", () => {
  const fixed = { key: "action-1", kind: "set-properties", label: "Power off", detail: "", source: "tca-v3", serviceLabel: "Light", properties: [{ siid: 2, piid: 1, name: "on", label: "Power", format: "bool", configurable: false, value: false }] };
  assert.equal(sceneCatalogTemplateSupportsAction(fixed, { kind: "set-properties", properties: [{ siid: 2, piid: 1, value: false }] }), true);
  assert.equal(sceneCatalogTemplateSupportsAction(fixed, { kind: "set-properties", properties: [{ siid: 2, piid: 1, value: true }] }), false);
  const invoke = { key: "action-2", kind: "invoke-action", label: "Toggle", detail: "", source: "miot-spec", serviceLabel: "Light", siid: 2, aiid: 1 };
  assert.equal(sceneCatalogTemplateSupportsAction(invoke, { kind: "invoke-action", siid: 2, aiid: 1 }), true);
});
