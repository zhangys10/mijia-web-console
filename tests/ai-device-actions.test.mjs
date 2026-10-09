import assert from "node:assert/strict";
import test from "node:test";

import { matchDeviceActionIntent } from "../lib/ai/tools/device-action-intent.ts";
import { loadDeviceOperationCatalog, validateDeviceOperationValue } from "../lib/ai/tools/device-operation-catalog.ts";
import { createLocalProdDeviceGrant } from "../lib/ai/tools/local-prod-scene-grant.ts";

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

test("local production token generation binds the exact device operation", async () => {
  const grant = await createLocalProdDeviceGrant({
    message: "打开客厅空调",
    requestId: "req_local_device_0001",
    idempotencyKey: "local-device-idempotency-0001",
    devices: [device()],
    now: 1_000,
  });

  assert.equal(grant.kind, "device_property");
  assert.equal(grant.deviceId, device().deviceId);
  assert.equal(grant.operationId, power.operationId);
  assert.equal(grant.value, true);
  assert.equal(grant.expiresAt, 61_000);
  assert.match(grant.messageHash, /^[a-f0-9]{64}$/);
});

test("derived switch endpoints use the physical DID and only their mapped service", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    type: "urn:miot-spec-v2:device:switch:0000A003:test-derived-endpoint:1",
    services: [
      { iid: 2, type: "urn:miot-spec-v2:service:switch:0000780C:1", properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:1", format: "bool", access: ["read", "write"] },
      ] },
      { iid: 15, type: "urn:miot-spec-v2:service:switch:0000780C:1", properties: [
        { iid: 1, type: "urn:miot-spec-v2:property:on:00000006:1", format: "bool", access: ["read", "write"] },
      ] },
    ],
  });
  try {
    const discovery = {
      homes: [{ id: "home-a", name: "家" }],
      devices: [{ did: "physical-did.s15", name: "客厅灯带", model: "test.switch.derived",
        urn: "urn:miot-spec-v2:device:switch:0000A003:test-derived-endpoint:1",
        homeId: "home-a", roomName: "客厅", online: true }],
      controlObjectResults: [], completeness: "complete", warnings: [], successfulHomeCount: 1,
      failedHomeCount: 0, requestAttemptCount: 1,
    };
    const catalog = await loadDeviceOperationCatalog(discovery, "home-a", ["physical-did.s15"]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].did, "physical-did");
    assert.deepEqual(catalog[0].operations.map(item => [item.siid, item.piid]), [[15, 1]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
