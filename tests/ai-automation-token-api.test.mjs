import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

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

// Provider 验证只允许访问服务端 Catalog 中的大陆 endpoint；测试用 fetch mock 替代真实网络，
// 绝不再提供任何请求可控的“跳过验证”开关。
const realFetch = globalThis.fetch;
let providerFetchCalls = 0;

beforeEach(() => {
  providerFetchCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("dashscope.aliyuncs.com")) {
      return realFetch(input, init);
    }
    providerFetchCalls += 1;
    const auth = init?.headers?.Authorization ?? "";
    if (auth.includes("bad")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("automation token API rejects unauthenticated requests with 401", async () => {
  const { worker, env, context } = await getWorker();
  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-test" }),
  });
  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "XIAOMI_NOT_CONNECTED");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("automation token API rejects client-supplied baseUrl", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({
      apiKey: "sk-test",
      baseUrl: "https://malicious-site.com",
    }),
  });
  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, "INVALID_REQUEST");
  assert.match(data.message, /baseUrl/);
});

test("automation token API rejects invalid expiresInDays", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  // Less than 1
  const reqLow = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: "sk-test", expiresInDays: 0 }),
  });
  const resLow = await worker.fetch(reqLow, env, context);
  assert.equal(resLow.status, 400);

  // Greater than 90
  const reqHigh = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: "sk-test", expiresInDays: 91 }),
  });
  const resHigh = await worker.fetch(reqHigh, env, context);
  assert.equal(resHigh.status, 400);
});

test("automation token API rejects unsupported provider or model", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  const reqBadProvider = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: "sk-test", provider: "unsupported-provider" }),
  });
  const resBadProvider = await worker.fetch(reqBadProvider, env, context);
  assert.equal(resBadProvider.status, 422);
  const dataBadProvider = await resBadProvider.json();
  assert.equal(dataBadProvider.error, "LLM_PROVIDER_NOT_ALLOWED");

  const reqBadModel = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: "sk-test", provider: "qwen-cn", model: "gpt-4o" }),
  });
  const resBadModel = await worker.fetch(reqBadModel, env, context);
  assert.equal(resBadModel.status, 422);
  const dataBadModel = await resBadModel.json();
  assert.equal(dataBadModel.error, "LLM_MODEL_NOT_ALLOWED");
});

test("automation token API successfully issues token without leaking raw key or session", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const userKey = "sk-super-secret-user-key-value-999";

  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      apiKey: userKey,
      provider: "qwen-cn",
      model: "qwen3.7-flash-2026-07-15",
      expiresInDays: 30,
    }),
  });

  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(providerFetchCalls, 1);

  const data = await res.json();
  assert.equal(data.ok, true);
  assert.ok(data.token);
  assert.equal(data.provider, "qwen-cn");
  assert.equal(data.model, "qwen3.7-flash-2026-07-15");
  assert.equal(typeof data.expiresAt, "number");

  // Raw key and session secrets must NOT be in the response JSON!
  assert.equal(JSON.stringify(data).includes(userKey), false);
  assert.equal(JSON.stringify(data).includes("mock-ssec"), false);
  assert.equal(JSON.stringify(data).includes("mock-stok"), false);

  // Decrypt the token to verify it sealed the user's key and session accurately
  const opened = await openAutomationToken(data.token, {
    secret: process.env.AI_AUTOMATION_TOKEN_SECRET,
    env: process.env.NODE_ENV || "development",
  });
  assert.equal(opened.apiKey, userKey);
  assert.equal(opened.xiaomiSession.userId, "user-test-1");
  assert.equal(opened.xiaomiSession.ssecurity, "mock-ssec");
  assert.equal(opened.provider, "qwen-cn");
});

test("automation token API cannot skip provider key validation via request flags", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);

  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-skip-validation": "true",
      Cookie: cookie,
    },
    body: JSON.stringify({
      apiKey: "sk-bad-provider-key",
      provider: "qwen-cn",
      _skipValidation: true,
    }),
  });

  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, "LLM_CREDENTIAL_INVALID");
  // 请求既没有绕过验证，也不能在响应里回显原始 Key
  assert.equal(JSON.stringify(data).includes("sk-bad-provider-key"), false);
  assert.equal(providerFetchCalls, 1);
});

test("automation token API maps unreachable provider to LLM_PROVIDER_ERROR without leaking the key", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const userKey = "sk-unreachable-provider-key-123";

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("dashscope.aliyuncs.com")) return realFetch(input, init);
    const error = new Error("getaddrinfo ENOTFOUND dashscope.aliyuncs.com");
    error.name = "TypeError";
    throw error;
  };

  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: userKey, provider: "qwen-cn" }),
  });

  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.equal(data.error, "LLM_PROVIDER_ERROR");
  assert.equal(data.message, "无法连接模型服务商，请检查网络后重试");
  assert.equal(JSON.stringify(data).includes(userKey), false);
});

test("automation token API recognizes pasted keys with invisible characters as credential errors", async () => {
  const { worker, env, context } = await getWorker();
  const cookie = await createCookieHeader(fakeSession);
  const pastedKey = "sk-copied\nwrong";

  const req = new Request("http://localhost/api/ai/automation-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ apiKey: pastedKey, provider: "qwen-cn" }),
  });

  const res = await worker.fetch(req, env, context);
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, "LLM_CREDENTIAL_INVALID");
  assert.equal(data.message, "模型 API Key 含空格、换行或不可见字符，请确认已完整复制正确的 Key");
  assert.equal(providerFetchCalls, 0);
});

test("GET /api/ai/automation-token returns supported providers and login status", async () => {
  const { worker, env, context } = await getWorker();
  const resNoAuth = await worker.fetch(new Request("http://localhost/api/ai/automation-token"), env, context);
  assert.equal(resNoAuth.status, 200);
  const dataNoAuth = await resNoAuth.json();
  assert.equal(dataNoAuth.authenticated, false);
  assert.ok(Array.isArray(dataNoAuth.supportedProviders));
  assert.equal(resNoAuth.headers.get("Cache-Control"), "no-store");
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
