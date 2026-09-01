import assert from "node:assert/strict";
import test from "node:test";

test("renders the Xiaomi smart home dashboard", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>米家 Web 控制台<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/, "mobile devices need a device-width viewport");
  assert.match(html, /<meta name="theme-color" content="#fafbfc"/, "mobile browsers should inherit the dashboard theme");
  assert.match(html, /aria-label="打开菜单"/, "mobile users must be able to open the full navigation drawer");
  assert.match(html, /aria-label="主菜单"/);
  assert.match(html, /账号与连接/, "the navigation drawer must retain Xiaomi account settings");
  assert.match(html, /扫码连接米家/);
  assert.match(html, /aria-label="选择家庭"/);
  assert.match(html, /当前家庭/);
  assert.match(html, /当前运行/);
  assert.match(html, /3 台设备正在运行/);
  assert.match(html, /快捷场景/);
  assert.match(html, /演示场景/);
  assert.match(html, /回家/);
  assert.match(html, /客厅/);
  assert.match(html, /主卧/);
  assert.match(html, /客厅吸顶灯/);
  assert.match(html, /米家空调/);
  assert.match(html, /空气净化器/);
  assert.doesNotMatch(html, /室内温度/);
  assert.doesNotMatch(html, /设备管理/, "the full device inventory should only render on the device tab");
});

test("reading or changing device settings requires an authenticated Xiaomi session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `control-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  for (const request of [
    new Request("http://localhost/api/xiaomi/control?did=123&siid=2&piid=1"),
    new Request("http://localhost/api/xiaomi/control?did=123&properties=2.1,3.1,4.1"),
    new Request("http://localhost/api/xiaomi/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: "123", siid: 2, piid: 1, value: true }),
    }),
  ]) {
    const response = await worker.fetch(request, env, context);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "XIAOMI_NOT_CONNECTED" });
  }
});

test("device capability discovery requires an authenticated Xiaomi session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `spec-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/xiaomi/spec?model=vendor.switch.triple"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "XIAOMI_NOT_CONNECTED" });
});

test("device synchronization requires an authenticated Xiaomi session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `devices-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/xiaomi/devices"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "XIAOMI_NOT_CONNECTED" });
});

test("reading, running or writing scenes requires an authenticated Xiaomi session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `scenes-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  for (const request of [
    new Request("http://localhost/api/xiaomi/scenes?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/scenes/action-catalog?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/scenes/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId: "home-1", sceneId: "scene-1" }),
    }),
    new Request("http://localhost/api/xiaomi/scenes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId: "home-1", name: "测试", actions: [] }),
    }),
    new Request("http://localhost/api/xiaomi/scenes/scene-1?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/scenes/scene-1?homeId=home-1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId: "home-1", name: "测试", revision: "a".repeat(64) }),
    }),
  ]) {
    const response = await worker.fetch(request, env, context);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "XIAOMI_NOT_CONNECTED" });
  }
});

test("reading or writing automations requires an authenticated Xiaomi session", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `automations-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  for (const request of [
    new Request("http://localhost/api/xiaomi/automations?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/automations/catalog?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/automations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId: "home-1", name: "测试", schedule: { time: "08:00", weekdays: [1] }, actions: [] }),
    }),
    new Request("http://localhost/api/xiaomi/automations/automation-1?homeId=home-1"),
    new Request("http://localhost/api/xiaomi/automations/automation-1?homeId=home-1", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ homeId: "home-1", name: "测试", revision: "a".repeat(64) }),
    }),
  ]) {
    const response = await worker.fetch(request, env, context);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "XIAOMI_NOT_CONNECTED" });
  }
});

test("scene APIs reject malformed identifiers before contacting Xiaomi", async () => {
  process.env.XIAOMI_SESSION_SECRET = "scene-api-test-secret-with-at-least-32-characters";
  const { seal } = await import("../lib/xiaomi-cloud.ts");
  const cookie = await seal({
    userId: "test-user",
    ssecurity: "unused",
    serviceToken: "unused",
    region: "cn",
    createdAt: Date.now(),
  });
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `scene-validation-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const headers = { cookie: `xiaomi_session=${cookie}` };

  const listResponse = await worker.fetch(new Request("http://localhost/api/xiaomi/scenes?homeId=", { headers }), env, context);
  assert.equal(listResponse.status, 400);
  assert.deepEqual(await listResponse.json(), { error: "INVALID_HOME_ID" });

  const runResponse = await worker.fetch(new Request("http://localhost/api/xiaomi/scenes/run", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ homeId: "home-1", sceneId: "bad\nscene" }),
  }), env, context);
  assert.equal(runResponse.status, 400);
  assert.deepEqual(await runResponse.json(), { error: "INVALID_SCENE_COMMAND" });
});
