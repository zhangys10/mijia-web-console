import assert from "node:assert/strict";
import test from "node:test";

import {
  SCENE_TCA_CONFIG_V3_PATH,
  discoverDeviceAutomationCatalog,
  listSceneTcaConfigV3,
  parseAutomationModelSceneCatalog,
  parseSceneTcaConfigV3Page,
} from "../lib/xiaomi-automation-catalog.ts";

const session = {
  userId: "test-user",
  ssecurity: "unused-test-security",
  serviceToken: "unused-test-token",
  region: "cn",
  createdAt: 1,
};

function modelEnvelope(launch = [], actionList = []) {
  return { result: "ok", code: 0, data: { launch, action_list: actionList } };
}

test("parses the official model scene catalog without guessing dotted model boundaries", () => {
  const catalog = parseAutomationModelSceneCatalog(modelEnvelope([
    { sc_id: 89342, intro: "右键关", key: "prop.xiaomi.controller.oh4w.16.1", value: "false" },
    { sc_id: 89350, intro: "单击右键（需转无线开关）", key: "event.xiaomi.controller.oh4w.22.1", value: "" },
    { sc_id: 89351, intro: "低于指定值", key: "prop.xiaomi.controller.oh4w.9.1", value: "{\"min\":0,\"max\":99}" },
    { sc_id: 89352, intro: "高于指定值", key: "prop.xiaomi.controller.oh4w.9.1", value: "{\"min\":0,\"max\":99}" },
  ], [
    { sa_id: 106188, intro: "关闭右键", command: "xiaomi.controller.oh4w.set_properties", value: "[{\"siid\":16,\"piid\":1,\"value\":false}]" },
    { sa_id: 139971, intro: "播放指定文字", command: "xiaomi.controller.oh4w.action", value: "{\"siid\":5,\"aiid\":3,\"in\":[{\"piid\":1,\"value\":\"{}\"}]}" },
  ]), "xiaomi.controller.oh4w");

  assert.equal(catalog.capabilities.length, 4, "different sc_id values must survive even when key/value match");
  assert.deepEqual(catalog.capabilities[0], {
    key: "model-catalog:condition:89342",
    kind: "property",
    label: "右键关",
    detail: "设备属性 · 关闭",
    source: "model-catalog",
    siid: 16,
    piid: 1,
    value: false,
  });
  assert.equal(catalog.capabilities[1].kind, "event");
  assert.equal(catalog.capabilities[1].siid, 22);
  assert.equal(catalog.capabilities[1].eiid, 1);
  assert.deepEqual(catalog.actions[0], {
    key: "model-catalog:action:106188",
    kind: "set-property",
    label: "关闭右键",
    detail: "设置设备属性",
    source: "model-catalog",
    siid: 16,
    piid: 1,
    value: false,
  });
  assert.equal(catalog.actions[1].kind, "action");
  assert.equal(catalog.actions[1].siid, 5);
  assert.equal(catalog.actions[1].aiid, 3);
  assert.doesNotMatch(JSON.stringify(catalog), /command|payload|xiaomi\.controller\.oh4w\.action/);
});

test("keeps legacy model keys opaque and rejects a business-error envelope", () => {
  const catalog = parseAutomationModelSceneCatalog(modelEnvelope([
    { sc_id: 1, intro: "门已打开", key: "event.lumi.sensor_magnet.aq2.open", value: "" },
  ]), "lumi.sensor_magnet.aq2");
  assert.equal(catalog.capabilities[0].kind, "event");
  assert.equal(catalog.capabilities[0].siid, undefined);
  assert.equal(catalog.capabilities[0].detail, "设备事件");
  assert.throws(
    () => parseAutomationModelSceneCatalog({ result: "error", code: 10000, retriable: true }, "unknown.model.test"),
    /XIAOMI_AUTOMATION_MODEL_CATALOG_UNAVAILABLE/,
  );
});

test("requests and paginates the private V3 catalog with the APK contract", async () => {
  const calls = [];
  const models = await listSceneTcaConfigV3(session, "home-1", "owner-1", ["device-1"], async (_session, path, data) => {
    calls.push({ path, data });
    if (calls.length === 1) return {
      result: {
        TCA_list: { model_TCA_list: [{ model: "vendor.sensor.one", dids: ["device-1"], value: { launch: [], action_list: [] } }] },
        has_more: true,
        max_home_id: "home-cursor",
        max_did: "did-cursor",
      },
    };
    return {
      TCA_list: { model_TCA_list: [{ model: "vendor.sensor.two", dids: ["device-1"], value: { launch: [], action_list: [] } }] },
      has_more: false,
    };
  });

  assert.equal(models.length, 2);
  assert.equal(calls[0].path, SCENE_TCA_CONFIG_V3_PATH);
  assert.deepEqual(calls[0].data, {
    app_version: 12,
    home_data_list: [{ home_id: "home-1", owner_uid: "owner-1", did: ["device-1"] }],
    query_type: 1,
    with_spec: 1,
    limit: 300,
    status_filter: 1,
  });
  assert.equal(calls[1].data.max_home_id, "home-cursor");
  assert.equal(calls[1].data.max_did, "did-cursor");
});

test("keeps private-catalog evidence when pagination cannot advance", async () => {
  const models = await listSceneTcaConfigV3(session, "home-1", "owner-1", ["device-1"], async () => ({
    result: {
      TCA_list: { model_TCA_list: [{ model: "vendor.sensor.one", dids: ["device-1"], value: { launch: [], action_list: [] } }] },
      has_more: true,
      max_did: "same",
    },
  }));
  assert.deepEqual(models.map(item => item.model), ["vendor.sensor.one"]);
});

test("projects V3 entries only onto explicitly listed same-model DIDs and applies blacklists", async () => {
  const publicModels = [];
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "device-one", homeId: "home-1", did: "did-one", model: "vendor.sensor.one", deviceName: "门磁一", room: "玄关" },
    { key: "device-two", homeId: "home-1", did: "did-two", model: "vendor.sensor.one", deviceName: "门磁二", room: "书房" },
    { key: "device-three", homeId: "home-1", did: "did-three", model: "vendor.sensor.three", deviceName: "传感器三", room: "客厅" },
    { key: "derived", homeId: "home-1", did: "did-one.s2", model: "vendor.sensor.one", deviceName: "派生端点", room: "玄关" },
    { key: "other-home", homeId: "home-2", did: "did-other", model: "vendor.sensor.one", deviceName: "其他家庭", room: "客厅" },
  ], {
    request: async () => ({
      result: {
        TCA_list: { model_TCA_list: [{
          model: "vendor.sensor.one",
          dids: ["did-one", "did-two", "did-other"],
          value: {
            launch: [
              { sc_id: "shared", name: "通用事件", key: "event.vendor.sensor.one.2.1", value: "", black_dids: [] },
              { sc_id: "blocked", name: "只适用于一号", key: "event.vendor.sensor.one.3.1", value: "", black_dids: ["did-two"] },
              { sc_id: "malformed", name: "无效黑名单", key: "event.vendor.sensor.one.4.1", value: "", black_dids: "did-two" },
              { sc_id: "malformed-array", name: "畸形数组黑名单", key: "event.vendor.sensor.one.5.1", value: "", black_dids: [{ did: "did-two" }] },
            ],
            action_list: [{ sa_id: "turn-on", name: "打开", command: "vendor.sensor.one.set_properties", value: "[{\"siid\":2,\"piid\":1,\"value\":true}]", black_dids: ["did-two"] }],
          },
        }] },
        has_more: false,
      },
    }),
    loadModelCatalog: async model => {
      publicModels.push(model);
      return parseAutomationModelSceneCatalog(modelEnvelope([
        { sc_id: 9, intro: "型号事件", key: `event.${model}.5.1`, value: "" },
      ]), model);
    },
  });

  assert.deepEqual(catalog.map(device => device.key), ["device-one", "device-two", "device-three"]);
  assert.deepEqual(catalog[0].capabilities.map(item => item.label), ["通用事件", "只适用于一号"]);
  assert.deepEqual(catalog[1].capabilities.map(item => item.label), ["通用事件"], "a lower-confidence fallback must not revive a blacklisted V3 entry");
  assert.equal(catalog[0].actions.length, 1);
  assert.equal(catalog[0].actions[0].value, undefined, "private action values stay server-side");
  assert.equal(catalog[1].actions.length, 0);
  assert.equal(catalog[2].discovery, "model-catalog");
  assert.deepEqual(publicModels, ["vendor.sensor.three"]);
  assert.doesNotMatch(JSON.stringify(catalog), /did-one|did-two|did-three|did-other|black_dids|set_properties|shared|blocked|malformed|turn-on/);
});

test("prefers the App V3 WHEN name over its generic intro", async () => {
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "controller", homeId: "home-1", did: "controller-did", model: "xiaomi.controller.oh4w", deviceName: "中控屏", room: "次卧" },
  ], {
    request: async () => ({
      result: {
        TCA_list: { model_TCA_list: [{
          model: "xiaomi.controller.oh4w",
          dids: ["controller-did"],
          value: { launch: [{
            sc_id: 89350,
            intro: "设备状态变化",
            name_when_v2: "单击右键（需转无线开关）",
            name_if_v2: "右键发生单击",
            key: "event.xiaomi.controller.oh4w.22.1",
            value: "",
          }], action_list: [] },
        }] },
        has_more: false,
      },
    }),
  });

  assert.equal(catalog[0].capabilities[0].label, "单击右键（需转无线开关）");
});

test("does not expose an opaque private scalar value in client catalog details", async () => {
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "sensor", homeId: "home-1", did: "sensor-did", model: "vendor.sensor.one", deviceName: "传感器", room: "客厅" },
  ], {
    request: async () => ({
      result: {
        TCA_list: { model_TCA_list: [{
          model: "vendor.sensor.one",
          dids: ["sensor-did"],
          value: { launch: [{ sc_id: "private", name: "状态变化", key: "prop.vendor.sensor.one.2.1", value: '"must-not-leak"' }], action_list: [] },
        }] },
        has_more: false,
      },
    }),
  });

  assert.equal(catalog[0].capabilities[0].detail, "设备属性");
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-leak|tca-v3:condition:private/);
});

test("unions blacklists for duplicate private catalog identities", async () => {
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "sensor", homeId: "home-1", did: "sensor-did", model: "vendor.sensor.one", deviceName: "传感器", room: "客厅" },
  ], {
    request: async () => ({
      result: {
        TCA_list: { model_TCA_list: [{
          model: "vendor.sensor.one",
          dids: ["sensor-did"],
          value: { launch: [
            { sc_id: "duplicate", name: "重复事件", key: "event.vendor.sensor.one.2.1", value: "", black_dids: [] },
            { sc_id: "duplicate", name: "重复事件", key: "event.vendor.sensor.one.2.1", value: "", black_dids: ["sensor-did"] },
          ], action_list: [] },
        }] },
        has_more: false,
      },
    }),
    loadModelCatalog: async () => { throw new Error("must not revive a blocked private entry"); },
  });

  assert.equal(catalog[0].discovery, "tca-v3");
  assert.deepEqual(catalog[0].capabilities, []);
});

test("keeps first-page instance evidence when a later private page fails", async () => {
  let requestCount = 0;
  let fallbackCount = 0;
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "sensor", homeId: "home-1", did: "sensor-did", model: "vendor.sensor.one", deviceName: "传感器", room: "客厅" },
  ], {
    request: async () => {
      requestCount += 1;
      if (requestCount > 1) throw new Error("later page unavailable");
      return {
        result: {
          TCA_list: { model_TCA_list: [{
            model: "vendor.sensor.one",
            dids: ["sensor-did"],
            value: { launch: [{ sc_id: "blocked", name: "已打开", key: "event.vendor.sensor.one.2.1", value: "", black_dids: ["sensor-did"] }], action_list: [] },
          }] },
          has_more: true,
          max_did: "next-page",
        },
      };
    },
    loadModelCatalog: async () => {
      fallbackCount += 1;
      return parseAutomationModelSceneCatalog(modelEnvelope([{ sc_id: "blocked", intro: "已打开", key: "event.vendor.sensor.one.2.1", value: "" }]), "vendor.sensor.one");
    },
  });

  assert.equal(requestCount, 2);
  assert.equal(fallbackCount, 0);
  assert.equal(catalog[0].discovery, "tca-v3");
  assert.deepEqual(catalog[0].capabilities, []);
});

test("isolates a failed public model fallback from sibling devices", async () => {
  const catalog = await discoverDeviceAutomationCatalog(session, "home-1", "owner-1", [
    { key: "good", homeId: "home-1", did: "good-did", model: "vendor.good.one", deviceName: "可用设备", room: "客厅" },
    { key: "bad", homeId: "home-1", did: "bad-did", model: "vendor.bad.one", deviceName: "未知设备", room: "次卧" },
  ], {
    request: async () => { throw new Error("private unavailable"); },
    loadModelCatalog: async model => {
      if (model === "vendor.bad.one") throw new Error("model unavailable");
      return parseAutomationModelSceneCatalog(modelEnvelope([{ sc_id: 1, intro: "已打开", key: `prop.${model}.2.1`, value: "true" }]), model);
    },
  });
  assert.equal(catalog[0].discovery, "model-catalog");
  assert.equal(catalog[0].capabilities.length, 1);
  assert.equal(catalog[1].discovery, "unavailable");
  assert.equal(catalog[1].capabilities.length, 0);
});

test("accepts a direct V3 result object", () => {
  const page = parseSceneTcaConfigV3Page({
    TCA_list: { model_TCA_list: [{ model: "vendor.direct.one", dids: [], value: { launch: [], action_list: [] } }] },
    has_more: false,
  });
  assert.equal(page.models[0].model, "vendor.direct.one");
});
