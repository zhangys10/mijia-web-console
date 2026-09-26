import assert from "node:assert/strict";
import test from "node:test";
import { seal } from "../lib/xiaomi-cloud.ts";
import { derivePrincipalId } from "../lib/ai/security/principal.ts";
import { onRequest } from "../lib/ai/api/quota.ts";

const sessionSecret = "ai-quota-api-test-secret-at-least-32-characters";
const principalSecret = "ai-quota-principal-secret-at-least-32-characters";
const session = {
  userId: "user-quota-a", cUserId: "c-user-quota-a", ssecurity: "mock-ssecurity-a",
  serviceToken: "mock-serviceToken-a", region: "cn", deviceId: "mock-device-a",
  userAgent: "mock-agent-a", createdAt: Date.now(),
};
const baseEnv = (overrides = {}) => ({
  XIAOMI_SESSION_SECRET: sessionSecret, AI_PRINCIPAL_SECRET: principalSecret,
  AI_QUOTA_ENABLED: "true", ...overrides,
});
async function cookie() { return `xiaomi_session=${await seal(session, sessionSecret)}`; }
async function request(headers = {}) {
  return new Request("https://console.example/api/ai/quota", { headers: { Cookie: await cookie(), ...headers } });
}

test("quota summary uses authenticated principal and no-store", async (ctx) => {
  const principalId = await derivePrincipalId(session, { AI_PRINCIPAL_SECRET: principalSecret });
  ctx.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.toString(), "https://agent.example/api/internal/quota");
    assert.deepEqual(JSON.parse(init.body), { operation: "summary", principalId });
    assert.equal(init.redirect, "error");
    return Response.json({ quota: { principalId, mode: "default", limits: null, usage: null,
      remaining: { requestsThisMinute: 10, requestsToday: 30, tokensThisMonth: 1000 }, resetAt: null, softLimit: true,
      privateField: "must-not-leak" } });
  });
  const response = await onRequest({ request: await request({ "X-Principal-Id": "usr_forged" }), env: baseEnv({
    AI_AGENT_BASE_URL: "https://agent.example", AI_AGENT_INTERNAL_SECRET: "fake-agent-reader-secret-".repeat(3),
  }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.quota.principalId, principalId);
  assert.equal(data.quota.privateField, undefined);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("quota rejects missing or invalid sessions", async () => {
  for (const headers of [{}, { Cookie: "xiaomi_session=invalid" }]) {
    const response = await onRequest({ request: new Request("https://console.example/api/ai/quota", { headers }), env: baseEnv() });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "AI_UNAUTHENTICATED");
  }
});

test("quota rejects unsupported methods and invalid enabled flag", async () => {
  const post = await onRequest({ request: new Request("https://console.example/api/ai/quota", { method: "POST", headers: { Cookie: await cookie() } }), env: baseEnv() });
  assert.equal(post.status, 405);
  const invalid = await onRequest({ request: await request(), env: baseEnv({ AI_QUOTA_ENABLED: "yes" }) });
  assert.equal(invalid.status, 500);
  assert.equal((await invalid.json()).code, "AI_QUOTA_CONFIG_INVALID");
});

test("enabled quota fails closed when Agent is not configured", async () => {
  const response = await onRequest({ request: await request(), env: baseEnv() });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "AI_AGENT_UNAVAILABLE");
});

test("Agent quota failures do not fall back to a Console ledger", async (ctx) => {
  ctx.mock.method(globalThis, "fetch", async () => Response.json({ code: "AI_QUOTA_STORE_UNAVAILABLE" }, { status: 503 }));
  const response = await onRequest({ request: await request(), env: baseEnv({
    AI_AGENT_BASE_URL: "https://agent.example", AI_AGENT_INTERNAL_SECRET: "fake-agent-reader-secret-".repeat(3),
  }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_QUOTA_STORE_UNAVAILABLE");
});

test("disabled quota returns a local summary without Agent configuration or fetch", async (ctx) => {
  const spy = ctx.mock.method(globalThis, "fetch", async () => assert.fail("Agent must not be called"));
  const principalId = await derivePrincipalId(session, { AI_PRINCIPAL_SECRET: principalSecret });
  const response = await onRequest({ request: await request(), env: baseEnv({ AI_QUOTA_ENABLED: "false" }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).quota, {
    principalId, mode: "disabled", limits: null, usage: null,
    remaining: { requestsThisMinute: null, requestsToday: null, tokensThisMonth: null }, resetAt: null, softLimit: true,
  });
  assert.equal(spy.mock.callCount(), 0);
});
