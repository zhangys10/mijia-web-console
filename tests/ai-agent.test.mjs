import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as agentOnRequest } from "../agents/ai-home/index.ts";
import { onRequest as deleteAgentConversation } from "../agents/ai-home/delete.ts";
import { onRequest as stopAgent } from "../agents/ai-home/stop.ts";
import {
  AiAgentError,
  AiAgentService,
  scopedAgentConversationId,
} from "../lib/ai/agent/ai-agent-service.ts";
import { InMemoryAgentConversationStore } from "../lib/ai/agent/agent-store.ts";
import {
  AgentIdempotencyStore,
  AgentStateIdempotencyStore,
} from "../lib/ai/agent/idempotency.ts";
import { AgentTraceCollector } from "../lib/ai/agent/tracing.ts";
import {
  AgentBindingError,
  createAgentBinding,
  verifyAgentBinding,
} from "../lib/ai/security/agent-binding.ts";
import {
  buildAgentSceneCatalog,
  parseApprovedSceneIds,
  safeScenesForModel,
} from "../lib/ai/tools/agent-scene-catalog.ts";

const sessionSecret = "agent-binding-test-secret-at-least-32-characters";
const internalSecret = "agent-internal-test-secret-at-least-32-chars";
const now = Date.now();
const principalId = "usr_agent_principal_000000000000000000";
const otherPrincipalId = "usr_agent_other_principal_00000000000000";
const homeId = "home-agent-1";
const otherHomeId = "home-agent-2";
const conversationId = "conversation-agent-001";
const idempotencyKey = "idempotency-key-000001";
const requestId = "request-000000000001";

const session = {
  userId: "raw-user-id",
  cUserId: "raw-c-user-id",
  ssecurity: "mock-ssecurity",
  serviceToken: "mock-service-token",
  region: "cn",
  deviceId: "mock-device-id",
  userAgent: "mock-user-agent",
  createdAt: now - 60_000,
};

const scenes = [
  { id: "real-scene-id", homeId, name: "回家模式", enabled: true, actionCount: 2 },
  { id: "real-other-scene-id", homeId, name: "观影模式", enabled: true, actionCount: 1 },
  { id: "real-disabled-scene-id", homeId, name: "离家模式", enabled: false, actionCount: 1 },
  { id: "real-other-home-scene-id", homeId: otherHomeId, name: "其它家庭", enabled: true, actionCount: 1 },
];

async function sceneCatalog(principal = principalId, home = homeId) {
  return buildAgentSceneCatalog({
    principalId: principal,
    homeId: home,
    scenes,
    approvedSceneIds: new Set(["real-scene-id", "real-disabled-scene-id", "real-other-home-scene-id"]),
  });
}

function toolCallDecision(alias = "scene_028b49fab86514a5", overrides = {}) {
  return {
    type: "tool_call",
    tool: "activate_scene",
    arguments: { sceneId: alias, replyMessage: "已执行回家模式" },
    model: "test-model",
    latencyMs: 1,
    usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, estimated: false },
    ...overrides,
  };
}

function noActionDecision() {
  return {
    type: "no_action",
    reason: "unsupported",
    model: "test-model",
    latencyMs: 1,
    llmOutput: "这个请求不会执行场景。",
    usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23, estimated: false },
  };
}

function createHarness(input = {}) {
  const providerDecisions = input.providerDecisions ?? [toolCallDecision()];
  const providerHistories = [];
  let executionCount = 0;
  const sceneRecords = input.sceneRecords ?? null;
  const store = input.store ?? new InMemoryAgentConversationStore();
  const idempotency = input.idempotency ?? new AgentIdempotencyStore(600_000, () => now);
  const trace = new AgentTraceCollector();
  const service = new AiAgentService({
    provider: {
      decide: async (message, safeScenes, locale, timezone, history) => {
        providerHistories.push({ message, safeScenes: [...safeScenes], locale, timezone, history: [...history] });
        const decision = providerDecisions[providerHistories.length - 1] ?? noActionDecision();
        return decision;
      },
    },
    loadScenes: async (loadInput) => sceneRecords ?? sceneCatalog(loadInput.principalId, loadInput.homeId),
    executeScene: async (executionInput) => {
      executionCount += 1;
      assert.equal(executionInput.session, session);
      return { status: "success", succeeded: 1, failed: 0, message: "已开启「回家模式」。" };
    },
    store,
    idempotency,
    trace,
  });
  return { service, providerHistories, get executionCount() { return executionCount; }, store, idempotency, trace };
}

async function bindingPayload(principal = principalId, home = homeId, scopes = ["ai:chat", "scene:activate"]) {
  return {
    version: 1,
    kind: "ai_agent_binding",
    principalId: principal,
    homeId: home,
    scopes,
    session,
    issuedAt: now - 60_000,
    expiresAt: now + 300_000,
  };
}

function runInput(overrides = {}) {
  return {
    requestId,
    conversationId,
    message: "请执行回家模式",
    idempotencyKey,
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    binding: null,
    ...overrides,
  };
}

async function scopedConversationId(principal = principalId, home = homeId) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${conversationId}:${principal}:${home}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `agent_${hex.slice(0, 24)}`;
}

test("agent binding is sealed, scoped, expiring, and mismatch-rejecting", async () => {
  const token = await createAgentBinding(
    { principalId, homeId, scopes: ["scene:activate", "ai:chat"], session, issuedAt: now - 60_000, expiresAt: now + 300_000 },
    sessionSecret,
  );
  const payload = await verifyAgentBinding(
    token,
    { principalId, homeId, scopes: ["ai:chat", "scene:activate"], now },
    sessionSecret,
  );

  assert.equal(token.includes("raw-user-id"), false);
  assert.equal(payload.principalId, principalId);
  assert.equal(payload.homeId, homeId);
  assert.deepEqual(payload.scopes, ["ai:chat", "scene:activate"]);

  await assert.rejects(
    () => verifyAgentBinding(token, { principalId: otherPrincipalId, homeId, now }, sessionSecret),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_MISMATCH",
  );
  await assert.rejects(
    () => verifyAgentBinding(token, { principalId, homeId: otherHomeId, now }, sessionSecret),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_MISMATCH",
  );
  await assert.rejects(
    () => verifyAgentBinding(token, { principalId, homeId, now: now + 300_000 }, sessionSecret),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_EXPIRED",
  );
  await assert.rejects(
    () => verifyAgentBinding("invalid-binding-token", { principalId, homeId, now }, sessionSecret),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_INVALID",
  );
  await assert.rejects(
    () => verifyAgentBinding(token, { principalId, homeId, now }, "wrong-agent-binding-secret"),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_INVALID",
  );
  await assert.rejects(
    () => createAgentBinding({ principalId, homeId, session, issuedAt: now, expiresAt: now }, sessionSecret),
    (error) => error instanceof AgentBindingError && error.code === "AI_AGENT_BINDING_INVALID",
  );
});

test("scene catalog only exposes reviewed scenes as principal and home-scoped aliases", async () => {
  const approved = parseApprovedSceneIds(" real-scene-id , real-disabled-scene-id ,, ");
  const catalog = await sceneCatalog();
  const safeScenes = safeScenesForModel(catalog);
  const serialized = JSON.stringify(safeScenes);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].sceneId, "real-scene-id");
  assert.equal(catalog[0].homeId, homeId);
  assert.equal(catalog[0].reviewStatus, "approved");
  assert.equal(catalog[0].riskLevel, "low");
  assert.match(catalog[0].alias, /^scene_[0-9a-f]{16}$/);
  assert.equal(serialized.includes("real-scene-id"), false);
  assert.equal(serialized.includes("raw-user-id"), false);
  assert.deepEqual(safeScenes, [{
    id: catalog[0].alias,
    name: "回家模式",
    description: "当前家庭已审核的低风险手动场景：回家模式",
  }]);
  assert.equal(approved.has("real-scene-id"), true);
  assert.equal(approved.size, 2);

  const otherPrincipalCatalog = await sceneCatalog(otherPrincipalId);
  assert.notEqual(otherPrincipalCatalog[0].alias, catalog[0].alias);
});

test("same principal keeps conversation continuity across runs", async () => {
  const harness = createHarness({ providerDecisions: [noActionDecision(), toolCallDecision()] });
  const binding = await bindingPayload();
  await harness.service.run(runInput({ binding, message: "我还没回家" }));
  await harness.service.run(runInput({
    binding,
    idempotencyKey: "idempotency-key-000002",
    message: "现在执行回家模式",
  }));

  assert.equal(harness.providerHistories[0].history.length, 0);
  assert.equal(harness.providerHistories[1].history.length, 2);
  assert.deepEqual(
    harness.providerHistories[1].history.map((item) => item.role),
    ["user", "assistant"],
  );
  assert.equal(harness.executionCount, 1);
  assert.deepEqual(harness.trace.events.map((event) => event.type), ["model_call", "model_call", "tool_call"]);
});

test("the same conversation ID is isolated by principal and home", async () => {
  const harness = createHarness({ providerDecisions: [noActionDecision(), noActionDecision()] });
  await harness.service.run(runInput({
    binding: await bindingPayload(),
    idempotencyKey: "idempotency-key-000003",
    message: "第一个用户",
  }));
  await harness.service.run(runInput({
    binding: await bindingPayload(otherPrincipalId),
    idempotencyKey: "idempotency-key-000003",
    message: "第二个用户",
  }));

  assert.equal(harness.providerHistories[0].history.length, 0);
  assert.equal(harness.providerHistories[1].history.length, 0);
  assert.notEqual(
    JSON.stringify(harness.providerHistories[0].safeScenes),
    JSON.stringify(harness.providerHistories[1].safeScenes),
  );
});

test("forged tool names, scene IDs, scopes, and idempotency keys cannot execute", async () => {
  const binding = await bindingPayload();
  const cases = [
    {
      label: "unsupported tool",
      decision: toolCallDecision("scene-alias", { tool: "delete_everything" }),
      expectedCode: "UNSUPPORTED_TOOL",
    },
    {
      label: "unknown scene alias",
      decision: toolCallDecision("scene_forged_alias"),
      expectedCode: "AI_SCENE_NOT_FOUND",
    },
    {
      label: "short idempotency key",
      idempotencyKey: "short-key",
      expectedCode: "AI_INVALID_REQUEST",
    },
  ];

  for (const item of cases) {
    const harness = createHarness({ providerDecisions: [item.decision ?? toolCallDecision()] });
    await assert.rejects(
      () => harness.service.run(runInput({ binding, ...item })),
      (error) => error instanceof AiAgentError && error.code === item.expectedCode,
    );
    assert.equal(harness.executionCount, 0);
  }

  const scopedHarness = createHarness();
  const chatOnlyBinding = await bindingPayload(principalId, homeId, ["ai:chat"]);
  await assert.rejects(
    () => scopedHarness.service.run(runInput({
      binding: chatOnlyBinding,
    })),
    (error) => error instanceof AiAgentError && error.code === "AI_SCOPE_FORBIDDEN",
  );
  assert.equal(scopedHarness.executionCount, 0);
});

test("negative, conditional, question, and paraphrased intents stay read-only", async () => {
  const harness = createHarness({
    providerDecisions: [noActionDecision(), noActionDecision(), noActionDecision(), noActionDecision()],
  });
  const binding = await bindingPayload();
  const inputs = [
    ["我还没回家", "idempotency-key-000004"],
    ["如果我回家了再执行", "idempotency-key-000005"],
    ["你刚才执行了什么？", "idempotency-key-000006"],
    ["有人说应该执行回家模式", "idempotency-key-000007"],
  ];

  for (const [message, key] of inputs) {
    const result = await harness.service.run(runInput({ binding, message, idempotencyKey: key }));
    assert.equal(result.intent, "none");
  }
  assert.equal(harness.executionCount, 0);
});

test("one idempotency key executes a matching request only once", async () => {
  const harness = createHarness({ providerDecisions: [toolCallDecision(), noActionDecision()] });
  const binding = await bindingPayload();
  const input = runInput({ binding });
  const first = await harness.service.run(input);
  const second = await harness.service.run(input);

  assert.deepEqual(second, first);
  assert.equal(harness.providerHistories.length, 1);
  assert.equal(harness.executionCount, 1);
  const messages = await harness.store.getMessages({
    conversationId: await scopedConversationId(),
    limit: 100,
  });
  assert.equal(messages.length, 2);

  await assert.rejects(
    () => harness.service.run(runInput({
      binding,
      message: "不同请求复用幂等键",
    })),
    (error) => error instanceof AiAgentError && error.code === "AI_IDEMPOTENCY_CONFLICT",
  );
});

function stateStore() {
  const values = new Map();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

test("state-backed idempotency is principal-scoped and persists a completed response", async () => {
  const state = stateStore();
  const binding = await bindingPayload();
  const idempotency = new AgentStateIdempotencyStore(state, 600_000, () => now);
  const harness = createHarness({ idempotency });
  const first = await harness.service.run(runInput({ binding }));
  const stateKeys = [...state.values.keys()];

  assert.equal(stateKeys.length, 1);
  assert.match(stateKeys[0], /^idempotency:/);
  assert.equal(stateKeys[0].includes(conversationId), false);

  const replayHarness = createHarness({ idempotency });
  const replay = await replayHarness.service.run(runInput({ binding }));
  assert.deepEqual(replay, first);
  assert.equal(replayHarness.executionCount, 0);

  const otherPrincipalState = createHarness({ idempotency, providerDecisions: [noActionDecision()] });
  await otherPrincipalState.service.run(runInput({
    binding: await bindingPayload(otherPrincipalId),
  }));
  assert.equal(state.values.size, 2);
});

function agentContext(overrides = {}) {
  return {
    request: {
      method: "POST",
      body: {},
      headers: {},
      ...overrides.request,
    },
    env: {
      XIAOMI_SESSION_SECRET: sessionSecret,
      AI_AGENT_INTERNAL_SECRET: internalSecret,
      ...overrides.env,
    },
    conversation_id: overrides.conversation_id ?? conversationId,
    store: overrides.store,
    utils: overrides.utils,
  };
}

test("agent endpoint validates method, conversation header, and internal authorization", async () => {
  const responses = [];
  responses.push(await agentOnRequest(agentContext({ request: { method: "GET" } })));
  responses.push(await agentOnRequest(agentContext({ request: { headers: { Authorization: `Bearer ${internalSecret}` } } })));
  responses.push(await agentOnRequest(agentContext({
    request: { headers: { Authorization: "Bearer wrong-secret" } },
  })));
  responses.push(await agentOnRequest(agentContext({
    request: { headers: { Authorization: "Bearer short" } },
  })));
  responses.push(await agentOnRequest(agentContext({
    request: { headers: { Authorization: `Bearer ${internalSecret}` } },
  })));

  assert.deepEqual(responses.map((response) => response.status), [405, 400, 401, 401, 400]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(bodies[0].code, "AI_INVALID_REQUEST");
  assert.equal(bodies[1].code, "AI_INVALID_REQUEST");
  assert.equal(bodies[2].code, "AI_UNAUTHENTICATED");
  assert.equal(bodies[3].code, "AI_UNAUTHENTICATED");
  assert.equal(bodies[4].code, "AI_INVALID_REQUEST");
  assert.equal(bodies.every((body) => JSON.stringify(body).includes(internalSecret)), false);
});

test("agent endpoint requires a matching sealed binding", async () => {
  const sessionBinding = await createAgentBinding({
    principalId,
    homeId,
    session,
    issuedAt: now - 60_000,
    expiresAt: now + 300_000,
  }, sessionSecret);
  const context = agentContext({
    request: {
      body: {
        requestId,
        principalId,
        homeId,
        message: "请执行回家模式",
        idempotencyKey,
        sessionBinding,
        scopes: ["ai:chat", "scene:activate"],
      },
      headers: { Authorization: `Bearer ${internalSecret}` },
    },
    conversation_id: conversationId,
  });

  const response = await agentOnRequest(context);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "AI_AGENT_STORE_UNAVAILABLE");

  context.request.body.principalId = otherPrincipalId;
  const mismatch = await agentOnRequest(context);
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).code, "AI_AGENT_BINDING_MISMATCH");

  context.request.body.principalId = principalId;
  context.request.body.homeId = otherHomeId;
  const homeMismatch = await agentOnRequest(context);
  assert.equal(homeMismatch.status, 403);
  assert.equal((await homeMismatch.json()).code, "AI_AGENT_BINDING_MISMATCH");
});

test("stop endpoint follows the official header and body contract and aborts the active run", async () => {
  const stoppedIds = [];
  const context = agentContext({
    request: {
      body: { conversation_id: conversationId },
      headers: { "Makers-Conversation-Id": conversationId, Authorization: `Bearer ${internalSecret}` },
    },
    utils: { abortActiveRun: async (conversationIdToStop) => {
      stoppedIds.push(conversationIdToStop);
      return true;
    } },
  });
  const response = await stopAgent(context);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stopped: true });
  assert.deepEqual(stoppedIds, [conversationId]);

  const methodResponse = await stopAgent(agentContext({ request: { method: "GET" } }));
  assert.equal(methodResponse.status, 405);
  const authResponse = await stopAgent(agentContext({ request: { body: { conversation_id: conversationId } } }));
  assert.equal(authResponse.status, 401);
  const invalidResponse = await stopAgent(agentContext({
    request: { body: { conversation_id: "bad" }, headers: { Authorization: `Bearer ${internalSecret}` } },
  }));
  assert.equal(invalidResponse.status, 400);
  const unavailableResponse = await stopAgent(agentContext({
    request: { body: { conversationId }, headers: { Authorization: `Bearer ${internalSecret}` } },
    utils: {},
  }));
  assert.equal(unavailableResponse.status, 503);
});

// The embedded Makers runtime store implements deleteConversation({ conversationId }) -> void and
// throws MemoryNotFoundError (as error.code on a plain Error) when the conversation is absent.
function makersRuntimeStore() {
  const legacy = new InMemoryAgentConversationStore();
  return {
    getMessages: legacy.getMessages.bind(legacy),
    appendMessage: legacy.appendMessage.bind(legacy),
    getConversation: legacy.getConversation.bind(legacy),
    updateConversation: legacy.updateConversation.bind(legacy),
    deleteConversation: async ({ conversationId }) => {
      const existing = await legacy.getMessages({ conversationId, limit: 100 });
      if (existing.length === 0) {
        const error = new Error(`conversation ${conversationId} not found`);
        error.code = "MemoryNotFoundError";
        throw error;
      }
      await legacy.deleteConversation(conversationId);
    },
  };
}

test("delete endpoint verifies the binding and clears only the scoped conversation", async () => {
  const store = makersRuntimeStore();
  const scopedId = await scopedAgentConversationId(conversationId, principalId, homeId);
  const otherScopedId = await scopedAgentConversationId(conversationId, otherPrincipalId, homeId);
  await store.appendMessage({ conversationId: scopedId, role: "user", content: "需要删除" });
  await store.appendMessage({ conversationId: otherScopedId, role: "user", content: "必须保留" });
  const sessionBinding = await createAgentBinding({
    principalId,
    homeId,
    scopes: ["ai:chat"],
    session,
    issuedAt: now - 60_000,
    expiresAt: now + 300_000,
  }, sessionSecret);
  const response = await deleteAgentConversation(agentContext({
    request: {
      body: {
        requestId,
        principalId,
        homeId,
        scopes: ["ai:chat"],
        sessionBinding,
      },
      headers: { Authorization: `Bearer ${internalSecret}` },
    },
    store,
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true, requestId });
  assert.deepEqual(await store.getMessages({ conversationId: scopedId, limit: 10 }), []);
  assert.equal((await store.getMessages({ conversationId: otherScopedId, limit: 10 })).length, 1);

  const mismatch = await deleteAgentConversation(agentContext({
    request: {
      body: {
        requestId,
        principalId: otherPrincipalId,
        homeId,
        scopes: ["ai:chat"],
        sessionBinding,
      },
      headers: { Authorization: `Bearer ${internalSecret}` },
    },
    store,
  }));
  assert.equal(mismatch.status, 403);
  assert.equal((await mismatch.json()).code, "AI_AGENT_BINDING_MISMATCH");

  const repeat = await deleteAgentConversation(agentContext({
    request: {
      body: {
        requestId,
        principalId,
        homeId,
        scopes: ["ai:chat"],
        sessionBinding,
      },
      headers: { Authorization: `Bearer ${internalSecret}` },
    },
    store,
  }));
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { ok: true, deleted: false, requestId });
});
