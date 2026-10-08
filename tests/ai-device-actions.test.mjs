import assert from "node:assert/strict";
import test from "node:test";

import { matchDeviceActionIntent } from "../lib/ai/tools/device-action-intent.ts";
import { validateDeviceOperationValue } from "../lib/ai/tools/device-operation-catalog.ts";

const operation = {
  operationId: `op_${"a".repeat(24)}`,
  revision: `rev_${"b".repeat(24)}`,
  name: "target-temperature",
  label: "目标温度",
  valueType: "number",
  unit: "celsius",
  range: { min: 16, max: 30, step: 1 },
  siid: 2,
  piid: 3,
};

const power = {
  operationId: `op_${"c".repeat(24)}`,
  revision: `rev_${"d".repeat(24)}`,
  name: "on",
  label: "开关",
  valueType: "boolean",
  siid: 2,
  piid: 1,
};

function device(overrides = {}) {
  return {
    deviceId: `entity_${"e".repeat(32)}`,
    name: "空调",
    room: "客厅",
    kind: "air-conditioner",
    online: true,
    did: "private-did",
    model: "fake.air-conditioner.v1",
    operations: [power, operation],
    ...overrides,
  };
}

test("device intent accepts one exact current safe-property command", () => {
  const selected = matchDeviceActionIntent("设置客厅空调目标温度为24度", [device()]);
  assert.equal(selected?.device.deviceId, `entity_${"e".repeat(32)}`);
  assert.equal(selected?.operation.operationId, operation.operationId);
  assert.equal(selected?.value, 24);
  assert.equal(matchDeviceActionIntent("打开空调", [device()])?.value, true);
});

test("device intent rejects ambiguity, conditions, questions, and out-of-range values", () => {
  assert.equal(matchDeviceActionIntent("如果热就打开空调", [device()]), null);
  assert.equal(matchDeviceActionIntent("能否打开空调？", [device()]), null);
  assert.equal(matchDeviceActionIntent("设置客厅空调目标温度为40度", [device()]), null);
  assert.equal(matchDeviceActionIntent("打开空调", [device(), device({ deviceId: `entity_${"f".repeat(32)}`, room: "卧室" })]), null);
});

test("safe values honor declared type, choices, range, and step", () => {
  assert.equal(validateDeviceOperationValue(operation, 24), true);
  assert.equal(validateDeviceOperationValue(operation, 24.5), false);
  assert.equal(validateDeviceOperationValue(power, false), true);
  assert.equal(validateDeviceOperationValue(power, 0), false);
});
