import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { listDevices, XiaomiCloudError, xiaomiErrorInfo } from "../lib/xiaomi-cloud.ts";

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
  assert.match(devicesRoute, /parseManualScenes\(\{ result: rawScenes \}, selectedHomeId, result\.devices\)/);
  assert.match(devicesRoute, /devices: result\.completeness/);
  assert.match(devicesRoute, /properties: runtime\.failedPropertyBatchCount/);
  assert.match(devicesRoute, /totalXiaomiRequestAttemptCount: result\.requestAttemptCount \+ runtime\.propertyBatchCount \+ sceneAttemptCount/);
  assert.doesNotMatch(scenesRoute.slice(0, scenesRoute.indexOf("export async function POST")), /listDevices\(/, "scene-only reads must not repeat a full device sync");
  assert.doesNotMatch(devicesRoute, /redactedDid|did:\s*(?:mapped|redacted|did)/, "diagnostics must not include full or partial DIDs");
});
