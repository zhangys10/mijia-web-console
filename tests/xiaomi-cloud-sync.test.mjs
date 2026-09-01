import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listDevices, listHomeContexts, miotActionPayload, XiaomiCloudError, xiaomiErrorInfo } from "../lib/xiaomi-cloud.ts";

const session = {
  userId: "fake-user",
  ssecurity: "unused-in-injected-tests",
  serviceToken: "unused-in-injected-tests",
  region: "cn",
  createdAt: 0,
};

function homes(...ids) {
  return { result: { homelist: ids.map(id => ({ id, name: `Home ${id}`, dids: [] })) } };
}

test("wraps MIoT actions in Xiaomi's object-shaped params envelope", () => {
  assert.deepEqual(miotActionPayload("fake-device", 2, 3, ["value"]), {
    params: { did: "fake-device", siid: 2, aiid: 3, in: ["value"] },
  });
});

test("keeps a home owner id server-side for instance-scoped automation discovery", async () => {
  const contexts = await listHomeContexts(session, async () => ({ result: { homelist: [
    { id: "owned", name: "自有家庭", home_owner: "owner-one" },
    { id: "shared", name: "共享家庭", owner_id: "owner-two" },
    { id: "uid", name: "UID 家庭", uid: "owner-three" },
    { id: "fallback", name: "默认家庭" },
  ] } }));
  assert.deepEqual(contexts, [
    { id: "owned", name: "自有家庭", ownerUid: "owner-one" },
    { id: "shared", name: "共享家庭", ownerUid: "owner-two" },
    { id: "uid", name: "UID 家庭", ownerUid: "owner-three" },
    { id: "fallback", name: "默认家庭", ownerUid: "fake-user" },
  ]);
});

test("normal device discovery performs one home request and one request per home", async () => {
  const calls = [];
  const result = await listDevices(session, { request: async (_session, path, data) => {
    calls.push({ path, data });
    if (path.endsWith("/gethome")) return homes("one");
    return { result: { device_info: [{ did: "fake-device", model: "fake.light.v1" }] } };
  } });

  assert.deepEqual(calls.map(call => call.path), [
    "/app/v2/homeroom/gethome",
    "/app/v2/home/home_device_list",
  ]);
  assert.equal(result.completeness, "complete");
  assert.equal(result.successfulHomeCount, 1);
  assert.equal(result.failedHomeCount, 0);
  assert.equal(result.requestAttemptCount, 2);
});

test("device discovery paginates with max_did and processes homes beyond the first ten", async () => {
  const homeList = Array.from({ length: 11 }, (_, index) => ({
    id: `home-${index + 1}`,
    name: `Home ${index + 1}`,
    uid: `owner-${index + 1}`,
    dids: [],
  }));
  const deviceCalls = [];
  const result = await listDevices(session, { request: async (_session, path, data) => {
    if (path.endsWith("/gethome")) return { result: { homelist: homeList } };
    deviceCalls.push(data);
    assert.equal(data.home_owner, `owner-${String(data.home_id).slice(5)}`);
    if (data.home_id === "home-1" && data.start_did === "") {
      return { result: { device_info: [{ did: "page-one", model: "fake.light.v1" }], has_more: true, max_did: "cursor-1" } };
    }
    if (data.home_id === "home-1") {
      assert.equal(data.start_did, "cursor-1");
      return { result: { device_info: [{ did: "page-two", model: "fake.light.v2" }], has_more: false } };
    }
    assert.equal(data.start_did, "");
    return { result: { device_info: [], has_more: false } };
  } });

  assert.equal(deviceCalls.length, 12);
  assert.ok(deviceCalls.some(call => call.home_id === "home-11"));
  assert.deepEqual(result.devices.map(device => device.did), ["page-one", "page-two"]);
  assert.equal(result.completeness, "complete");
  assert.equal(result.successfulHomeCount, 11);
  assert.equal(result.failedHomeCount, 0);
  assert.equal(result.requestAttemptCount, 13);
});

test("a later device page failure keeps earlier pages and marks the home partial", async () => {
  const result = await listDevices(session, { request: async (_session, path, data) => {
    if (path.endsWith("/gethome")) return homes("one");
    if (data.start_did === "") {
      return { result: { device_info: [{ did: "kept-device", model: "fake.light.v1" }], has_more: true, max_did: "next-page" } };
    }
    throw new XiaomiCloudError("XIAOMI_CLOUD_TIMEOUT", "timeout", true);
  } });

  assert.deepEqual(result.devices.map(device => device.did), ["kept-device"]);
  assert.equal(result.completeness, "partial");
  assert.equal(result.successfulHomeCount, 0);
  assert.equal(result.failedHomeCount, 1);
  assert.equal(result.requestAttemptCount, 3);
  assert.deepEqual(result.warnings, [{ code: "XIAOMI_DEVICE_HOMES_PARTIAL", scope: "devices", retryable: true }]);
});

test("a repeated device cursor stops pagination without accepting the repeated page", async () => {
  let pageCount = 0;
  const result = await listDevices(session, { request: async (_session, path) => {
    if (path.endsWith("/gethome")) return homes("one");
    pageCount += 1;
    return { result: {
      device_info: [{ did: pageCount === 1 ? "kept-device" : "repeated-page-device", model: "fake.light.v1" }],
      has_more: true,
      max_did: "same-cursor",
    } };
  } });

  assert.equal(pageCount, 2);
  assert.deepEqual(result.devices.map(device => device.did), ["kept-device"]);
  assert.equal(result.completeness, "partial");
  assert.equal(result.successfulHomeCount, 0);
  assert.equal(result.failedHomeCount, 1);
  assert.equal(result.requestAttemptCount, 3);
  assert.deepEqual(result.warnings, [{ code: "XIAOMI_DEVICE_HOMES_PARTIAL", scope: "devices", retryable: false }]);
});

test("a first-request timeout stops immediately without either legacy protocol", async () => {
  let primaryCalls = 0;
  let signedCalls = 0;
  await assert.rejects(
    listDevices(session, {
      request: async () => {
        primaryCalls += 1;
        throw new XiaomiCloudError("XIAOMI_CLOUD_TIMEOUT", "timeout", true);
      },
      signedRequest: async () => {
        signedCalls += 1;
        return {};
      },
    }),
    /XIAOMI_CLOUD_TIMEOUT/,
  );
  assert.equal(primaryCalls, 1);
  assert.equal(signedCalls, 0);
});

test("one failed home returns other homes immediately as partial data", async () => {
  const calls = [];
  const result = await listDevices(session, { request: async (_session, path, data) => {
    calls.push(path);
    if (path.endsWith("/gethome")) return homes("failed", "working");
    if (data.home_id === "failed") throw new XiaomiCloudError("XIAOMI_CLOUD_TIMEOUT", "timeout", true);
    return { result: { device_info: [{ did: "working-device", model: "fake.light.v1" }] } };
  } });

  assert.equal(calls.length, 3);
  assert.equal(result.completeness, "partial");
  assert.equal(result.successfulHomeCount, 1);
  assert.equal(result.failedHomeCount, 1);
  assert.deepEqual(result.warnings, [{ code: "XIAOMI_DEVICE_HOMES_PARTIAL", scope: "devices", retryable: true }]);
  assert.equal(result.devices.length, 1);
  assert.equal(result.requestAttemptCount, 3);
});

test("legacy signed protocol is restricted to an explicit unsupported-media response", async () => {
  let signedCalls = 0;
  const result = await listDevices(session, {
    request: async (_session, path) => {
      if (path.endsWith("/gethome")) return homes();
      throw new XiaomiCloudError("XIAOMI_CLOUD_HTTP_415", "upstream", false);
    },
    signedRequest: async () => {
      signedCalls += 1;
      return { result: { list: [] } };
    },
  });
  assert.equal(signedCalls, 1);
  assert.equal(result.completeness, "complete");

  signedCalls = 0;
  await assert.rejects(
    listDevices(session, {
      request: async (_session, path) => {
        if (path.endsWith("/gethome")) return homes();
        throw new XiaomiCloudError("XIAOMI_CLOUD_NETWORK", "network", true);
      },
      signedRequest: async () => {
        signedCalls += 1;
        return {};
      },
    }),
    /XIAOMI_CLOUD_NETWORK/,
  );
  assert.equal(signedCalls, 0);
});

test("cloud errors expose stable HTTP and retry semantics", () => {
  assert.deepEqual(xiaomiErrorInfo(new XiaomiCloudError("XIAOMI_CLOUD_TIMEOUT", "timeout", true)), {
    message: "XIAOMI_CLOUD_TIMEOUT", status: 504, retryable: true, retryAfterSeconds: undefined,
  });
  assert.deepEqual(xiaomiErrorInfo(new XiaomiCloudError("XIAOMI_CLOUD_HTTP_429", "rate-limit", true, 25)), {
    message: "XIAOMI_CLOUD_HTTP_429", status: 429, retryable: true, retryAfterSeconds: 25,
  });
  assert.deepEqual(xiaomiErrorInfo(new XiaomiCloudError("XIAOMI_CLOUD_HTTP_401", "authentication", false)), {
    message: "XIAOMI_CLOUD_HTTP_401", status: 401, retryable: false, retryAfterSeconds: undefined,
  });
  assert.deepEqual(xiaomiErrorInfo(new XiaomiCloudError("XIAOMI_CLOUD_NETWORK", "network", true)), {
    message: "XIAOMI_CLOUD_NETWORK", status: 503, retryable: true, retryAfterSeconds: undefined,
  });
});

test("the unified route reuses device results for scenes and logs no device identifiers", async () => {
  const devicesRoute = await readFile(new URL("../app/api/xiaomi/devices/route.ts", import.meta.url), "utf8");
  const scenesRoute = await readFile(new URL("../app/api/xiaomi/scenes/route.ts", import.meta.url), "utf8");
  assert.match(devicesRoute, /includeScenes/);
  assert.match(devicesRoute, /loadSceneActionCapabilities\(rawScenes, selectedHomeId, runtime\.sceneCapabilities\)/);
  assert.match(devicesRoute, /parseManualScenes\(\{ result: rawScenes \}, selectedHomeId, result\.devices, sceneCapabilities\)/);
  assert.match(devicesRoute, /devices: result\.completeness/);
  assert.match(devicesRoute, /properties: runtime\.failedPropertyBatchCount/);
  assert.match(devicesRoute, /totalXiaomiRequestAttemptCount: result\.requestAttemptCount \+ runtime\.propertyBatchCount \+ sceneAttemptCount/);
  assert.doesNotMatch(scenesRoute.slice(0, scenesRoute.indexOf("export async function POST")), /listDevices\(/, "scene-only reads must not repeat a full device sync");
  assert.doesNotMatch(devicesRoute, /redactedDid|did:\s*(?:mapped|redacted|did)/, "diagnostics must not include full or partial DIDs");
});
