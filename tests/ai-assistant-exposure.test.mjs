import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sealWithSecret } from "../lib/xiaomi-cloud.ts";
import { onRequest as exposureHandler } from "../lib/ai/api/exposure.ts";
import {
  assistantExposureProjection,
  listObservedAssistantExposureInventory,
  observedExposureInventory,
  readAssistantExposure,
  updateAssistantExposure,
} from "../lib/ai/tools/assistant-exposure.ts";
import { filterEnvironmentByExposure, filterDeviceStatus, getAssistantCapabilitiesV1, invokeAssistantToolV1 } from "../lib/ai/tools/assistant-v1-service.ts";
import { sealAutomationToken } from "../lib/ai/security/automation-token.ts";
import { createLocalAssistantExposureStore } from "../lib/ai/tools/local-assistant-exposure-store.ts";

test("exposure API treats homeId as routing context, not an exposure setting", async () => {
  const env = {
    XIAOMI_SESSION_SECRET: "ai-exposure-route-session-secret-at-least-32-characters",
    AI_PRINCIPAL_SECRET: "ai-exposure-route-principal-secret-at-least-32-characters",
  };
  const session = {
    userId: "exposure-route-user", cUserId: "exposure-route-c-user", ssecurity: "mock-ssecurity",
    serviceToken: "mock-service-token", region: "cn", deviceId: "mock-device", userAgent: "mock-agent", createdAt: Date.now(),
  };
  const cookie = await sealWithSecret(session, env.XIAOMI_SESSION_SECRET);
  const stored = [];
  const response = await exposureHandler({
    request: new Request("http://localhost/api/ai/exposure", {
      method: "PUT",
      headers: { Cookie: `xiaomi_session=${encodeURIComponent(cookie)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ homeId: "home-route-test", enabled: true, roomMetrics: {}, deviceRefs: [] }),
    }),
    env,
  }, {
    homes: async () => [{ id: "home-route-test" }],
    devices: async () => ({ homes: [{ id: "home-route-test" }], devices: [] }),
    environment: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", groups: [], warnings: [] }),
    deviceStatus: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", poweredOn: 0, rooms: [], warnings: [] }),
    store: {
      async get() { return null; },
      async setJSON(key, value) { stored.push({ key, value }); },
    },
  });

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(stored.length, 2);
  assert.equal(stored.some(({ value }) => value.homeId), false);
});

async function entityRef(homeId, did) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${homeId}:${did}`));
  return `entity_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}

async function sceneRef(homeId, sceneId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${homeId}:${sceneId}`));
  return `scene_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 16)}`;
}

test("home assistant exposure defaults to deny and uses a strongly consistent read", async () => {
  let observed;
  const exposure = await readAssistantExposure("home-id", {
    async get(key, options) { observed = { key, options }; return null; },
    async setJSON() {},
  });

  assert.equal(exposure.enabled, false);
  assert.deepEqual(exposure.roomMetrics, {});
  assert.deepEqual(exposure.deviceDids, []);
  assert.deepEqual(observed.options, { type: "json", consistency: "strong" });
  assert.equal(observed.key.includes("home-id"), false);
  assert.deepEqual(assistantExposureProjection(exposure, { rooms: [], metrics: [], devices: [] }).capabilities, []);
});

test("settings inventory offers only observed room metrics and reported device statuses", () => {
  const base = {
    rooms: ["客厅", "卧室"], metrics: ["temperature", "humidity"],
    devices: [
      { ref: "entity_light", name: "客厅灯", room: "客厅", kind: "light", enabled: false, eligible: true },
      { ref: "entity_sensor", name: "卧室传感器", room: "卧室", kind: "sensor", enabled: false, eligible: true },
    ],
  };
  const inventory = observedExposureInventory(base, {
    capturedAt: "2026-09-24T00:00:00Z", completeness: "partial", warnings: [],
    groups: [{ metric: "temperature", label: "温度", unit: "°C", latest: null, readings: [
      { value: 23, unit: "°C", sourceLabel: "客厅传感器", roomName: "客厅", capturedAt: "2026-09-24T00:00:00Z", freshness: "fresh" },
    ] }],
  }, {
    capturedAt: "2026-09-24T00:00:00Z", completeness: "partial", poweredOn: 1, warnings: [],
    rooms: [{ room: "客厅", items: [{ name: "客厅灯", kind: "light", state: "on", online: true }] }],
  });
  assert.deepEqual(inventory.roomMetrics, { "客厅": ["temperature"] });
  assert.deepEqual(inventory.metrics, ["temperature"]);
  assert.deepEqual(inventory.devices.map(item => item.ref), ["entity_light"]);
});

test("exposure storage failures stay distinguishable from generic assistant failures", async () => {
  await assert.rejects(
    readAssistantExposure("home-id", {
      async get() { throw new Error("storage credentials are not configured"); },
      async setJSON() {},
    }),
    error => error.code === "AI_EXPOSURE_STORE_UNAVAILABLE" && error.status === 503,
  );
});

test("home exposure update resolves only current-home device references and stores no raw IDs in the UI inventory", async () => {
  const homeId = "home-id";
  const did = "light.did.private";
  const selectedRef = await entityRef(homeId, did);
  let stored;
  const auditRecords = [];
  const store = {
    async get(_key, options) { assert.equal(options.consistency, "strong"); return stored ?? null; },
    async setJSON(key, value, options) {
      assert.equal(key.includes(homeId), false);
      if (options?.onlyIfNew) auditRecords.push({ key, value, options });
      else stored = value;
    },
  };
  const homes = async () => [{ id: homeId, name: "我的家" }];
  const devices = async () => ({
    homes: [{ id: homeId, name: "我的家" }],
    devices: [{ homeId, did, name: "客厅灯", roomName: "客厅", model: "yeelink.light.test" }],
  });
  const environment = async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "complete", warnings: [], groups: [{
    metric: "temperature", label: "温度", unit: "°C", latest: null,
    readings: [{ value: 23, unit: "°C", sourceLabel: "客厅传感器", roomName: "客厅", capturedAt: "2026-09-24T00:00:00Z", freshness: "fresh" }],
  }] });
  const deviceStatus = async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "complete", poweredOn: 1, warnings: [], rooms: [
    { room: "客厅", items: [{ name: "客厅灯", kind: "light", state: "on", online: true }] },
  ] });

  const result = await updateAssistantExposure({ userId: "test" }, homeId, {
    enabled: true,
    roomMetrics: { "客厅": ["temperature"] },
    deviceRefs: [selectedRef],
  }, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { store, homes, devices, environment, deviceStatus });

  assert.equal(result.exposure.enabled, true);
  assert.equal(result.exposure.deviceDids[0], did);
  assert.equal(result.inventory.devices[0].enabled, true);
  assert.equal(JSON.stringify(result.inventory).includes(did), false);
  const projection = assistantExposureProjection(result.exposure, result.inventory);
  assert.deepEqual(projection.rooms, ["客厅"]);
  assert.deepEqual(projection.measurementTypes, ["temperature"]);
  assert.deepEqual(projection.deviceKinds, [result.inventory.devices[0].kind]);
  assert.equal(projection.capabilities.length, 2);
  assert.equal(auditRecords.length, 1);
  assert.equal(auditRecords[0].options.onlyIfNew, true);
  assert.equal(auditRecords[0].value.actorPrincipalId, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(auditRecords[0].value.previousRevision, "exp_default_deny");
  assert.equal(auditRecords[0].value.revision, result.exposure.revision);
  assert.equal(auditRecords[0].value.exposedDeviceCount, 1);
  assert.equal(JSON.stringify(auditRecords[0]).includes(did), false);
  await assert.rejects(updateAssistantExposure({ userId: "test" }, homeId, {
    enabled: true, roomMetrics: { "客厅": ["humidity"] }, deviceRefs: [selectedRef],
  }, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { store, homes, devices, environment, deviceStatus }),
  error => error.code === "AI_INVALID_REQUEST");
  await assert.rejects(updateAssistantExposure({ userId: "test" }, homeId, {
    enabled: true, roomMetrics: {}, deviceRefs: [selectedRef],
  }, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    store, homes, devices, environment,
    deviceStatus: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", poweredOn: 0, rooms: [], warnings: [] }),
  }), error => error.code === "AI_INVALID_REQUEST");
});

test("observed read inventory preserves scene approvals through settings save", async () => {
  const homeId = "test-home";
  const sceneId = "private-scene-id";
  const revision = `rev_${"a".repeat(24)}`;
  let currentSceneRevision = revision;
  const ref = await sceneRef(homeId, sceneId);
  let stored = null;
  const dependencies = {
    store: {
      async get() { return stored; },
      async setJSON(key, value, options) { if (!options?.onlyIfNew) stored = value; },
    },
    homes: async () => [{ id: homeId, name: "测试家庭" }],
    devices: async () => ({ homes: [{ id: homeId }], devices: [] }),
    environment: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", groups: [], warnings: [] }),
    deviceStatus: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", poweredOn: 0, rooms: [], warnings: [] }),
    sceneCatalog: async () => [{ sceneId, homeId, name: "客厅灯", actionCount: 1, revision: currentSceneRevision, actionSummaries: [] }],
  };
  const session = { userId: "fake-user" };
  const principalId = `usr_${"a".repeat(43)}`;
  const updated = await updateAssistantExposure(session, homeId, {
    enabled: true, sceneActionsEnabled: true, roomMetrics: {}, deviceRefs: [], sceneRefs: [ref],
  }, principalId, dependencies);
  assert.equal(updated.exposure.sceneApprovals[sceneId], revision);
  assert.equal(updated.inventory.scenes[0].approvalStatus, "approved");
  assert.equal(updated.inventory.scenes[0].enabled, true);
  const observed = await listObservedAssistantExposureInventory(session, homeId, updated.exposure, dependencies);
  assert.equal(observed.scenes[0].ref, ref);
  assert.equal(observed.scenes[0].approvalStatus, "approved");
  assert.equal(observed.scenes[0].enabled, true);
  assert.equal(JSON.stringify(observed).includes(sceneId), false);

  currentSceneRevision = `rev_${"b".repeat(24)}`;
  const changed = await listObservedAssistantExposureInventory(session, homeId, updated.exposure, dependencies);
  assert.equal(changed.scenes[0].approvalStatus, "changed");
  assert.equal(changed.scenes[0].enabled, false, "an edited scene must lose its previous approval");

  const bypassInput = { enabled: true, sceneActionsEnabled: true, sceneApprovalBypass: true, roomMetrics: {}, deviceRefs: [], sceneRefs: [] };
  await assert.rejects(updateAssistantExposure(session, homeId, bypassInput, principalId, dependencies), error => error.code === "AI_INVALID_REQUEST");
  const bypassed = await updateAssistantExposure(session, homeId, { ...bypassInput, confirmSceneApprovalBypass: true }, principalId, dependencies);
  assert.equal(bypassed.exposure.sceneApprovalBypass, true);
  assert.deepEqual(bypassed.exposure.sceneApprovals, {});
  assert.equal(bypassed.inventory.scenes[0].enabled, true, "confirmed bypass exposes scenes without individual approval");
  const restored = await updateAssistantExposure(session, homeId, { ...bypassInput, sceneApprovalBypass: false }, principalId, dependencies);
  assert.equal(restored.inventory.scenes[0].enabled, false, "turning bypass off restores the individual approval gate");
});

test("home exposure update rejects an entity reference that is not in the selected home", async () => {
  const store = { async get() { return null; }, async setJSON() { assert.fail("must not persist invalid input"); } };
  await assert.rejects(updateAssistantExposure({ userId: "test" }, "home-id", {
    enabled: true,
    roomMetrics: {},
    deviceRefs: ["entity_00000000000000000000000000000000"],
  }, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    store,
    homes: async () => [{ id: "home-id", name: "我的家" }],
    devices: async () => ({ homes: [{ id: "home-id", name: "我的家" }], devices: [] }),
    environment: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", groups: [], warnings: [] }),
    deviceStatus: async () => ({ capturedAt: "2026-09-24T00:00:00Z", completeness: "empty", poweredOn: 0, rooms: [], warnings: [] }),
  }), error => error.code === "AI_INVALID_REQUEST");
});

test("per-room metric rules prevent a filter from exposing a metric granted only in another room", () => {
  const snapshot = {
    capturedAt: "2026-09-23T00:00:00Z",
    completeness: "complete",
    groups: [
      { metric: "temperature", label: "温度", unit: "°C", latest: { value: 25, unit: "°C", sourceLabel: "客厅", roomName: "客厅" }, readings: [{ value: 25, unit: "°C", sourceLabel: "客厅", roomName: "客厅" }] },
      { metric: "humidity", label: "湿度", unit: "%", latest: { value: 50, unit: "%", sourceLabel: "卧室", roomName: "卧室" }, readings: [{ value: 50, unit: "%", sourceLabel: "卧室", roomName: "卧室" }] },
    ],
    warnings: [],
  };
  const filtered = filterEnvironmentByExposure(snapshot, { "卧室": ["humidity"] });
  assert.equal(filtered.groups.length, 1);
  assert.equal(filtered.groups[0].metric, "humidity");
  assert.equal(filtered.groups[0].latest.value, 50);
});

test("assistant environment response stays within the Python reading and body limits", () => {
  const capturedAt = "2026-09-23T00:00:00Z";
  const readings = Array.from({ length: 25 }, (_, index) => ({
    value: index,
    unit: "°C",
    sourceLabel: `测试传感器${"甲".repeat(170)}${index}`,
    roomName: "客厅",
    capturedAt,
    freshness: "fresh",
  }));
  const metrics = ["temperature", "humidity", "co2", "formaldehyde", "pm25", "pm10", "tvoc", "pressure", "battery"];
  const snapshot = {
    capturedAt,
    completeness: "complete",
    groups: metrics.map(metric => ({ metric, label: "读数", unit: "°C", latest: readings[0], readings })),
    warnings: [],
  };
  let truncation;
  const filtered = filterEnvironmentByExposure(snapshot, { "客厅": metrics }, details => { truncation = details; });
  assert.deepEqual(truncation, { readingLimitReached: true, responseSizeLimitReached: false });
  assert.equal(filtered.groups.length, metrics.length);
  assert.ok(filtered.groups.every(group => group.readings.length <= 20));
  assert.equal(filtered.groups[0].latest.value, 0);
  assert.equal(filtered.completeness, "partial");
  assert.match(filtered.warnings[0], /未展示/);
  assert.ok(new TextEncoder().encode(JSON.stringify(filtered)).byteLength <= 60_000);
});

test("assistant tool reuses one authenticated device discovery for inventory and readings", async () => {
  const env = {
    APP_ENV: "test",
    AI_ENVIRONMENT: "production",
    AI_AUTOMATION_TOKEN_SECRET: "test-automation-secret-not-real-12345",
    AI_PRINCIPAL_SECRET: "test-principal-secret-not-real-123456789",
  };
  const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
  const token = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    audience: "mijia-agent",
    principalId: "forged-principal-ignored",
    xiaomiSession: session,
    region: "cn",
    homeId: "test-home",
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
  }, { secret: env.AI_AUTOMATION_TOKEN_SECRET, env: env.APP_ENV });
  const discovery = {
    homes: [{ id: "test-home", name: "测试家庭" }],
    devices: [
      { homeId: "test-home", did: "fake-device-1", name: "测试传感器", roomName: "客厅", model: "sensor.test" },
      { homeId: "test-home", did: "fake-device-2", name: "测试传感器", roomName: "卧室", model: "sensor.test" },
    ],
  };
  let discoveryCalls = 0;
  let environmentCalls = 0;
  const manifest = await getAssistantCapabilitiesV1({ requestId: "req_test_manifest" }, token, env, {
    discovery: async () => discovery,
    exposure: async () => ({ version: 1, enabled: true, roomMetrics: { "客厅": ["temperature"], "卧室": ["humidity"] }, deviceDids: [], updatedAt: null, revision: "exp_test" }),
  });
  assert.deepEqual(manifest.projection.roomMetrics, { "客厅": ["temperature"], "卧室": ["humidity"] });
  assert.deepEqual(manifest.projection.roomDeviceKinds, {});
  const result = await invokeAssistantToolV1({ requestId: "req_test_environment", operation: "get_home_environment", arguments: { rooms: ["客厅"], metrics: ["temperature"] } }, token, env, {
    discovery: async () => { discoveryCalls += 1; return discovery; },
    exposure: async () => ({ version: 1, enabled: true, roomMetrics: { "客厅": ["temperature"], "卧室": ["humidity"] }, deviceDids: [], updatedAt: null, revision: "exp_test" }),
    environment: async (_session, _home, dependencies, filter) => {
      environmentCalls += 1;
      assert.equal(await dependencies.listDevices(session), discovery);
      assert.deepEqual(filter.rooms, ["客厅"]);
      assert.deepEqual(filter.metrics, ["temperature"]);
      assert.deepEqual(filter.roomMetrics, { "客厅": ["temperature"] });
      return {
        capturedAt: "2026-09-23T00:00:00Z",
        completeness: "complete",
        groups: [
          { metric: "temperature", label: "温度", unit: "°C", latest: { value: 23, unit: "°C", sourceLabel: "测试传感器", roomName: "客厅", capturedAt: "2026-09-23T00:00:00Z", freshness: "fresh" }, readings: [{ value: 23, unit: "°C", sourceLabel: "测试传感器", roomName: "客厅", capturedAt: "2026-09-23T00:00:00Z", freshness: "fresh" }] },
          { metric: "humidity", label: "湿度", unit: "%", latest: { value: 50, unit: "%", sourceLabel: "测试传感器", roomName: "卧室", capturedAt: "2026-09-23T00:00:00Z", freshness: "fresh" }, readings: [{ value: 50, unit: "%", sourceLabel: "测试传感器", roomName: "卧室", capturedAt: "2026-09-23T00:00:00Z", freshness: "fresh" }] },
        ],
        warnings: [],
      };
    },
  });
  assert.equal(discoveryCalls, 1);
  assert.equal(environmentCalls, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].metric, "temperature");
  assert.equal(result.groups[0].latest.value, 23);
  await assert.rejects(
    invokeAssistantToolV1({ requestId: "req_test_environment", operation: "get_home_environment", arguments: { rooms: ["未授权房间"] } }, token, env, {
      discovery: async () => discovery,
      exposure: async () => ({ version: 1, enabled: true, roomMetrics: { "客厅": ["temperature"], "卧室": ["humidity"] }, deviceDids: [], updatedAt: null, revision: "exp_test" }),
    }),
    error => error.message === "AI_INVALID_REQUEST" && error.diagnosticCode === "FILTER_ROOMS_INVALID",
  );
  await assert.rejects(
    invokeAssistantToolV1({ requestId: "req_test_device", operation: "get_device_status", arguments: { kinds: ["light"] } }, token, env, {
      discovery: async () => discovery,
      exposure: async () => ({ version: 1, enabled: true, roomMetrics: {}, deviceDids: ["fake-device-1"], updatedAt: null, revision: "exp_test" }),
    }),
    error => error.message === "AI_INVALID_REQUEST" && error.diagnosticCode === "FILTER_KINDS_INVALID",
  );
});

test("device filters preserve unknown states and only return the selected room, kind, and state", () => {
  const snapshot = {
    capturedAt: "2026-09-23T00:00:00Z",
    completeness: "partial",
    poweredOn: 1,
    rooms: [
      { room: "客厅", items: [{ name: "客厅灯", kind: "light", state: "on", online: true }, { name: "客厅风扇", kind: "fan", state: "unknown", online: false }] },
      { room: "卧室", items: [{ name: "卧室灯", kind: "light", state: "off", online: true }] },
    ],
    warnings: [],
  };
  const filtered = filterDeviceStatus(snapshot, ["客厅"], ["fan"], ["unknown"]);
  assert.deepEqual(filtered.rooms, [{ room: "客厅", items: [{ name: "客厅风扇", kind: "fan", state: "unknown", online: false }] }]);
  assert.equal(filtered.poweredOn, 0);
  assert.equal(filtered.rooms[0].items[0].state, "unknown");
});

test("local exposure store persists only supported hashed keys and creates audit entries once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mijia-exposure-"));
  const store = createLocalAssistantExposureStore(directory);
  const key = `homes/${"a".repeat(64)}.json`;
  const auditKey = `homes/${"a".repeat(64)}/audit/1234567890-${crypto.randomUUID()}.json`;
  try {
    assert.equal(await store.get(key, { type: "json", consistency: "strong" }), null);
    await store.setJSON(key, { enabled: false, revision: "exp_default_deny" });
    assert.deepEqual(await store.get(key), { enabled: false, revision: "exp_default_deny" });
    await store.setJSON(auditKey, { version: 1 }, { onlyIfNew: true });
    assert.deepEqual(await store.get(auditKey), { version: 1 });
    await assert.rejects(store.setJSON(auditKey, { version: 2 }, { onlyIfNew: true }), { code: "EEXIST" });
    await assert.rejects(store.get("../../outside.json"));
    await assert.rejects(store.setJSON("homes/not-a-hash.json", {}));
    assert.match(await readFile(join(directory, key), "utf8"), /exp_default_deny/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
