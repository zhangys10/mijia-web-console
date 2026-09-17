import assert from "node:assert/strict";
import test from "node:test";

import { seal } from "../lib/xiaomi-cloud.ts";
import { derivePrincipalId } from "../lib/ai/security/principal.ts";
import { onRequest } from "../edge-functions/api/ai/quota.ts";

process.env.XIAOMI_SESSION_SECRET = "ai-quota-api-test-secret-at-least-32-characters";

const sessionSecret = "ai-quota-api-test-secret-at-least-32-characters";
const principalSecret = "ai-quota-principal-secret-at-least-32-characters";
const sessionA = {
  userId: "user-quota-a",
  cUserId: "c-user-quota-a",
  ssecurity: "mock-ssecurity-a",
  serviceToken: "mock-serviceToken-a",
  region: "cn",
  deviceId: "mock-device-a",
  userAgent: "mock-agent-a",
  createdAt: Date.now(),
};
const sessionB = { ...sessionA, userId: "user-quota-b", deviceId: "mock-device-b" };

class MemoryKv {
  constructor() {
    this.values = new Map();
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async put(key, value) {
    this.values.set(key, value);
  }
}

function baseEnv(overrides = {}) {
  return {
    XIAOMI_SESSION_SECRET: sessionSecret,
    AI_PRINCIPAL_SECRET: principalSecret,
    AI_QUOTA_ENABLED: "true",
    AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE: "10",
    AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "10",
    AI_QUOTA_DEFAULT_TOKENS_PER_MONTH: "1000",
    APP_ENV: "test",
    ...overrides,
  };
}

async function createCookieHeader(session) {
  return `xiaomi_session=${await seal(session)}`;
}

test("quota API returns only the current session principal summary", async () => {
  globalThis.ai_quota_kv = new MemoryKv();
  const cookie = await createCookieHeader(sessionA);
  const request = new Request("http://localhost/api/ai/quota?principalId=usr_forged", {
    headers: { Cookie: cookie, "X-Principal-Id": "usr_forged" },
  });
  const response = await onRequest({ request, env: baseEnv() });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(
    data.quota.principalId,
    await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret }),
  );
  assert.notEqual(data.quota.principalId, "usr_forged");
  assert.equal(data.quota.mode, "default");
  assert.equal(JSON.stringify(data).includes(sessionA.userId), false);
  assert.equal(JSON.stringify(data).includes(principalSecret), false);
  assert.equal(JSON.stringify(data).includes(sessionSecret), false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("quota API isolates user B from user A quota data", async () => {
  globalThis.ai_quota_kv = new MemoryKv();
  const cookieA = await createCookieHeader(sessionA);
  const requestA = new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookieA } });
  const responseA = await onRequest({ request: requestA, env: baseEnv() });
  await responseA.json();

  const cookieB = await createCookieHeader(sessionB);
  const requestB = new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookieB } });
  const responseB = await onRequest({ request: requestB, env: baseEnv() });
  const dataB = await responseB.json();

  assert.equal(
    dataB.quota.principalId,
    await derivePrincipalId(sessionB, { AI_PRINCIPAL_SECRET: principalSecret }),
  );
  assert.equal(
    JSON.stringify(dataB).includes(await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret })),
    false,
  );
});

test("quota API rejects missing or invalid sessions with 401", async () => {
  globalThis.ai_quota_kv = new MemoryKv();
  for (const headers of [{}, { Cookie: "xiaomi_session=invalid" }]) {
    const request = new Request("http://localhost/api/ai/quota", { headers });
    const response = await onRequest({ request, env: baseEnv() });
    assert.equal(response.status, 401);
    const data = await response.json();
    assert.equal(data.code, "AI_UNAUTHENTICATED");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("quota API rejects unsupported methods and invalid quota configuration", async () => {
  globalThis.ai_quota_kv = new MemoryKv();
  const cookie = await createCookieHeader(sessionA);
  const postResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { method: "POST", headers: { Cookie: cookie } }),
    env: baseEnv(),
  });
  assert.equal(postResponse.status, 405);

  const invalidConfigResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookie } }),
    env: baseEnv({ AI_QUOTA_FAIL_MODE: "relaxed" }),
  });
  assert.equal(invalidConfigResponse.status, 500);
  const data = await invalidConfigResponse.json();
  assert.equal(data.code, "AI_QUOTA_CONFIG_INVALID");
});

test("quota API fails closed when KV is not bound and honors open fail mode", async () => {
  delete globalThis.ai_quota_kv;
  const cookie = await createCookieHeader(sessionA);

  const closedResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookie } }),
    env: baseEnv({ AI_QUOTA_FAIL_MODE: "closed" }),
  });
  assert.equal(closedResponse.status, 503);
  const closedData = await closedResponse.json();
  assert.equal(closedData.code, "AI_QUOTA_STORE_UNAVAILABLE");

  const openResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookie } }),
    env: baseEnv({ AI_QUOTA_FAIL_MODE: "open" }),
  });
  assert.equal(openResponse.status, 200);
  const openData = await openResponse.json();
  assert.equal(openData.quota.usage, null);
  assert.equal(openData.quota.remaining.tokensThisMonth, null);
});

test("quota API reports unlimited and override modes without leaking the allowlist", async () => {
  globalThis.ai_quota_kv = new MemoryKv();
  const cookie = await createCookieHeader(sessionA);
  const principalId = await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret });

  const unlimitedResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookie } }),
    env: baseEnv({ AI_QUOTA_UNLIMITED_IDS: principalId }),
  });
  const unlimitedData = await unlimitedResponse.json();
  assert.equal(unlimitedData.quota.mode, "unlimited");
  assert.equal(JSON.stringify(unlimitedData).includes(principalId), true);
  assert.equal(JSON.stringify(unlimitedData).includes("AI_QUOTA_UNLIMITED_IDS"), false);

  const overrideResponse = await onRequest({
    request: new Request("http://localhost/api/ai/quota", { headers: { Cookie: cookie } }),
    env: baseEnv({ AI_QUOTA_OVERRIDES_JSON: JSON.stringify({ [principalId]: { requestsPerDay: 99 } }) }),
  });
  const overrideData = await overrideResponse.json();
  assert.equal(overrideData.quota.mode, "override");
  assert.equal(overrideData.quota.limits.requestsPerDay, 99);
});
