import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { miotPropertyAccess, splitDeviceCapabilityGroup } from "../lib/device-capabilities.ts";
import { listSceneWritableProperties } from "../lib/xiaomi-scene-properties.ts";

const property = (key, readable, writable, name = key) => ({
  key,
  name,
  label: name,
  siid: 2,
  piid: Number(key.split(".")[1]),
  format: "bool",
  readable,
  writable,
  notify: false,
});

test("separates property access from executable actions and events", () => {
  const group = {
    key: "2",
    name: "light",
    label: "灯光",
    siid: 2,
    properties: [
      property("2.1", true, false, "status"),
      property("2.2", true, true, "on"),
      property("2.3", false, true, "motor-control"),
      property("2.4", false, false, "internal"),
    ],
    actions: [{ key: "2.a1", name: "toggle", label: "切换", siid: 2, aiid: 1, inputs: [2, 99] }],
    events: [{ key: "2.e1", name: "changed", label: "变化", siid: 2, eiid: 1, arguments: [] }],
  };

  const sections = splitDeviceCapabilityGroup(group);
  assert.deepEqual(sections.readOnlyProperties.map(item => item.key), ["2.1"]);
  assert.deepEqual(sections.readWriteProperties.map(item => item.key), ["2.2"]);
  assert.deepEqual(sections.writeOnlyProperties.map(item => item.key), ["2.3"]);
  assert.deepEqual(sections.unavailableProperties.map(item => item.key), ["2.4"]);
  assert.deepEqual(sections.executableActions.map(item => item.key), ["2.a1"]);
  assert.deepEqual(sections.executableActions[0].inputProperties.map(item => item.key), ["2.2"]);
  assert.deepEqual(sections.executableActions[0].unresolvedInputPiids, [99]);
  assert.deepEqual(sections.events.map(item => item.key), ["2.e1"]);
});

test("scene properties are a safe subset of read-write properties and never include actions", () => {
  const group = {
    key: "2",
    name: "light",
    label: "灯光",
    siid: 2,
    properties: [
      property("2.1", true, false, "on"),
      property("2.2", true, true, "on"),
      property("2.3", false, true, "on"),
      property("2.4", true, true, "factory-reset"),
    ],
    actions: [{ key: "2.a1", name: "toggle", label: "切换", siid: 2, aiid: 1, inputs: [] }],
    events: [],
  };

  assert.equal(miotPropertyAccess(group.properties[0]), "read-only");
  assert.equal(miotPropertyAccess(group.properties[1]), "read-write");
  assert.equal(miotPropertyAccess(group.properties[2]), "write-only");
  assert.deepEqual(listSceneWritableProperties(group).map(item => item.key), ["2.2"]);
});

test("device and scene pages consume separate capability projections", async () => {
  const [devicePage, scenePage] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/scene-editor.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(devicePage, /splitDeviceCapabilityGroup\(group\)/);
  assert.match(devicePage, />可写属性</);
  assert.match(devicePage, />可执行 Action</);
  assert.match(devicePage, />只读属性</);
  assert.match(scenePage, /listSceneWritableProperties\(group\)/);
  assert.match(scenePage, /立即执行 Action、只读属性和仅写属性不会在此交叉调用/);
});
