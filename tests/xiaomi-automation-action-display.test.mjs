import assert from "node:assert/strict";
import test from "node:test";

import { automationPropertyDisplay } from "../lib/xiaomi-automation-action-display.ts";

const curtainAction = {
  clientId: "source-0",
  kind: "set-properties",
  did: "curtain-1",
  deviceName: "主卧纱帘",
  model: "vendor.curtain.v1",
  label: "关闭纱帘",
  properties: [{ siid: 2, piid: 1, value: 1 }],
};

test("uses the exact device capability label and value description instead of a MIoT address", () => {
  const catalog = [
    { did: "other-device", siid: 2, piid: 1, serviceLabel: "灯光", label: "开关", format: "bool" },
    { did: "curtain-1", siid: 2, piid: 1, serviceLabel: "窗帘", label: "电机控制", format: "uint8", editable: false, choices: [{ value: 1, label: "暂停" }] },
  ];
  const display = automationPropertyDisplay(curtainAction, curtainAction.properties[0], catalog);
  assert.equal(display.label, "窗帘 · 电机控制");
  assert.equal(display.valueLabel, "暂停");
  assert.equal(display.known, true);
  assert.equal(display.descriptor.editable, false);
});

test("falls back to a real action description, never a bare siid.piid label", () => {
  const display = automationPropertyDisplay(curtainAction, curtainAction.properties[0], []);
  assert.equal(display.label, "关闭纱帘");
  assert.equal(display.valueLabel, "1");
  assert.equal(display.known, false);

  const ambiguousAction = {
    ...curtainAction,
    label: "",
    properties: [
      { siid: 2, piid: 1, value: 1 },
      { siid: 2, piid: 2, value: 50 },
    ],
  };
  assert.equal(automationPropertyDisplay(ambiguousAction, ambiguousAction.properties[0], []).label, "未识别属性");
});

test("keeps a supplied property description when catalog metadata is unavailable", () => {
  const property = { siid: 2, piid: 1, value: false, label: "继电器开关" };
  const display = automationPropertyDisplay({ ...curtainAction, properties: [property] }, property, []);
  assert.equal(display.label, "继电器开关");
  assert.equal(display.valueLabel, "关闭");
});
