import assert from "node:assert/strict";
import test from "node:test";

import { seal } from "../lib/xiaomi-cloud.ts";
import { openAutomationToken } from "../lib/ai/security/automation-token.ts";

process.env.XIAOMI_SESSION_SECRET = "ai-automation-token-test-secret-at-least-32-chars";
process.env.AI_AUTOMATION_TOKEN_SECRET = "ai-automation-token-test-secret-at-least-32-chars";
process.env.NODE_ENV = "test";
process.env.APP_ENV = "test";

const fakeSession = {
  userId: "user-test-1",
  cUserId: "c-user-test-1",
  ssecurity: "mock-ssec",
  serviceToken: "mock-stok",
  region: "cn",
  deviceId: "dev-1",
  userAgent: "agent-1",
  createdAt: Date.now(),
};

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-auto-token-${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  return { worker, env, context };
}

async function createCookieHeader(session) {
  const sealed = await seal(session);
  return `xiaomi_session=${sealed}`;
}

test("automation token API rejects unauthenticated requests with 401", async () => {
  const { worker, env, context } = await getWorker();
  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresInDays: 30 }),
  });
  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "XIAOMI_NOT_CONNECTED");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("automation token API rejects all BYOK fields instead of sealing them", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  for (const body of [
    { apiKey: "sk-test" },
    { provider: "qwen-cn" },
    { model: "qwen3.7-flash" },
    { baseUrl: "https://malicious-site.com" },
  ]) {
    const req = new Request("http://localhost/api/ai/automation-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    const res = await worker.fetch(req, env, context);
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, "INVALID_REQUEST");
  }
});

test("automation token API rejects invalid expiresInDays", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  const reqLow = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ expiresInDays: 0 }),
  });
  const resLow = await worker.fetch(reqLow, env, context);
  assert.equal(resLow.status, 400);

  const reqHigh = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ expiresInDays: 91 }),
  });
  const resHigh = await worker.fetch(reqHigh, env, context);
  assert.equal(resHigh.status, 400);
});

test("automation token API issues a session-only token without leaking secrets", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ expiresInDays: 30 }),
  });

  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.token);
  assert.equal(typeof data.expiresAt, "number");
  // BYOK 已下线：响应中不再出现 provider/model 字段。
  assert.equal(data.provider, undefined);
  assert.equal(data.model, undefined);

  // Session secrets must NOT be in the response JSON!
  assert.equal(JSON.stringify(data).includes("mock-ssec"), false);
  assert.equal(JSON.stringify(data).includes("mock-stok"), false);

  // Decrypt the token: 只封装会话与主体，不包含任何模型凭据。
  const opened = await openAutomationToken(data.token, {
    secret: process.env.AI_AUTOMATION_TOKEN_SECRET,
    env: process.env.NODE_ENV || "development",
  });
  assert.equal(opened.xiaomiSession.userId, "user-test-1");
  assert.equal(opened.xiaomiSession.ssecurity, "mock-ssec");
  assert.equal(opened.apiKey, undefined);
  assert.equal(opened.provider, undefined);
  assert.equal(opened.model, undefined);
});

test("GET /api/ai/automation-token returns login status without provider catalog", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(new Request("http://localhost/api/ai/automation-token"), env, context);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, false);
  // Phase 3: provider catalog 已删除，GET 不再返回 supportedProviders。
  assert.equal(data.supportedProviders, undefined);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("renders the AI settings page HTML", async () => {
  const { worker, env, context } = await getWorker();
  const res = await worker.fetch(
    new Request("http://localhost/ai/settings", {
      headers: { accept: "text/html" },
    }),
    env,
    context
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await res.text();
  assert.match(html, /AI 自动化配置/);
  assert.match(html, /aria-label="主菜单"/);
  assert.match(html, /AI 自动化/);
  assert.match(html, /账号与连接/);
});
