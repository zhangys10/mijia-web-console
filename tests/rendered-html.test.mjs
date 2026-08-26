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
  assert.match(html, /aria-label="账号与连接"/, "mobile users must retain access to Xiaomi account settings");
  assert.match(html, /扫码连接米家/);
  assert.match(html, /设备管理/);
  assert.match(html, /客厅/);
  assert.match(html, /主卧/);
  assert.match(html, /客厅三开/);
  assert.match(html, /客厅中控/);
  assert.match(html, /主卧中控/);
  assert.match(html, /客厅吸顶灯/, "independent smart lights must remain visible beside real living-room hardware");
  assert.doesNotMatch(html, /虚拟开关/, "physical switch cards must never be labelled as virtual");
  assert.match(html, /实体开关/);
  assert.match(html, /中控屏/);
  assert.match(html, /智能灯具/);
  assert.match(html, /设备管理/);
  assert.match(html, /开关与硬件/);
  assert.match(html, /实际照明/);
  assert.match(html, /无线副控/);
  assert.match(html, /硬件按米家房间展示/);
  assert.doesNotMatch(html, /topology-toolbar/, "the old device page must be replaced, not rendered alongside the new interface");
  assert.ok(html.indexOf('class="dm-room-tabs"') < html.indexOf('class="dm-view-tabs"'), "room selection should remain above the view switch");
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
