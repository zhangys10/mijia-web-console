import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sealWithSecret } from "../lib/xiaomi-cloud.ts";
import { onRequest as exposureHandler } from "../edge-functions/api/ai/exposure.ts";
import {
  assistantExposureProjection,
  readAssistantExposure,
  updateAssistantExposure,
} from "../lib/ai/tools/assistant-exposure.ts";
import { filterEnvironmentByExposure, filterDeviceStatus } from "../lib/ai/tools/assistant-v1-service.ts";
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
    devices: async () => ({ devices: [] }),
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

  const result = await updateAssistantExposure({ userId: "test" }, homeId, {
    enabled: true,
    roomMetrics: { "客厅": ["temperature"] },
    deviceRefs: [selectedRef],
  }, "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", { store, homes, devices });

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
