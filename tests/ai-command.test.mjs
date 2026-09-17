import assert from "node:assert/strict";
import test from "node:test";

import { computePrincipalId, sealAutomationToken } from "../lib/ai/security/automation-token.ts";
import { verifyShortcutAuth } from "../lib/ai/security/auth.ts";
import { createAiBindingToken, verifyAndExtractBinding } from "../lib/ai/security/binding.ts";
import { IdempotencyStore, isValidIdempotencyKey, requestHash } from "../lib/ai/security/idempotency.ts";
import { findFallbackScene } from "../lib/ai/fallback.ts";
import { validateToolCall } from "../lib/ai/tools/tool-validator.ts";
import { IntentOrchestrator, runtimeScenes } from "../lib/ai/intent-orchestrator.ts";
import { loadAiCommandConfig } from "../lib/ai/config.ts";
import { allowedScenes, staticAllowedScenes } from "../lib/ai/scenes/catalog.ts";
import { SceneService } from "../lib/ai/scenes/scene-service.ts";

test("shortcut authentication accepts only the exact bearer token hash", async () => {
  const token = "a".repeat(32);
  const hash = await verifyShortcutAuth(`Bearer ${token}`, (await import("node:crypto")).createHash("sha256").update(token).digest("hex"));
  assert.equal(hash, true);
  assert.equal(await verifyShortcutAuth(`Bearer ${"b".repeat(32)}`, (await import("node:crypto")).createHash("sha256").update(token).digest("hex")), false);
  assert.equal(await verifyShortcutAuth(null, "abc"), false);
});

test("ai binding token is user scoped and cannot be forged", async () => {
  const session = {
    userId: "user-a",
    cUserId: "c-user-a",
    ssecurity: "unused-in-test",
    serviceToken: "unused-in-test",
    region: "cn",
    deviceId: "device-a",
    userAgent: "test-agent",
    createdAt: Date.now(),
  };
  process.env.XIAOMI_SESSION_SECRET = "ai-binding-test-secret-with-at-least-32-characters";
  const token = await createAiBindingToken(session, "home-a");
  const binding = await verifyAndExtractBinding(token);
  assert.equal(binding.kind, "siri_binding");
  assert.equal(binding.userId, "user-a");
  assert.equal(binding.homeId, "home-a");
    assert.equal(await verifyAndExtractBinding("not-a-token"), null);
  assert.equal(await verifyAndExtractBinding("fake.iv.ciphertext"), null);
});

test("idempotency store replays completed records and rejects body conflicts", () => {
  const store = new IdempotencyStore(1000);
  const body = { text: "我回家了" };
  const hash = requestHash(body);
  assert.equal(store.lookup("1234567890abcdef", hash), "miss");
  store.start("1234567890abcdef", hash);
  assert.equal(store.lookup("1234567890abcdef", hash), "processing");
  store.complete("1234567890abcdef", { ok: true });
  assert.equal(store.lookup("1234567890abcdef", hash), "completed");
  assert.deepEqual(store.get("1234567890abcdef")?.response, { ok: true });
  assert.equal(store.lookup("1234567890abcdef", requestHash({ text: "不同请求" })), "conflict");
});

test("deterministic fallback matches only an available home-like scene", () => {
  const scenes = [
    { id: "scene-1", name: "观影", enabled: true },
    { id: "scene-2", name: "到家", enabled: true },
    { id: "scene-3", name: "回家", enabled: false },
  ];
  assert.equal(findFallbackScene("我到家了", scenes)?.id, "scene-2");
  assert.equal(findFallbackScene("我还没回家", scenes), undefined);
  assert.equal(findFallbackScene("如果我回家了怎么办", scenes), undefined);
  assert.equal(findFallbackScene("回家模式是什么", scenes), undefined);
  assert.equal(findFallbackScene("他说他回家了", scenes), undefined);
  assert.equal(findFallbackScene("不要开启回家模式", scenes), undefined);
  assert.equal(findFallbackScene("有点暗", scenes), undefined);
});

test("tool validation rejects unknown tools and unlisted scene ids", () => {
  const scenes = runtimeScenes([
    { id: "scene-1", name: "观影", enabled: true },
    { id: "scene-2", name: "回家", enabled: true },
    { id: "scene-3", name: "禁用", enabled: false },
  ]);
  assert.deepEqual(validateToolCall({ name: "activate_scene", arguments: { sceneId: "scene-2" } }, scenes), {
    valid: true,
    sceneId: "scene-2",
    sceneName: "回家",
  });
  assert.equal(validateToolCall({ name: "turn_off_light", arguments: { sceneId: "scene-2" } }, scenes).valid, false);
  assert.equal(validateToolCall({ name: "activate_scene", arguments: { sceneId: "away" } }, scenes).valid, false);
  assert.equal(validateToolCall({ name: "activate_scene", arguments: {} }, scenes).valid, false);
  assert.equal(validateToolCall({ name: "activate_scene", arguments: { sceneId: "scene-3" } }, scenes).valid, false);
});

class FakeProvider {
  constructor(decision) {
    this.decision = decision;
    this.calls = [];
  }
  async decide(text, scenes, locale, timezone, history, credential) {
    this.calls.push({ text, scenes, locale, timezone, history, credential });
    if (this.decision instanceof Error) throw this.decision;
    return this.decision;
  }
}

test("intent orchestrator lets llm select a runtime scene and rejects hallucinations", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const scenes = runtimeScenes([
    { id: "scene-home", name: "回家", enabled: true },
    { id: "scene-movie", name: "观影", enabled: true },
  ]);

  const provider = new FakeProvider({
    type: "tool_call",
    tool: "activate_scene",
    arguments: { sceneId: "scene-home" },
    model: "test",
    latencyMs: 1,
  });
  const decision = await new IntentOrchestrator(provider, config).decide("我到家了", scenes, "zh-CN", "Asia/Shanghai");
  assert.equal(decision.type, "tool_call");
  assert.equal(decision.arguments.sceneId, "scene-home");
  assert.deepEqual(provider.calls[0].scenes.map(scene => scene.id), ["scene-home", "scene-movie"]);

  const hallucinated = new FakeProvider({
    type: "tool_call",
    tool: "activate_scene",
    arguments: { sceneId: "not-listed" },
    model: "test",
    latencyMs: 1,
  });
  await assert.rejects(new IntentOrchestrator(hallucinated, config).decide("开灯", scenes, "zh-CN", "Asia/Shanghai"), /UNSUPPORTED_INTENT/);
});

test("deterministic fallback only runs after llm provider failure", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const scenes = runtimeScenes([{ id: "scene-home", name: "到家", enabled: true }]);
  const provider = new FakeProvider({ type: "no_action", reason: "unsupported", model: "test", latencyMs: 1 });
  const decision = await new IntentOrchestrator(provider, config).decide("我到家了", scenes, "zh-CN", "Asia/Shanghai");
  assert.equal(decision.type, "no_action");
  assert.equal(provider.calls.length, 1);

  const timeout = new FakeProvider(new Error("LLM_TIMEOUT"));
  const fallback = await new IntentOrchestrator(timeout, config).decide("我到家了", scenes, "zh-CN", "Asia/Shanghai");
  assert.equal(fallback.type, "tool_call");
  assert.equal(fallback.model, "deterministic_fallback");
  assert.equal(fallback.arguments.sceneId, "scene-home");
});

test("scene service exposes only enabled runtime scenes", async () => {
  assert.deepEqual(staticAllowedScenes.map(scene => scene.id), ["home"]);
  assert.equal(allowedScenes.length, 0);
  class FakeExecutor {
    constructor() { this.calls = []; }
    async execute(sceneId, requestId) {
      this.calls.push({ sceneId, requestId });
      return { status: "success", succeeded: 1, failed: 0, message: "ok" };
    }
  }
  const executor = new FakeExecutor();
  const scenes = runtimeScenes([
    { id: "scene-home", name: "回家", enabled: true },
    { id: "scene-disabled", name: "禁用", enabled: false },
  ]);
  const service = new SceneService(executor, scenes);
  const result = await service.activate("scene-home", "request-1");
  assert.equal(result.status, "success");
  assert.deepEqual(executor.calls, [{ sceneId: "scene-home", requestId: "request-1" }]);
  assert.equal((await service.activate("scene-disabled", "request-1")).succeeded, 0);
});

test("ai command route rejects GET before auth but reports supported methods", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-command-methods-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  const getResponse = await worker.fetch(new Request("http://localhost/api/ai/command"), env, context);
  assert.equal(getResponse.status, 200);
  const getJson = await getResponse.json();
  assert.equal(getJson.status, "ok");
  assert.match(getJson.message, /POST/);

  const optionsResponse = await worker.fetch(new Request("http://localhost/api/ai/command", { method: "OPTIONS" }), env, context);
  assert.equal(optionsResponse.status, 204);
  assert.equal(optionsResponse.headers.get("Allow"), "GET, POST, OPTIONS");
});

test("ai command route validates explicit home parameter", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-command-home-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  // 1. home 参数过长应当被 400 拦截
  const resInvalid = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": "Bearer fake",
      "Idempotency-Key": "20260916000000-0000001",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "我回家了",
      home: "a".repeat(101),
    }),
  }), env, context);

  // 未授权时先返回 401
  assert.equal(resInvalid.status, 401);
});

import {
  sealConversationContext,
  unsealConversationContext,
  normalizeHistory,
  appendConversationTurns,
  toChatMessages,
} from "../lib/ai/security/conversation.ts";

test("conversation context sealing and unsealing preserves turns and respects TTL", async () => {
  process.env.XIAOMI_SESSION_SECRET = "ai-binding-test-secret-with-at-least-32-characters";
  const initialTurns = [
    { role: "user", content: "我想开个模式", timestamp: Date.now() - 2000 },
    { role: "assistant", content: "请问您想开启回家模式还是离家模式？", timestamp: Date.now() - 1000 },
  ];

  const token = await sealConversationContext("conv-123", initialTurns, "user-a", "home-1");
  assert.ok(token);

  const unsealed = await unsealConversationContext(token);
  assert.ok(unsealed);
  assert.equal(unsealed.conversationId, "conv-123");
  assert.equal(unsealed.userId, "user-a");
  assert.equal(unsealed.homeId, "home-1");
  assert.equal(unsealed.turns.length, 2);
  assert.equal(unsealed.turns[0].content, "我想开个模式");
  assert.equal(unsealed.turns[1].content, "请问您想开启回家模式还是离家模式？");
  assert.deepEqual(toChatMessages(unsealed.turns), [
    { role: "user", content: "我想开个模式" },
    { role: "assistant", content: "请问您想开启回家模式还是离家模式？" },
  ]);

  // Invalid token
  assert.equal(await unsealConversationContext("invalid-token"), null);

  // Appending turns limits window to 5 rounds (10 messages) by default
  let turns = initialTurns;
  for (let i = 0; i < 6; i++) {
    turns = appendConversationTurns(turns, `用户问题 ${i}`, `助手回答 ${i}`);
  }
  assert.equal(turns.length, 10);
  assert.equal(turns[turns.length - 1].content, "助手回答 5");
});

test("normalizeHistory validates roles and trims content", () => {
  assert.equal(normalizeHistory(undefined), undefined);
  assert.equal(normalizeHistory("not an array"), null);
  assert.equal(normalizeHistory([{ role: "system", content: "hack" }]), null);
  assert.equal(normalizeHistory([{ role: "user", content: 123 }]), null);
  assert.equal(normalizeHistory([{ role: "user", content: "" }]), null);

  const valid = normalizeHistory([
    { role: "user", content: " 你好 " },
    { role: "assistant", content: "你好！有什么我可以帮您？" },
  ]);
  assert.deepEqual(valid, [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！有什么我可以帮您？" },
  ]);
});

test("intent orchestrator forwards multi-turn conversation history to provider", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const scenes = runtimeScenes([
    { id: "scene-home", name: "回家", enabled: true },
    { id: "scene-away", name: "离家", enabled: true },
  ]);

  const history = [
    { role: "user", content: "有哪些模式可以开？" },
    { role: "assistant", content: "目前支持开启回家模式和离家模式。" },
  ];

  const provider = new FakeProvider({
    type: "tool_call",
    tool: "activate_scene",
    arguments: { sceneId: "scene-away", replyMessage: "已开启离家模式" },
    model: "test",
    latencyMs: 1,
  });

  const orchestrator = new IntentOrchestrator(provider, config);
  const decision = await orchestrator.decide("那帮我开离家吧", scenes, "zh-CN", "Asia/Shanghai", history);
  assert.equal(decision.type, "tool_call");
  assert.equal(decision.arguments.sceneId, "scene-away");
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0].history, history);
});

test("ai command route validates conversation parameters", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-command-conv-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  process.env.XIAOMI_SESSION_SECRET = "ai-binding-test-secret-with-at-least-32-characters";
  const session = {
    userId: "user-a",
    cUserId: "c-user-a",
    ssecurity: "unused",
    serviceToken: "unused",
    region: "cn",
    deviceId: "device-a",
    userAgent: "test-agent",
    createdAt: Date.now(),
  };
  const token = await createAiBindingToken(session, "home-a");

  // 1. conversationId 过长拦截 (400)
  const resTooLongConv = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": "20260916000000-0000002",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "我回家了",
      conversationId: "c".repeat(129),
    }),
  }), env, context);
  assert.equal(resTooLongConv.status, 400);
  const jsonConv = await resTooLongConv.json();
  assert.equal(jsonConv.code, "INVALID_REQUEST");
  assert.match(jsonConv.message, /会话标识/);

  // 2. 畸形 history 拦截 (400)
  const resBadHistory = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": "20260916000000-0000003",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: "我回家了",
      history: [{ role: "system", content: "illegal" }],
    }),
  }), env, context);
  assert.equal(resBadHistory.status, 400);
  const jsonHistory = await resBadHistory.json();
  assert.equal(jsonHistory.code, "INVALID_REQUEST");
  assert.match(jsonHistory.message, /历史对话/);
});

import {
  evaluateConversationState,
} from "../lib/ai/security/conversation.ts";
import {
  sanitizeUserFacingMessage,
  sanitizeLlmOutput,
} from "../lib/ai/tools/tool-validator.ts";
import {
  recoverIntentFromTextOrLlmOutput,
} from "../lib/ai/fallback.ts";

test("evaluateConversationState enforces configurable max rounds and signals session reset", () => {
  const maxRounds = 5;
  // 0 完成轮数 -> turnIndex 1
  const s0 = evaluateConversationState([], maxRounds);
  assert.equal(s0.isReset, false);
  assert.equal(s0.currentTurnIndex, 1);

  // 4 完成轮数 (8 条消息) -> turnIndex 5
  const eightTurns = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`,
    timestamp: Date.now(),
  }));
  const s4 = evaluateConversationState(eightTurns, maxRounds);
  assert.equal(s4.isReset, false);
  assert.equal(s4.currentTurnIndex, 5);

  // 5 完成轮数 (10 条消息) -> 超过设定上限，强制重置
  const tenTurns = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`,
    timestamp: Date.now(),
  }));
  const s5 = evaluateConversationState(tenTurns, maxRounds);
  assert.equal(s5.isReset, true);
  assert.equal(s5.currentTurnIndex, 1);
  assert.equal(s5.effectivePriorTurns.length, 0);
});

test("sanitizeUserFacingMessage and sanitizeLlmOutput strip raw scene IDs and replace with names", () => {
  const scenes = [{ id: "2091417579243446272", name: "明亮模式" }];

  const sanitizedMsg = sanitizeUserFacingMessage("好的，已经为您开启 2091417579243446272。", scenes);
  assert.equal(sanitizedMsg, "好的，已经为您开启 明亮模式。");
  assert.equal(sanitizedMsg.includes("2091417579243446272"), false);

  const sanitizedLlm = sanitizeLlmOutput('call activate_scene({"sceneId": "2091417579243446272"})', scenes);
  assert.ok(sanitizedLlm);
  assert.equal(sanitizedLlm.includes("2091417579243446272"), false);
  assert.match(sanitizedLlm, /明亮模式/);
});

test("recoverIntentFromTextOrLlmOutput fixes LLM fake execution claiming scene opened with no_action", () => {
  const scenes = [
    { id: "s-bright", name: "明亮模式", enabled: true },
    { id: "s-away", name: "离家模式", enabled: true },
  ];

  // 1. LLM 文本谎称已经打开明亮模式，实际应被恢复为 activate_scene
  const recoveredFromLlm = recoverIntentFromTextOrLlmOutput("开一下", "好的，已经为您打开明亮模式。", scenes);
  assert.ok(recoveredFromLlm);
  assert.equal(recoveredFromLlm.scene.id, "s-bright");

  // 2. 用户明确说“打开明亮模式”，即使 LLM 回复未调工具，也应被恢复
  const recoveredFromUser = recoverIntentFromTextOrLlmOutput("打开明亮模式", "为您查询中", scenes);
  assert.ok(recoveredFromUser);
  assert.equal(recoveredFromUser.scene.id, "s-bright");

  // 3. 否定句严禁恢复
  assert.equal(recoverIntentFromTextOrLlmOutput("不要开明亮模式", "好的", scenes), undefined);
  assert.equal(recoverIntentFromTextOrLlmOutput("我还没到家", "好的", scenes), undefined);

  // 4. 疑问句严禁恢复
  assert.equal(recoverIntentFromTextOrLlmOutput("明亮模式是什么意思？", "明亮模式是调亮灯光", scenes), undefined);
});

test("intent orchestrator recovers tool call when llm returns no_action but text claims opened scene", async () => {
  const config = loadAiCommandConfig();
  const scenes = runtimeScenes([
    { id: "scene-bright", name: "明亮模式", enabled: true },
  ]);

  // 模拟 LLM 发生假执行故障：口头说“已经打开明亮模式”，但未触发 toolCall (type: no_action)
  const fakeHallucinatingProvider = new FakeProvider({
    type: "no_action",
    reason: "unsupported",
    model: "test-model",
    latencyMs: 10,
    llmOutput: "已经打开明亮模式。",
  });

  const orchestrator = new IntentOrchestrator(fakeHallucinatingProvider, config);
  const decision = await orchestrator.decide("打开明亮模式", scenes, "zh-CN", "Asia/Shanghai");

  // 验证故障被 Orchestrator 自动纠正为 tool_call，避免 intent: none 导致设备不动作
  assert.equal(decision.type, "tool_call");
  assert.equal(decision.arguments.sceneId, "scene-bright");
  assert.match(decision.arguments.replyMessage, /明亮模式/);
});

test("isValidIdempotencyKey accepts only 16-128 character strings", () => {
  assert.equal(isValidIdempotencyKey(undefined), false);
  assert.equal(isValidIdempotencyKey(null), false);
  assert.equal(isValidIdempotencyKey(""), false);
  assert.equal(isValidIdempotencyKey("a".repeat(15)), false);
  assert.equal(isValidIdempotencyKey("a".repeat(16)), true);
  assert.equal(isValidIdempotencyKey("a".repeat(128)), true);
  assert.equal(isValidIdempotencyKey("a".repeat(129)), false);
});

test("ai command route does not require Idempotency-Key before a tool call is triggered", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-command-idempotency-${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };

  process.env.XIAOMI_SESSION_SECRET = "ai-binding-test-secret-with-at-least-32-characters";
  process.env.AI_AUTOMATION_TOKEN_SECRET = "ai-binding-test-secret-with-at-least-32-characters";
  const session = {
    userId: "user-a",
    cUserId: "c-user-a",
    ssecurity: "unused",
    serviceToken: "unused",
    region: "cn",
    deviceId: "device-a",
    userAgent: "test-agent",
    createdAt: Date.now(),
  };
  const principalId = await computePrincipalId("cn", session.userId);
  const token = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: session,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-user-a-key",
    homeId: "home-a",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  }, { env: "test" });

  // 缺少 Idempotency-Key 时不应在入口被 400 拦截；请求应继续进入后续处理阶段
  const resWithoutKey = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了", locale: "zh-CN", timezone: "Asia/Shanghai" }),
  }), env, context);
  const jsonWithoutKey = await resWithoutKey.json();
  assert.notEqual(resWithoutKey.status, 400);
  assert.notEqual(jsonWithoutKey.code, "INVALID_REQUEST");

  // 提供合法 Idempotency-Key 时同样继续处理，行为不受影响
  const resWithKey = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": "20260916000000-0000009",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了", locale: "zh-CN", timezone: "Asia/Shanghai" }),
  }), env, context);
  assert.notEqual(resWithKey.status, 400);

  // 畸形 Idempotency-Key 也不应在入口拦截（真正校验发生在触发 tool call 时）
  const resMalformedKey = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Idempotency-Key": "short",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了", locale: "zh-CN", timezone: "Asia/Shanghai" }),
  }), env, context);
  const jsonMalformedKey = await resMalformedKey.json();
  assert.notEqual(resMalformedKey.status, 400);
  assert.notEqual(jsonMalformedKey.code, "INVALID_REQUEST");
});
