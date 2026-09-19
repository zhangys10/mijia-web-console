import assert from "node:assert/strict";
import test from "node:test";

import { createChatHandler } from "../edge-functions/api/ai/chat.ts";
import { createConversationHandler } from "../edge-functions/api/ai/conversations.ts";
import { createDeleteConversationHandler } from "../edge-functions/api/ai/conversations/[conversationId].ts";
import { InMemoryQuotaStore } from "../lib/ai/quota/in-memory-quota-store.ts";
import { QuotaStoreError } from "../lib/ai/quota/quota-store.ts";
import { verifyAgentBinding } from "../lib/ai/security/agent-binding.ts";
import { derivePrincipalId } from "../lib/ai/security/principal.ts";
import { AgentClientError, MakersAgentClient } from "../lib/ai/web-chat/agent-client.ts";
import { seal } from "../lib/xiaomi-cloud.ts";

const sessionSecret = "web-chat-session-secret-at-least-32-characters";
const principalSecret = "web-chat-principal-secret-at-least-32-chars";
const internalSecret = "web-chat-agent-secret-at-least-32-characters";
const fixedTime = Date.parse("2026-09-17T12:00:00+08:00");
const fixedUuid = "00000000-0000-4000-8000-000000000001";
const home = { id: "home-web-1", name: "我的家" };
const otherHome = { id: "home-web-2", name: "另一个家" };

process.env.XIAOMI_SESSION_SECRET = sessionSecret;

const sessionA = {
  userId: "web-user-a",
  cUserId: "web-c-user-a",
  ssecurity: "mock-web-ssecurity-a",
  serviceToken: "mock-web-service-token-a",
  region: "cn",
  deviceId: "mock-web-device-a",
  userAgent: "mock-web-agent-a",
  createdAt: fixedTime,
};
const sessionB = { ...sessionA, userId: "web-user-b", deviceId: "mock-web-device-b" };

function env(overrides = {}) {
  return {
    XIAOMI_SESSION_SECRET: sessionSecret,
    AI_PRINCIPAL_SECRET: principalSecret,
    AI_AGENT_INTERNAL_SECRET: internalSecret,
    AI_QUOTA_ENABLED: "true",
    AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE: "10",
    AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "10",
    AI_QUOTA_DEFAULT_TOKENS_PER_MONTH: "100000",
    AI_QUOTA_FAIL_MODE: "closed",
    APP_ENV: "test",
    ...overrides,
  };
}

async function cookie(session = sessionA) {
  return `xiaomi_session=${await seal(session)}`;
}

async function chatRequest(body, session = sessionA, headers = {}) {
  return new Request("http://localhost/api/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: await cookie(session),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function handlerOptions(overrides = {}) {
  return {
    loadHomes: async () => [home, otherHome],
    now: () => fixedTime,
    randomBytes: () => Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
    randomUuid: () => fixedUuid,
    ...overrides,
  };
}

function successFetch(calls, overrides = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: url.toString(), init, body });
    return new Response(JSON.stringify({
      requestId: body.requestId,
      conversationId: init.headers["Makers-Conversation-Id"],
      message: "欢迎回家，已经开启回家模式。",
      intent: "activate_scene",
      tool: { name: "activate_scene", status: "success", sceneName: "回家模式" },
      usage: { promptTokens: 24, completionTokens: 6, totalTokens: 30, estimated: false },
      ...overrides,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("web chat derives principal, issues a bound conversation, commits usage, and exposes only safe fields", async () => {
  const calls = [];
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: successFetch(calls, {
      scenes: [{
        alias: "scene_safe_alias",
        name: "回家模式",
        description: "当前家庭已审核的低风险手动场景：回家模式",
        actionCount: 2,
      }],
    }),
  }));
  const response = await handler({
    request: await chatRequest({
      homeId: home.id,
      message: " 我回家了 ",
      idempotencyKey: "web-chat-idempotency-000001",
    }),
    env: env(),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const data = await response.json();
  assert.match(data.requestId, /^req_[a-f0-9]{32}$/);
  assert.match(data.conversationId, /^cv1_[A-Za-z0-9_-]+$/);
  assert.equal(data.quota.remainingRequestsToday, 9);
  assert.equal(data.quota.remainingTokensThisMonth, 99970);
  assert.deepEqual(data.scenes, [{
    name: "回家模式",
    description: "当前家庭已审核的低风险手动场景：回家模式",
    actionCount: 2,
  }]);
  assert.equal(JSON.stringify(data).includes("scene_safe_alias"), false);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "http://localhost/ai-home");
  assert.equal(call.init.headers.Authorization, `Bearer ${internalSecret}`);
  assert.equal(call.body.principalId, await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret }));
  assert.equal(call.body.homeId, home.id);
  assert.equal(call.body.message, "我回家了");
  assert.deepEqual(call.body.scopes, ["ai:chat", "scene:activate"]);
  assert.equal(JSON.stringify(call.body).includes(sessionA.userId), false);
  assert.equal(JSON.stringify(call.body).includes(sessionA.serviceToken), false);
  await verifyAgentBinding(call.body.sessionBinding, {
    principalId: call.body.principalId,
    homeId: home.id,
    scopes: call.body.scopes,
    now: fixedTime,
  }, sessionSecret);

  const serialized = JSON.stringify(data);
  for (const secret of [sessionSecret, principalSecret, internalSecret, sessionA.userId, sessionA.serviceToken]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("web chat without a client idempotency key remains read-only", async () => {
  const calls = [];
  const handler = createChatHandler(handlerOptions({
    quotaStore: new InMemoryQuotaStore({ env: "test", now: () => fixedTime }),
    fetchImpl: successFetch(calls, {
      message: "当前请求未执行设备动作。",
      intent: "none",
      tool: undefined,
    }),
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "有哪些场景？" }),
    env: env(),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].body.scopes, ["ai:chat"]);
  assert.match(calls[0].body.idempotencyKey, /^readonly_req_/);
});

test("web chat rejects unauthenticated, oversized, foreign-home, and client-forged context", async () => {
  const handler = createChatHandler(handlerOptions({
    quotaStore: new InMemoryQuotaStore({ env: "test", now: () => fixedTime }),
    fetchImpl: async () => assert.fail("Agent must not be called"),
  }));
  const missingSession = await handler({
    request: new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeId: home.id, message: "你好" }),
    }),
    env: env(),
  });
  assert.equal(missingSession.status, 401);

  const forgedPrincipal = await handler({
    request: await chatRequest({ homeId: home.id, message: "你好", principalId: "usr_forged" }),
    env: env(),
  });
  assert.equal(forgedPrincipal.status, 400);

  const foreignHome = await handler({
    request: await chatRequest({ homeId: "home-foreign", message: "你好" }),
    env: env(),
  });
  assert.equal(foreignHome.status, 403);
  assert.equal((await foreignHome.json()).code, "AI_HOME_FORBIDDEN");

  const oversized = await handler({
    request: await chatRequest({ homeId: home.id, message: "a".repeat(9000) }),
    env: env(),
  });
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, "AI_INVALID_REQUEST");
});

test("preview chat returns a local mock without Agent or quota activity", async () => {
  const calls = [];
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(null, { status: 500 });
    },
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "打开回家模式" }),
    env: env({ AI_ENVIRONMENT: "preview" }),
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(data.conversationId, /^cv1_[A-Za-z0-9_-]+$/);
  assert.deepEqual(data, {
    requestId: "req_00000000000040008000000000000001",
    conversationId: data.conversationId,
    message: "预览模式：不会调用模型或控制真实设备。",
    intent: "none",
    quota: {
      mode: "disabled",
      remainingRequestsToday: null,
      remainingTokensThisMonth: null,
      resetAt: null,
      softLimit: true,
    },
  });
  assert.equal(calls.length, 0);
  const principalId = await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret });
  const snapshot = await quotaStore.getSnapshot(principalId);
  assert.equal(snapshot.requestsToday, 0);
  assert.equal(snapshot.totalTokensThisMonth, 0);
});

test("preview chat still enforces authentication, home, and conversation binding", async () => {
  const handler = createChatHandler(handlerOptions({
    quotaStore: new InMemoryQuotaStore({ env: "test", now: () => fixedTime }),
    fetchImpl: async () => assert.fail("Agent must not be called"),
  }));
  const previewEnv = env({ AI_ENVIRONMENT: "preview" });
  const unauthenticated = await handler({
    request: new Request("http://localhost/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ homeId: home.id, message: "你好" }),
    }),
    env: previewEnv,
  });
  assert.equal(unauthenticated.status, 401);

  const foreignHome = await handler({
    request: await chatRequest({ homeId: "home-foreign", message: "你好" }),
    env: previewEnv,
  });
  assert.equal(foreignHome.status, 403);

  const invalidConversation = await handler({
    request: await chatRequest({
      conversationId: "cv1_invalid",
      homeId: home.id,
      message: "你好",
    }),
    env: previewEnv,
  });
  assert.equal(invalidConversation.status, 400);
});

test("preview delete returns a local no-op without Agent calls", async () => {
  const createHandler = createConversationHandler(handlerOptions());
  const created = await createHandler({
    request: new Request("http://localhost/api/ai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await cookie(sessionA) },
      body: JSON.stringify({ homeId: home.id }),
    }),
    env: env({ AI_ENVIRONMENT: "preview" }),
  });
  const { conversationId } = await created.json();
  const calls = [];
  const handler = createDeleteConversationHandler(handlerOptions({
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(null, { status: 500 });
    },
  }));
  const response = await handler({
    request: new Request(`http://localhost/api/ai/conversations/${conversationId}`, {
      method: "DELETE",
      headers: { Cookie: await cookie(sessionA) },
    }),
    env: env({ AI_ENVIRONMENT: "preview" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    requestId: "req_00000000000040008000000000000001",
    conversationId,
    deleted: true,
  });
  assert.equal(calls.length, 0);
});

test("web chat releases a quota reservation when the Agent fails", async () => {
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: async () => new Response(JSON.stringify({ code: "AI_GATEWAY_AUTH_FAILED" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    }),
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "你好" }),
    env: env(),
  });

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "AI_GATEWAY_UNAVAILABLE");
  const principalId = await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret });
  const snapshot = await quotaStore.getSnapshot(principalId);
  assert.equal(snapshot.requestsToday, 0);
  assert.equal(snapshot.totalTokensThisMonth, 0);
});

test("web chat settles known model usage when the Agent fails", async () => {
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: async () => new Response(JSON.stringify({
      code: "AI_GATEWAY_RATE_LIMITED",
      usage: { promptTokens: 19, completionTokens: 7, totalTokens: 26, estimated: false },
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "你好" }),
    env: env(),
  });

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, "AI_GATEWAY_RATE_LIMITED");
  const principalId = await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret });
  const snapshot = await quotaStore.getSnapshot(principalId);
  assert.equal(snapshot.requestsToday, 1);
  assert.equal(snapshot.totalTokensThisMonth, 26);
});

test("web chat conservatively settles unknown Agent transport outcomes", async () => {
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: async () => new Response(JSON.stringify({ code: "AI_GATEWAY_TIMEOUT" }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    }),
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "你好" }),
    env: env(),
  });

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "AI_GATEWAY_TIMEOUT");
  const principalId = await derivePrincipalId(sessionA, { AI_PRINCIPAL_SECRET: principalSecret });
  const snapshot = await quotaStore.getSnapshot(principalId);
  assert.equal(snapshot.requestsToday, 1);
  assert.equal(snapshot.totalTokensThisMonth, 1036);
  assert.equal(snapshot.estimatedTokensThisMonth, 1036);
});

test("remote Agent base URLs require HTTPS except local development", () => {
  const options = { internalSecret: "x".repeat(32) };
  assert.throws(
    () => new MakersAgentClient({ ...options, baseUrl: "http://remote.example" }),
    (error) => error instanceof AgentClientError && error.code === "AI_AGENT_UNAVAILABLE",
  );
  assert.throws(
    () => new MakersAgentClient({ ...options, baseUrl: "https://user:password@example.com" }),
    (error) => error instanceof AgentClientError && error.code === "AI_AGENT_UNAVAILABLE",
  );
  assert.doesNotThrow(() => new MakersAgentClient({ ...options, baseUrl: "http://localhost:3000" }));
  assert.doesNotThrow(() => new MakersAgentClient({ ...options, baseUrl: "http://127.0.0.1:3000" }));
  assert.doesNotThrow(() => new MakersAgentClient({ ...options, baseUrl: "http://[::1]:3000" }));
});

test("web chat maps disabled execution and uncertain agent state without generic 502", async () => {
  const cases = [
    { code: "AI_SCENE_EXECUTION_DISABLED", status: 403 },
    { code: "AI_EXECUTION_STATUS_UNKNOWN", status: 409 },
    { code: "AI_AGENT_STORE_UNAVAILABLE", status: 503 },
  ];
  for (const item of cases) {
    const handler = createChatHandler(handlerOptions({
      quotaStore: new InMemoryQuotaStore({ env: "test", now: () => fixedTime }),
      fetchImpl: async () => new Response(JSON.stringify({ code: item.code }), {
        status: item.status,
        headers: { "Content-Type": "application/json" },
      }),
    }));
    const response = await handler({
      request: await chatRequest({ homeId: home.id, message: "你好" }),
      env: env(),
    });
    assert.equal(response.status, item.status);
    assert.equal((await response.json()).code, item.code);
  }
});

test("web chat returns quota retry time and honors fail-open storage policy", async () => {
  const quotaStore = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  const calls = [];
  const quotaHandler = createChatHandler(handlerOptions({ quotaStore, fetchImpl: successFetch(calls) }));
  const limitedEnv = env({ AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "1" });
  const first = await quotaHandler({
    request: await chatRequest({ homeId: home.id, message: "第一条" }),
    env: limitedEnv,
  });
  assert.equal(first.status, 200);
  const second = await quotaHandler({
    request: await chatRequest({ homeId: home.id, message: "第二条" }),
    env: limitedEnv,
  });
  assert.equal(second.status, 429);
  const limited = await second.json();
  assert.equal(limited.code, "AI_QUOTA_EXCEEDED");
  assert.equal(limited.quota.period, "day");
  assert.equal(typeof limited.quota.retryAfter, "string");

  const unavailableStore = {
    async reserve() { throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "offline"); },
    async commit() { throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "offline"); },
    async release() { throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "offline"); },
    async getSnapshot() { throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "offline"); },
  };
  const openHandler = createChatHandler(handlerOptions({
    quotaStore: unavailableStore,
    fetchImpl: successFetch([]),
  }));
  const openResponse = await openHandler({
    request: await chatRequest({ homeId: home.id, message: "只读请求" }),
    env: env({ AI_QUOTA_FAIL_MODE: "open" }),
  });
  assert.equal(openResponse.status, 200);
  assert.equal((await openResponse.json()).quota.remainingRequestsToday, null);
});

test("conversation APIs bind handles to principal/home and delete only scoped Agent memory", async () => {
  const createHandler = createConversationHandler(handlerOptions());
  const createResponse = await createHandler({
    request: new Request("http://localhost/api/ai/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: await cookie(sessionA) },
      body: JSON.stringify({ homeId: home.id }),
    }),
    env: env(),
  });
  assert.equal(createResponse.status, 201);
  assert.equal(createResponse.headers.get("Cache-Control"), "no-store");
  const { conversationId } = await createResponse.json();

  const deleteCalls = [];
  const deleteHandler = createDeleteConversationHandler(handlerOptions({
    fetchImpl: async (url, init) => {
      deleteCalls.push({ url: url.toString(), init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true,
        deleted: true,
        requestId: JSON.parse(init.body).requestId,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  }));
  const deleted = await deleteHandler({
    request: new Request(`http://localhost/api/ai/conversations/${conversationId}`, {
      method: "DELETE",
      headers: { Cookie: await cookie(sessionA) },
    }),
    env: env(),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, true);
  assert.equal(deleteCalls[0].url, "http://localhost/ai-home/delete");
  assert.equal(deleteCalls[0].body.homeId, home.id);
  assert.deepEqual(deleteCalls[0].body.scopes, ["ai:chat"]);

  const wrongUser = await deleteHandler({
    request: new Request(`http://localhost/api/ai/conversations/${conversationId}`, {
      method: "DELETE",
      headers: { Cookie: await cookie(sessionB) },
    }),
    env: env(),
  });
  assert.equal(wrongUser.status, 400);
  assert.equal(deleteCalls.length, 1);
});

test("remote agent owns quota: console never reads or mutates its local ledger", async () => {
  const calls = [];
  const quotaStore = {
    reserve() {
      throw new Error("local reserve forbidden");
    },
    commit() {
      throw new Error("local commit forbidden");
    },
    release() {
      throw new Error("local release forbidden");
    },
    getSnapshot() {
      throw new Error("local read forbidden");
    },
  };
  const handler = createChatHandler(handlerOptions({
    quotaStore,
    fetchImpl: async (url, init) => {
      const input = JSON.parse(init.body);
      return successFetch(calls, {
        quota: {
          principalId: input.principalId,
          mode: "override",
          limits: null,
          usage: null,
          remaining: {
            requestsThisMinute: 2,
            requestsToday: 7,
            tokensThisMonth: 900,
          },
          resetAt: "2026-09-18T00:00:00+08:00",
          softLimit: true,
        },
      })(url, init);
    },
  }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "查看场景" }),
    env: env({
      AI_AGENT_BASE_URL: "https://agent.example",
      AI_QUOTA_FAIL_MODE: "invalid-unused-local-config",
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.quota.remainingRequestsToday, 7);
  assert.equal(result.quota.remainingTokensThisMonth, 900);
  assert.equal(result.quota.mode, "override");
  assert.equal(result.quota.principalId, undefined);
  assert.equal(calls[0].url, "https://agent.example/ai-home");
});

test("remote quota exhaustion and outages preserve public errors without a local refund", async () => {
  const quotaStore = {
    reserve() { throw new Error("local reserve forbidden"); },
    commit() { throw new Error("local commit forbidden"); },
    release() { throw new Error("local release forbidden"); },
    getSnapshot() { throw new Error("local read forbidden"); },
  };
  const failures = [
    ["AI_QUOTA_EXCEEDED", 429],
    ["AI_QUOTA_STORE_UNAVAILABLE", 503],
    ["AI_QUOTA_CONFIG_INVALID", 500],
  ];
  for (const [code, status] of failures) {
    const handler = createChatHandler(handlerOptions({
      quotaStore,
      fetchImpl: async () => Response.json({
        code,
        quota: { period: "day", retryAfter: "2026-09-18T00:00:00+08:00" },
      }, { status }),
    }));
    const response = await handler({
      request: await chatRequest({ homeId: home.id, message: "hello" }),
      env: env({ AI_AGENT_BASE_URL: "https://agent.example" }),
    });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    if (status === 429) assert.equal(body.quota.period, "day");
  }
});

test("remote mode refuses missing quota summaries and never silently falls back", async () => {
  const handler = createChatHandler(handlerOptions({ fetchImpl: successFetch([]) }));
  const response = await handler({
    request: await chatRequest({ homeId: home.id, message: "hello" }),
    env: env({ AI_AGENT_BASE_URL: "https://agent.example" }),
  });
  assert.equal(response.status, 502);
});
