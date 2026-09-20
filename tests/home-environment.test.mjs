import test from "node:test";
import assert from "node:assert/strict";
import { buildEnvironmentSnapshot, collectHomeEnvironment, matchEnvironmentMetric, planEnvironmentReads } from "../lib/home-environment.ts";
import { normalizeMiotSpecification } from "../lib/miot-spec.ts";

const CAPTURED_AT = "2026-09-20T08:00:00.000Z";

test("metric matching is conservative: exact semantic names only", () => {
  assert.equal(matchEnvironmentMetric("temperature"), "temperature");
  assert.equal(matchEnvironmentMetric("relative-humidity"), "humidity");
  assert.equal(matchEnvironmentMetric("co2-density"), "co2");
  assert.equal(matchEnvironmentMetric("formaldehyde"), "formaldehyde");
  assert.equal(matchEnvironmentMetric("pm2.5-density"), "pm25");
  assert.equal(matchEnvironmentMetric("battery-level"), "battery");
  // Targets, modes and unrelated properties never match.
  assert.equal(matchEnvironmentMetric("target-temperature"), null);
  assert.equal(matchEnvironmentMetric("target-humidity"), null);
  assert.equal(matchEnvironmentMetric("mode"), null);
  assert.equal(matchEnvironmentMetric("on"), null);
  assert.equal(matchEnvironmentMetric("temperature-range"), null);
});

test("formaldehyde values are normalized to mg/m³ from declared ppb or µg/m³", () => {
  // A device declaring ppb: 100 ppb ≈ 0.125 mg/m³, never 100 "mg/m³".
  const ppb = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned: [{ metric: "formaldehyde", did: "d", siid: 2, piid: 1, sourceLabel: "检测仪", roomName: null, declaredUnit: "ppb" }],
    values: [{ metric: "formaldehyde", sourceLabel: "检测仪", roomName: null, value: 100, declaredUnit: "ppb" }],
    specificationFailureCount: 0,
    failedBatchCount: 0,
  });
  assert.equal(ppb.groups[0].unit, "mg/m³");
  assert.ok(Math.abs(ppb.groups[0].latest.value - 0.1247) < 1e-9, `got ${ppb.groups[0].latest.value}`);
  // A device declaring µg/m³: 80 µg/m³ = 0.08 mg/m³.
  const micro = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned: [{ metric: "formaldehyde", did: "d", siid: 2, piid: 1, sourceLabel: "检测仪", roomName: null, declaredUnit: "μg/m3" }],
    values: [{ metric: "formaldehyde", sourceLabel: "检测仪", roomName: null, value: 80, declaredUnit: "μg/m3" }],
    specificationFailureCount: 0,
    failedBatchCount: 0,
  });
  assert.ok(Math.abs(micro.groups[0].latest.value - 0.08) < 1e-9, `got ${micro.groups[0].latest.value}`);
  // mg/m³ passes through unchanged; undeclared units stay raw.
  const passthrough = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned: [{ metric: "formaldehyde", did: "d", siid: 2, piid: 1, sourceLabel: "检测仪", roomName: null, declaredUnit: "mg/m3" }],
    values: [{ metric: "formaldehyde", sourceLabel: "检测仪", roomName: null, value: 0.08, declaredUnit: "mg/m3" }],
    specificationFailureCount: 0,
    failedBatchCount: 0,
  });
  assert.equal(passthrough.groups[0].latest.value, 0.08);
});

const spec = normalizeMiotSpecification("test.sensor.demo", "urn:test:sensor:demo", {
  type: "urn:test:sensor:demo",
  services: [
    {
      iid: 2,
      type: "urn:test:service:environment-sensor",
      properties: [
        { iid: 1, type: "urn:test:property:temperature", format: "float", access: ["read"], unit: "celsius" },
        { iid: 2, type: "urn:test:property:relative-humidity", format: "uint8", access: ["read"], unit: "percentage" },
        { iid: 3, type: "urn:test:property:co2-density", format: "uint16", access: ["read"], unit: "ppm" },
        { iid: 4, type: "urn:test:property:pm2-density", format: "uint16", access: ["read"], unit: "μg/m3" },
      ],
    },
    {
      iid: 3,
      type: "urn:test:service:air-conditioner",
      properties: [
        // Writable target must never be reported as a reading.
        { iid: 4, type: "urn:test:property:target-temperature", format: "float", access: ["read", "write"], unit: "celsius" },
      ],
    },
  ],
});

const DEVICE = { did: "physical-did-1", model: "test.sensor.demo", name: "客厅温湿度计", roomName: "客厅", isOnline: true, homeId: "test-home" };

test("planning picks one readable sensor property per metric and skips writable targets", () => {
  const plans = planEnvironmentReads(DEVICE, spec.groups);
  const metrics = plans.map(plan => plan.metric);
  assert.deepEqual(metrics, ["temperature", "humidity", "co2", "pm25"]);
  for (const plan of plans) assert.equal(plan.sourceLabel, "客厅温湿度计");
  assert.deepEqual(plans[0], { metric: "temperature", did: "physical-did-1", siid: 2, piid: 1, sourceLabel: "客厅温湿度计", roomName: "客厅", declaredUnit: "celsius" });
});

test("planning ignores devices without a did", () => {
  assert.deepEqual(planEnvironmentReads({ model: "test.sensor.demo" }, spec.groups), []);
});

test("snapshot assembly is sanitized, ordered, and honest about partial data", () => {
  const planned = planEnvironmentReads(DEVICE, spec.groups);
  const snapshot = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned,
    values: [
      { metric: "temperature", sourceLabel: "客厅温湿度计", roomName: "客厅", value: 25.5 },
      { metric: "co2", sourceLabel: "客厅温湿度计", roomName: "客厅", value: 640 },
    ],
    specificationFailureCount: 0,
    failedBatchCount: 0,
  });
  assert.equal(snapshot.completeness, "partial");
  assert.deepEqual(snapshot.groups.map(group => group.metric), ["temperature", "co2"]);
  assert.equal(snapshot.groups[0].latest.value, 25.5);
  assert.equal(snapshot.groups[0].latest.capturedAt, CAPTURED_AT);
  assert.equal(snapshot.warnings.length, 0);
  const raw = JSON.stringify(snapshot);
  for (const forbidden of ["physical-did-1", "test.sensor.demo", "siid", "piid"]) assert.ok(!raw.includes(forbidden), raw);
});

test("snapshot reports empty and partial completeness without fabricating values", () => {
  const empty = buildEnvironmentSnapshot({ capturedAt: CAPTURED_AT, planned: [], values: [], specificationFailureCount: 0, failedBatchCount: 0 });
  assert.equal(empty.completeness, "empty");
  assert.deepEqual(empty.groups, []);
  const failed = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned: planEnvironmentReads(DEVICE, spec.groups),
    values: [],
    specificationFailureCount: 1,
    failedBatchCount: 0,
  });
  assert.equal(failed.completeness, "empty");
  assert.ok(failed.warnings[0].includes("规格"));
});

test("multi-device readings stay per-device and mark the newest as headline", () => {
  const snapshot = buildEnvironmentSnapshot({
    capturedAt: CAPTURED_AT,
    planned: [{ metric: "temperature", did: "a", siid: 2, piid: 1, sourceLabel: "客厅", roomName: "客厅" }, { metric: "temperature", did: "b", siid: 2, piid: 1, sourceLabel: "主卧", roomName: "主卧" }],
    values: [
      { metric: "temperature", sourceLabel: "客厅", roomName: "客厅", value: 25 },
      { metric: "temperature", sourceLabel: "主卧", roomName: "主卧", value: 22 },
    ],
    specificationFailureCount: 0,
    failedBatchCount: 0,
  });
  assert.equal(snapshot.completeness, "complete");
  assert.equal(snapshot.groups.length, 1);
  assert.equal(snapshot.groups[0].readings.length, 2);
  assert.equal(snapshot.groups[0].latest.sourceLabel, "客厅");
});

test("collector keeps successful readings and reports per-item failures as partial", async () => {
  const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
  const snapshot = await collectHomeEnvironment(session, "test-home", {
    listDevices: async () => ({
      homes: [{ id: "test-home", name: "我的家" }],
      devices: [DEVICE],
      controlObjectResults: [],
      completeness: "complete",
      warnings: [],
      requestAttemptCount: 1,
      successfulHomeCount: 1,
      failedHomeCount: 0,
    }),
    getCapabilities: async () => spec,
    readProperties: async (_session, params) => [
      { did: params[0].did, siid: params[0].siid, piid: params[0].piid, code: 0, value: 25.5 },
      // Device rejects the humidity property; other readings stay missing.
      { did: params[1].did, siid: params[1].siid, piid: params[1].piid, code: -701007, value: null },
    ],
  });
  assert.equal(snapshot.completeness, "partial");
  assert.equal(snapshot.groups[0].metric, "temperature");
  assert.equal(snapshot.groups[0].latest.value, 25.5);
  const raw = JSON.stringify(snapshot);
  assert.ok(!raw.includes("fake-token") && !raw.includes("fake-security"));
});

test("collector treats a failed batch as missing readings, never as zero values", async () => {
  const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
  const snapshot = await collectHomeEnvironment(session, "test-home", {
    listDevices: async () => ({
      homes: [{ id: "test-home", name: "我的家" }],
      devices: [DEVICE],
      controlObjectResults: [],
      completeness: "complete",
      warnings: [],
      requestAttemptCount: 1,
      successfulHomeCount: 1,
      failedHomeCount: 0,
    }),
    getCapabilities: async () => spec,
    readProperties: async () => { throw new Error("XIAOMI_CLOUD_TIMEOUT"); },
  });
  assert.deepEqual(snapshot.groups, []);
  assert.equal(snapshot.completeness, "empty");
  assert.ok(snapshot.warnings.some(warning => warning.includes("读数")));
});

test("collector rejects homes outside the account instead of returning data", async () => {
  const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
  await assert.rejects(
    collectHomeEnvironment(session, "other-home", {
      listDevices: async () => ({ homes: [{ id: "test-home", name: "我的家" }], devices: [], controlObjectResults: [], completeness: "complete", warnings: [], requestAttemptCount: 1, successfulHomeCount: 1, failedHomeCount: 0 }),
      getCapabilities: async () => spec,
      readProperties: async () => [],
    }),
    /AI_HOME_FORBIDDEN/,
  );
});
