import assert from "node:assert/strict";
import test from "node:test";

import { sealAutomationToken, computePrincipalId } from "../lib/ai/security/automation-token.ts";
import { IntentOrchestrator, runtimeScenes } from "../lib/ai/intent-orchestrator.ts";
import { loadAiCommandConfig } from "../lib/ai/config.ts";

process.env.APP_ENV = "test";
process.env.XIAOMI_SESSION_SECRET = "test-secret-at-least-32-chars-long-for-isolation-test";
process.env.AI_AUTOMATION_TOKEN_SECRET = "test-secret-at-least-32-chars-long-for-isolation-test";

const sessionA = {
  userId: "user-alpha",
  cUserId: "c-user-alpha",
  ssecurity: "ssec-alpha",
  serviceToken: "stok-alpha",
  region: "cn",
  deviceId: "dev-alpha",
  userAgent: "agent-alpha",
  createdAt: Date.now(),
};

const sessionB = {
  userId: "user-beta",
  cUserId: "c-user-beta",
  ssecurity: "ssec-beta",
  serviceToken: "stok-beta",
  region: "cn",
  deviceId: "dev-beta",
  userAgent: "agent-beta",
  createdAt: Date.now(),
};

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `ai-isolation-${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  return { worker, env, context };
}

test("Orchestrator rejects invalid credential without deterministic fallback", async () => {
  const config = loadAiCommandConfig({ AI_DETERMINISTIC_FALLBACK: "true" });
  const scenes = runtimeScenes([{ id: "scene-home", name: "回家模式", enabled: true }]);

  class ErrorProvider {
    async decide() {
      throw new Error("LLM_CREDENTIAL_INVALID");
    }
  }

  const orchestrator = new IntentOrchestrator(new ErrorProvider(), config);
  // 当凭据无效时，必须直接抛出 LLM_CREDENTIAL_INVALID，绝不能降级执行回家模式
  await assert.rejects(
    () => orchestrator.decide("我回家了", scenes, "zh-CN", "Asia/Shanghai"),
    (err) => err.message === "LLM_CREDENTIAL_INVALID"
  );
});

test("Orchestrator passes request-level credential to provider", async () => {
  const config = loadAiCommandConfig();
  const scenes = runtimeScenes([{ id: "scene-home", name: "回家模式", enabled: true }]);

  let receivedCredential = null;
  class CapturingProvider {
    async decide(text, scenes, locale, timezone, history, credential) {
      receivedCredential = credential;
      return {
        type: "tool_call",
        tool: "activate_scene",
        arguments: { sceneId: "scene-home", replyMessage: "欢迎回家" },
        model: credential?.model || "mock",
        latencyMs: 1,
      };
    }
  }

  const orchestrator = new IntentOrchestrator(new CapturingProvider(), config);
  const reqCred = {
    provider: "qwen-cn",
    apiToken: "sk-user-isolated-key",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-flash-2026-07-15",
  };

  const decision = await orchestrator.decide("我回家了", scenes, "zh-CN", "Asia/Shanghai", undefined, reqCred);
  assert.equal(decision.type, "tool_call");
  assert.deepEqual(receivedCredential, reqCred);
});

test("loadAiCommandConfig no longer exposes shared LLM_API_KEY", async () => {
  const config = loadAiCommandConfig({ LLM_API_KEY: "sk-legacy-shared-key" });
  assert.equal(Object.hasOwn(config, "apiKey"), false);
});

test("Command API rejects expired automation token with 401 AUTOMATION_TOKEN_EXPIRED", async () => {
  const { worker, env, context } = await getWorker();
  const now = Date.now();
  const principalId = await computePrincipalId("cn", sessionA.userId);
  const expiredPayload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: sessionA,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-alpha-key",
    issuedAt: now - 20000,
    expiresAt: now - 1000, // Expired
  };

  const token = await sealAutomationToken(expiredPayload, { env: "test" });
  const res = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了" }),
  }), env, context);

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "AUTOMATION_TOKEN_EXPIRED");
  assert.match(json.message, /过期/);
});

test("Command API rejects tampered automation token with 401 AUTOMATION_TOKEN_INVALID", async () => {
  const { worker, env, context } = await getWorker();
  const now = Date.now();
  const principalId = await computePrincipalId("cn", sessionA.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: sessionA,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-alpha-key",
    issuedAt: now,
    expiresAt: now + 86400000,
  };

  const token = await sealAutomationToken(payload, { env: "test" });
  const [prefix, keyId, iv, ct, tag] = token.split(".");
  const tamperedTag = (tag[0] === "X" ? "Y" : "X") + tag.slice(1);
  const tamperedToken = `${prefix}.${keyId}.${iv}.${ct}.${tamperedTag}`;

  const res = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tamperedToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了" }),
  }), env, context);

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.code, "AUTOMATION_TOKEN_INVALID");
});

test("Command API rejects request without user LLM key and without global key with 422 LLM_CREDENTIAL_NOT_CONFIGURED", async () => {
  const { worker, env, context } = await getWorker();
  // Clear any global fallback
  delete process.env.LLM_API_KEY;

  const { createAiBindingToken } = await import("../lib/ai/security/binding.ts");
  const oldBindingTokenWithoutKey = await createAiBindingToken(sessionA, "home-a");

  const res = await worker.fetch(new Request("http://localhost/api/ai/command", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oldBindingTokenWithoutKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "我回家了" }),
  }), env, context);

  assert.equal(res.status, 422);
  const json = await res.json();
  assert.equal(json.code, "LLM_CREDENTIAL_NOT_CONFIGURED");
  assert.match(json.message, /未配置模型 Token/);
});

test("User A and User B tokens resolve completely isolated keys and sessions", async () => {
  const now = Date.now();
  const principalA = await computePrincipalId("cn", sessionA.userId);
  const principalB = await computePrincipalId("cn", sessionB.userId);

  const tokenA = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId: principalA,
    xiaomiSession: sessionA,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-key-of-user-alpha",
    issuedAt: now,
    expiresAt: now + 86400000,
  }, { env: "test" });

  const tokenB = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId: principalB,
    xiaomiSession: sessionB,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.8-flash",
    apiKey: "sk-key-of-user-beta",
    issuedAt: now,
    expiresAt: now + 86400000,
  }, { env: "test" });

  const { openAutomationToken } = await import("../lib/ai/security/automation-token.ts");
  const openedA = await openAutomationToken(tokenA, { env: "test", now });
  const openedB = await openAutomationToken(tokenB, { env: "test", now });

  assert.equal(openedA.apiKey, "sk-key-of-user-alpha");
  assert.equal(openedA.xiaomiSession.userId, "user-alpha");
  assert.equal(openedA.model, "qwen3.7-flash-2026-07-15");

  assert.equal(openedB.apiKey, "sk-key-of-user-beta");
  assert.equal(openedB.xiaomiSession.userId, "user-beta");
  assert.equal(openedB.model, "qwen3.8-flash");

  // Ensure absolutely no overlap between user credentials
  assert.notEqual(openedA.apiKey, openedB.apiKey);
  assert.notEqual(openedA.principalId, openedB.principalId);
  assert.notEqual(openedA.xiaomiSession.serviceToken, openedB.xiaomiSession.serviceToken);
});
