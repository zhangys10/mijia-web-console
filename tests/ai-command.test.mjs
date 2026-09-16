import assert from "node:assert/strict";
import test from "node:test";

import { verifyShortcutAuth } from "../lib/ai/security/auth.ts";
import { IdempotencyStore, requestHash } from "../lib/ai/security/idempotency.ts";
import { isDeterministicFallback } from "../lib/ai/fallback.ts";
import { validateToolCall } from "../lib/ai/tools/tool-validator.ts";
import { IntentOrchestrator } from "../lib/ai/intent-orchestrator.ts";
import { loadAiCommandConfig } from "../lib/ai/config.ts";
import { allowedScenes } from "../lib/ai/scenes/catalog.ts";
import { SceneService } from "../lib/ai/scenes/scene-service.ts";

test("shortcut authentication accepts only the exact bearer token hash", async () => {
  const token = "a".repeat(32);
  const hash = await verifyShortcutAuth(`Bearer ${token}`, (await import("node:crypto")).createHash("sha256").update(token).digest("hex"));
  assert.equal(hash, true);
  assert.equal(await verifyShortcutAuth(`Bearer ${"b".repeat(32)}`, (await import("node:crypto")).createHash("sha256").update(token).digest("hex")), false);
  assert.equal(await verifyShortcutAuth(null, "abc"), false);
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

test("deterministic fallback accepts only exact high-confidence phrases", () => {
  assert.equal(isDeterministicFallback("我回家了"), true);
  assert.equal(isDeterministicFallback("  我回家了  "), true);
  assert.equal(isDeterministicFallback("我还没回家"), false);
  assert.equal(isDeterministicFallback("如果我回家了怎么办"), false);
  assert.equal(isDeterministicFallback("回家模式是什么"), false);
  assert.equal(isDeterministicFallback("他说他回家了"), false);
  assert.equal(isDeterministicFallback("不要开启回家模式"), false);
});

test("tool validation rejects unknown tools and unsupported scene ids", () => {
  assert.deepEqual(validateToolCall({ name: "activate_scene", arguments: { sceneId: "home" } }), { valid: true, sceneId: "home" });
  assert.equal(validateToolCall({ name: "turn_off_light", arguments: { sceneId: "home" } }).valid, false);
  assert.equal(validateToolCall({ name: "activate_scene", arguments: { sceneId: "away" } }).valid, false);
  assert.equal(validateToolCall({ name: "activate_scene", arguments: {} }).valid, false);
});

class FakeProvider {
  constructor(decision) {
    this.decision = decision;
    this.calls = [];
  }
  async decide(text, locale, timezone) {
    this.calls.push({ text, locale, timezone });
    if (this.decision instanceof Error) throw this.decision;
    return this.decision;
  }
}

test("intent orchestrator validates llm tool calls before execution", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const invalid = new FakeProvider({ type: "tool_call", tool: "activate_scene", arguments: { sceneId: "away" }, model: "test", latencyMs: 1 });
  await assert.rejects(new IntentOrchestrator(invalid, config).decide("我回家了", "zh-CN", "Asia/Shanghai"), /UNSUPPORTED_INTENT/);
  assert.equal(invalid.calls.length, 1);
  const valid = new FakeProvider({ type: "tool_call", tool: "activate_scene", arguments: { sceneId: "home" }, model: "test", latencyMs: 1 });
  const decision = await new IntentOrchestrator(valid, config).decide("我回家了", "zh-CN", "Asia/Shanghai");
  assert.equal(decision.type, "tool_call");
  assert.equal(decision.arguments.sceneId, "home");
});

test("intent orchestrator uses deterministic fallback only for exact phrases", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const timeout = new FakeProvider(new Error("LLM_TIMEOUT"));
  const fallback = await new IntentOrchestrator(timeout, config).decide("我回家了", "zh-CN", "Asia/Shanghai");
  assert.equal(fallback.type, "tool_call");
  assert.equal(fallback.model, "deterministic_fallback");
  const negative = new FakeProvider(new Error("LLM_TIMEOUT"));
  await assert.rejects(new IntentOrchestrator(negative, config).decide("我还没回家", "zh-CN", "Asia/Shanghai"), /LLM_TIMEOUT/);
});

test("scene service exposes only the audited home scene", async () => {
  assert.deepEqual(allowedScenes.map(scene => scene.id), ["home"]);
  class FakeExecutor {
    constructor() { this.calls = []; }
    async execute(sceneId, requestId) {
      this.calls.push({ sceneId, requestId });
      return { status: "success", succeeded: 1, failed: 0, message: "ok" };
    }
  }
  const executor = new FakeExecutor();
  const service = new SceneService(executor);
  const result = await service.activate("home", "request-1");
  assert.equal(result.status, "success");
  assert.deepEqual(executor.calls, [{ sceneId: "home", requestId: "request-1" }]);
  assert.equal((await service.activate("away", "request-1")).succeeded, 0);
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
