import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRemoteTool, runRemoteTool } from "../lib/ai/tools/remote-tool-service.ts";
import { createAgentBinding } from "../lib/ai/security/agent-binding.ts";
import { derivePrincipalId } from "../lib/ai/security/principal.ts";
import { sealAutomationToken } from "../lib/ai/security/automation-token.ts";
import { AiWebService } from "../lib/ai/web-chat/web-chat-service.ts";
import { matchSceneActionIntent } from "../lib/ai/tools/scene-action-intent.ts";

const env = { XIAOMI_SESSION_SECRET: "test-session-secret-not-real-123456789", AI_PRINCIPAL_SECRET: "test-principal-secret-not-real-123456789" };
const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
const sceneRevision = `rev_${"b".repeat(24)}`;
const exposure = { version: 1, enabled: true, sceneActionsEnabled: true, roomMetrics: {}, deviceDids: [], sceneApprovals: { "private-real-id": sceneRevision }, updatedAt: null, revision: `exp_${"c".repeat(24)}` };
const exposureStore = { get: async () => exposure, setJSON: async () => {} };
async function input(scopes = ["ai:chat"]) {
  const principalId = await derivePrincipalId(session, env);
  return { requestId: "req_test_remote_tool", principalId, homeId: "test-home", scopes,
    sessionBinding: await createAgentBinding({ principalId, homeId: "test-home", scopes, session, expiresAt: Date.now() + 60000 }, env.XIAOMI_SESSION_SECRET),
    tool: "list_scenes", arguments: {} };
}
const approvedScene = { alias: "scene_0123456789abcdef", sceneId: "private-real-id", homeId: "test-home", name: "回家模式", description: "审核场景", enabled: true, actionCount: 1, revision: sceneRevision, actionSummaries: [{ room: "客厅", device: "客厅灯", actions: [{ label: "电源", value: "开启" }] }] };
const dependencies = { homes: async () => [{ id: "test-home" }], scenes: async () => [approvedScene], exposureStore };

test("remote tools require independent service authentication", async () => {
  const secret = "test-tools-secret-not-real-123456789";
  assert.equal(await authorizeRemoteTool(`Bearer ${secret}`, secret), true);
  assert.equal(await authorizeRemoteTool("Bearer wrong", secret), false);
  assert.equal(await authorizeRemoteTool(null, secret), false);
});
test("catalog response exposes approved scenes without private scene or Xiaomi credentials", async () => {
  const result = await runRemoteTool(await input(), env, dependencies);
  assert.equal(result.scenes[0].alias, "scene_0123456789abcdef");
  for (const secret of ["private-real-id", "fake-token", "fake-security", "test-user"]) assert.ok(!JSON.stringify(result).includes(secret));
});
test("catalog response is empty when per-home exposure has no scene approval", async () => {
  const result = await runRemoteTool(await input(), env, {
    ...dependencies,
    exposureStore: { get: async () => null, setJSON: async () => {} },
  });
  assert.deepEqual(result.scenes, []);
});
test("confirmed home bypass lists current scenes without individual approvals", async () => {
  const result = await runRemoteTool(await input(), env, {
    ...dependencies,
    exposureStore: { get: async () => ({ ...exposure, sceneApprovalBypass: true, sceneApprovals: {} }), setJSON: async () => {} },
  });
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].alias, approvedScene.alias);
});
test("binding prevents forged principal or home", async () => {
  const body = await input();
  await assert.rejects(runRemoteTool({ ...body, principalId: "usr_other" }, env, dependencies), /AI_UNAUTHENTICATED/);
  await assert.rejects(runRemoteTool({ ...body, homeId: "other-home" }, env, dependencies), /AI_UNAUTHENTICATED/);
});
test("home access is rechecked even with a valid binding", async () => {
  await assert.rejects(runRemoteTool(await input(), env, { ...dependencies, homes: async () => [] }), /AI_HOME_FORBIDDEN/);
});
test("new remote execution stays closed until durable executor claims exist", async () => {
  const body = {
    ...await input(["ai:chat", "scene:activate"]),
    idempotencyKey: "valid-idempotency-key-0001",
    requestHash: "a".repeat(64),
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision },
  };
  await assert.rejects(runRemoteTool(body, env, dependencies), /AI_SCENE_EXECUTION_DISABLED/);
});

test("scene action grants require a signed server binding and Console-only ticket key", async () => {
  const idempotencyKey = "valid-idempotency-key-0001";
  const requestHash = "a".repeat(64);
  const actionEnv = {
    ...env,
    AI_SCENE_EXECUTION_ENABLED: "true",
    AI_SCENE_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars",
  };
  const binding = await input(["ai:chat", "scene:activate"]);
  const grant = await runRemoteTool({
    ...binding,
    idempotencyKey,
    requestHash,
    tool: "authorize_scene_action",
    arguments: { sceneId: approvedScene.alias, revision: sceneRevision },
  }, actionEnv, dependencies);
  assert.equal(typeof grant.actionAuthorization, "string");
  assert.ok(grant.actionAuthorization.length > 32);
  const ticketPayload = JSON.parse(Buffer.from(grant.actionAuthorization.split(".")[0], "base64url").toString("utf8"));
  assert.equal(ticketPayload.sceneAlias, approvedScene.alias);
  assert.equal("sceneId" in ticketPayload, false);

  const readOnlyBinding = await input(["ai:chat"]);
  await assert.rejects(runRemoteTool({
    ...readOnlyBinding,
    idempotencyKey,
    requestHash,
    tool: "authorize_scene_action",
    arguments: { sceneId: approvedScene.alias, revision: sceneRevision },
  }, actionEnv, dependencies), /AI_SCOPE_FORBIDDEN/);

  await assert.rejects(runRemoteTool({
    ...binding,
    idempotencyKey,
    requestHash,
    tool: "activate_scene",
    actionAuthorization: grant.actionAuthorization,
    arguments: { sceneId: approvedScene.alias, revision: sceneRevision },
  }, { ...actionEnv, AI_SCENE_ACTION_AUTHORIZATION_SECRET: "wrong-console-ticket-secret-32chars" }, dependencies), /AI_SCOPE_FORBIDDEN/);
});

test("remote execution requires a valid idempotency key and strict scene argument", async () => {
  const base = {
    ...await input(["ai:chat", "scene:activate"]),
    requestHash: "a".repeat(64),
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision },
  };
  await assert.rejects(
    runRemoteTool({ ...base, idempotencyKey: undefined }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({ ...base, idempotencyKey: "short-key" }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({
      ...base,
      idempotencyKey: "valid-idempotency-key-0001",
      arguments: { sceneId: "not-a-scene" },
    }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({
      ...base,
      idempotencyKey: "valid-idempotency-key-0001",
      arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision, extra: 1 },
    }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
});

test("remote execution stays read-only in the preview environment", async () => {
  const body = {
    ...await input(["ai:chat", "scene:activate"]),
    idempotencyKey: "valid-idempotency-key-0001",
    requestHash: "a".repeat(64),
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision },
  };
  await assert.rejects(
    runRemoteTool(body, { ...env, AI_ENVIRONMENT: "preview" }, dependencies),
    /AI_PREVIEW_READ_ONLY/,
  );
});

test("get_home_status returns a sanitized read-only snapshot", async () => {
  const snapshot = {
    capturedAt: "2026-09-20T08:00:00Z",
    completeness: "partial",
    groups: [{ metric: "temperature", label: "温度", unit: "°C", latest: { value: 25.5, unit: "°C", sourceLabel: "客厅温湿度计", roomName: "客厅", capturedAt: "2026-09-20T08:00:00Z", freshness: "fresh" }, readings: [] }],
    warnings: ["部分设备读数暂时不可用。"],
  };
  const statusDeps = {
    ...dependencies,
    homeStatus: async () => snapshot,
  };
  const result = await runRemoteTool({ ...await input(), tool: "get_home_status" }, env, statusDeps);
  assert.equal(result.completeness, "partial");
  assert.equal(result.groups[0].metric, "temperature");
  // ai:chat alone suffices; no scene:activate scope was requested.
  assert.deepEqual(result.warnings, ["部分设备读数暂时不可用。"]);
});

test("get_home_status rejects non-empty arguments and preview environments", async () => {
  await assert.rejects(
    runRemoteTool({ ...await input(), tool: "get_home_status", arguments: { metric: "temperature" } }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({ ...await input(), tool: "get_home_status" }, { ...env, AI_ENVIRONMENT: "preview" }, dependencies),
    /AI_PREVIEW_READ_ONLY/,
  );
});

// --- automation-token ingress (X-Ai-User-Token) -------------------------------

const tokenEnv = {
  ...env,
  AI_AUTOMATION_TOKEN_SECRET: "test-automation-secret-not-real-12345",
  AI_AUTOMATION_TOKEN_KEY_ID: "test-key-2026-09",
};
const tokenHomes = [{ id: "home-a", name: "我的家" }, { id: "home-b", name: "度假屋" }];

async function automationToken(overrides = {}) {
  return sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    audience: "mijia-agent",
    principalId: "forged-principal-ignored",
    xiaomiSession: session,
    region: "cn",
    provider: "byok-provider",
    model: "byok-model",
    apiKey: "byok-secret-key",
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
    ...overrides,
  }, {
    secret: tokenEnv.AI_AUTOMATION_TOKEN_SECRET,
    keyId: tokenEnv.AI_AUTOMATION_TOKEN_KEY_ID,
    env: "production",
  });
}

function tokenInput(tool = "list_scenes", extra = {}) {
  return { requestId: "req_test_token_tool", tool, arguments: {}, ...extra };
}

function tokenDeps(seen = []) {
  return {
    homes: async () => tokenHomes,
    exposureStore,
    scenes: async (input) => {
      seen.push(input);
      return [{ ...approvedScene, homeId: input.homeId }];
    },
  };
}

test("token path derives the principal from the session and resolves home by name", async () => {
  const seen = [];
  const result = await runRemoteTool(
    tokenInput("list_scenes", { home: "我的家" }),
    tokenEnv,
    tokenDeps(seen),
    await automationToken(),
  );
  assert.equal(seen[0].homeId, "home-a");
  assert.equal(seen[0].principalId, await derivePrincipalId(session, tokenEnv));
  assert.equal(result.scenes[0].alias, "scene_0123456789abcdef");
});

test("token payload principal and BYOK fields are never trusted or echoed", async () => {
  const seen = [];
  const result = await runRemoteTool(
    tokenInput(),
    tokenEnv,
    tokenDeps(seen),
    await automationToken(),
  );
  assert.notEqual(seen[0].principalId, "forged-principal-ignored");
  const serialized = JSON.stringify(result);
  for (const secret of ["byok-secret-key", "byok-model", "forged-principal-ignored", "fake-token", "fake-security"]) {
    assert.ok(!serialized.includes(secret), `${secret} must not leak`);
  }
});

test("token authorize returns only the server-derived context for the Makers adapter", async () => {
  const result = await runRemoteTool(
    tokenInput("authorize"),
    tokenEnv,
    tokenDeps(),
    await automationToken({ homeId: "home-b" }),
  );
  assert.deepEqual(result, {
    ok: true,
    principalId: await derivePrincipalId(session, tokenEnv),
    homeId: "home-b",
    scopes: ["ai:chat"],
  });
});

test("automation tokens without the mijia-agent audience cannot authorize direct assistant ingress", async () => {
  const token = await automationToken({ audience: undefined });
  await assert.rejects(
    runRemoteTool(
      tokenInput("authorize"),
      tokenEnv,
      tokenDeps(),
      token,
    ),
    error => error.message === "AUTOMATION_TOKEN_INVALID",
  );
});

test("web-issued token opens with the stable automation-token realm", async () => {
  const integrationEnv = {
    ...tokenEnv,
    AI_AUTOMATION_TOKEN_KEY_ID: "edge-key-2026-09",
    AI_QUOTA_ENABLED: "false",
  };
  let authorized;
  const agent = {
    async run(input) {
      authorized = await runRemoteTool(
        tokenInput("authorize"),
        integrationEnv,
        tokenDeps(),
        input.automationToken,
      );
      return {
        requestId: input.requestId,
        conversationId: input.conversationId,
        message: "ok",
        intent: "none",
      };
    },
    async deleteConversation() {
      return { deleted: true };
    },
  };
  const service = new AiWebService({
    env: integrationEnv,
    agent,
    loadHomes: async () => tokenHomes,
    now: () => Date.now(),
    randomBytes: length => new Uint8Array(length).fill(7),
    randomUuid: () => "00000000-0000-4000-8000-000000000007",
  });

  const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  try {
    Object.defineProperty(globalThis, "process", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    await service.chat(session, { homeId: "home-a", message: "查看家里情况" });
  } finally {
    if (processDescriptor) Object.defineProperty(globalThis, "process", processDescriptor);
    else Reflect.deleteProperty(globalThis, "process");
  }

  assert.deepEqual(authorized, {
    ok: true,
    principalId: await derivePrincipalId(session, integrationEnv),
    homeId: "home-a",
    scopes: ["ai:chat"],
  });
});

test("explicit request home wins over the token-bound homeId", async () => {
  const seen = [];
  await runRemoteTool(
    tokenInput("list_scenes", { home: "我的家" }),
    tokenEnv,
    tokenDeps(seen),
    await automationToken({ homeId: "home-b" }),
  );
  assert.equal(seen[0].homeId, "home-a");
});

test("token-bound homeId is used when no request home is provided", async () => {
  const seen = [];
  await runRemoteTool(tokenInput(), tokenEnv, tokenDeps(seen), await automationToken({ homeId: "home-b" }));
  assert.equal(seen[0].homeId, "home-b");
});

test("request home may match by id, exact name, or substring for direct token calls", async () => {
  const seen = [];
  await runRemoteTool(tokenInput("list_scenes", { home: "home-b" }), tokenEnv, tokenDeps(seen), await automationToken());
  assert.equal(seen[0].homeId, "home-b");
  await runRemoteTool(tokenInput("list_scenes", { home: "度假屋" }), tokenEnv, tokenDeps(seen), await automationToken());
  assert.equal(seen[1].homeId, "home-b");
  await runRemoteTool(tokenInput("list_scenes", { home: "度假" }), tokenEnv, tokenDeps(seen), await automationToken());
  assert.equal(seen[2].homeId, "home-b");
});

test("unmatched request homes and revoked bound homes fail closed", async () => {
  await assert.rejects(
    runRemoteTool(tokenInput("list_scenes", { home: "不存在的家" }), tokenEnv, tokenDeps(), await automationToken()),
    /AI_HOME_NOT_FOUND/,
  );
  await assert.rejects(
    runRemoteTool(tokenInput(), tokenEnv, tokenDeps(), await automationToken({ homeId: "home-gone" })),
    /AI_HOME_NOT_FOUND/,
  );
  await assert.rejects(
    runRemoteTool(tokenInput(), tokenEnv, { ...tokenDeps(), homes: async () => [] }, await automationToken()),
    /AI_HOME_NOT_FOUND/,
  );
});

test("expired and malformed tokens are rejected without secret leakage", async () => {
  await assert.rejects(
    runRemoteTool(tokenInput(), tokenEnv, tokenDeps(), await automationToken({ expiresAt: Date.now() - 1000 })),
    /AUTOMATION_TOKEN_EXPIRED/,
  );
  await assert.rejects(
    runRemoteTool(tokenInput(), tokenEnv, tokenDeps(), "v1.not.a.real.token"),
    /AUTOMATION_TOKEN_INVALID/,
  );
  await assert.rejects(
    runRemoteTool(tokenInput(), env, tokenDeps(), await automationToken()),
    /AI_AUTOMATION_TOKEN_SECRET_NOT_CONFIGURED/,
  );
});

test("token path rejects binding-only fields and strict lengths", async () => {
  const token = await automationToken();
  await assert.rejects(
    runRemoteTool({ ...tokenInput(), sessionBinding: "mixed-envelope" }, tokenEnv, tokenDeps(), token),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({ ...tokenInput(), principalId: "usr_forged" }, tokenEnv, tokenDeps(), token),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({ ...tokenInput(), home: "" }, tokenEnv, tokenDeps(), token),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool(tokenInput(), tokenEnv, tokenDeps(), "x".repeat(8193)),
    /AUTOMATION_TOKEN_INVALID/,
  );
});

test("token path keeps get_home_status read-only", async () => {
  const seen = [];
  const deps = {
    ...tokenDeps(),
    homeStatus: async (input) => {
      seen.push(input);
      return { completeness: "partial", groups: [] };
    },
  };
  const result = await runRemoteTool(tokenInput("get_home_status"), tokenEnv, deps, await automationToken());
  assert.equal(result.completeness, "partial");
  assert.equal(seen.at(-1)?.homeId, "home-a");
  await assert.rejects(
    runRemoteTool(tokenInput("get_home_status", { arguments: { metric: "temperature" } }), tokenEnv, deps, await automationToken()),
    /AI_INVALID_REQUEST/,
  );
});

test("get_device_status returns the sanitized per-room snapshot", async () => {
  const snapshot = {
    capturedAt: "2026-09-21T08:00:00Z",
    completeness: "complete",
    poweredOn: 1,
    rooms: [{ room: "客厅", items: [{ name: "客厅吸顶灯", kind: "light", state: "on", online: true }] }],
    warnings: [],
  };
  const statusDeps = {
    ...dependencies,
    deviceStatus: async () => snapshot,
  };
  const result = await runRemoteTool({ ...await input(), tool: "get_device_status" }, env, statusDeps);
  assert.equal(result.completeness, "complete");
  assert.equal(result.rooms[0].items[0].state, "on");
  assert.equal(result.poweredOn, 1);
});

test("get_device_status rejects non-empty arguments and preview environments", async () => {
  await assert.rejects(
    runRemoteTool({ ...await input(), tool: "get_device_status", arguments: { room: "客厅" } }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
  await assert.rejects(
    runRemoteTool({ ...await input(), tool: "get_device_status" }, { ...env, AI_ENVIRONMENT: "preview" }, dependencies),
    /AI_PREVIEW_READ_ONLY/,
  );
});

test("token path keeps get_device_status read-only", async () => {
  const seen = [];
  const deps = {
    ...tokenDeps(),
    deviceStatus: async (input) => {
      seen.push(input);
      return { completeness: "complete", poweredOn: 0, rooms: [], warnings: [] };
    },
  };
  const result = await runRemoteTool(tokenInput("get_device_status"), tokenEnv, deps, await automationToken());
  assert.equal(result.completeness, "complete");
  assert.equal(seen.at(-1)?.homeId, "home-a");
  await assert.rejects(
    runRemoteTool(tokenInput("get_device_status", { arguments: { room: "客厅" } }), tokenEnv, deps, await automationToken()),
    /AI_INVALID_REQUEST/,
  );
});

test("automation-token activation stays blocked without a server-issued action scope", async () => {
  const token = await automationToken();
  const runScene = [];
  await assert.rejects(
    runRemoteTool(
      tokenInput("activate_scene", { arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision }, idempotencyKey: "valid-idempotency-key-0001", requestHash: "a".repeat(64) }),
      { ...tokenEnv, AI_SCENE_EXECUTION_ENABLED: "true" },
      { ...tokenDeps(), runScene: async () => { runScene.push(true); } },
      token,
    ),
    /AI_SCOPE_FORBIDDEN/,
  );
  assert.deepEqual(runScene, []);
  await assert.rejects(
    runRemoteTool(tokenInput("activate_scene", { arguments: { sceneId: "scene_0123456789abcdef", revision: sceneRevision } }), tokenEnv, tokenDeps(), token),
    /AI_SCOPE_FORBIDDEN/,
  );
});

test("scene intent accepts only one exact present-tense scene name", () => {
  assert.equal(matchSceneActionIntent("执行回家模式", [approvedScene])?.alias, approvedScene.alias);
  for (const message of ["不要执行回家模式", "如果回家就执行回家模式", "明天执行回家模式", "“执行回家模式”", "执行回家", "执行回家模式吗？"]) {
    assert.equal(matchSceneActionIntent(message, [approvedScene]), null, message);
  }
  assert.equal(matchSceneActionIntent("执行回家模式", [approvedScene, approvedScene]), null);
});

test("web-issued action grant executes once through the token path and replays from Blob", async () => {
  const actionEnv = { ...tokenEnv, AI_QUOTA_ENABLED: "false", AI_SCENE_EXECUTION_ENABLED: "true",
    AI_SCENE_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars" };
  const objects = new Map();
  const ledger = {
    async get(key) { return objects.get(key) ?? null; },
    async setJSON(key, value, options) {
      assert.equal(options?.onlyIfNew, true);
      if (objects.has(key)) throw new Error("EEXIST");
      objects.set(key, value);
    },
  };
  let runs = 0;
  let captured;
  const agent = { async run(input) { captured = input; return { requestId: input.requestId,
    conversationId: input.conversationId, message: "accepted", intent: "activate_scene" }; } };
  const service = new AiWebService({ env: actionEnv, agent,
    loadHomes: async () => tokenHomes, loadScenes: async () => [{ ...approvedScene, homeId: "home-a" }],
    readExposure: async () => exposure });
  await service.chat(session, { homeId: "home-a", message: "执行回家模式",
    idempotencyKey: "scene-test-idempotency-0001" });
  assert.deepEqual(captured.scopes, ["ai:chat", "scene:activate"]);
  const request = { requestId: captured.requestId, tool: "authorize", arguments: {} };
  const authorized = await runRemoteTool(request, actionEnv, tokenDeps(), captured.automationToken);
  assert.equal(authorized.actionIdempotencyKey, captured.idempotencyKey);
  assert.deepEqual(authorized.scopes, ["ai:chat", "scene:activate"]);
  const invoke = { requestId: captured.requestId, tool: "activate_scene", idempotencyKey: captured.idempotencyKey,
    arguments: { sceneId: approvedScene.alias, revision: sceneRevision } };
  const deps = { ...tokenDeps(), actionLedgerStore: ledger, runScene: async () => { runs++; } };
  assert.equal((await runRemoteTool(invoke, actionEnv, deps, captured.automationToken)).status, "success");
  assert.equal((await runRemoteTool(invoke, actionEnv, deps, captured.automationToken)).status, "success");
  assert.equal(runs, 1);
  await assert.rejects(runRemoteTool({ ...invoke, arguments: { sceneId: "scene_ffffffffffffffff", revision: sceneRevision } },
    actionEnv, deps, captured.automationToken), /AI_SCOPE_FORBIDDEN/);
});

test("a timed-out scene request remains unknown and its action key never redispatches", async () => {
  const actionEnv = { ...tokenEnv, AI_SCENE_EXECUTION_ENABLED: "true",
    AI_SCENE_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars" };
  const idempotencyKey = "scene-timeout-idempotency-0001";
  const grant = { requestId: "req_test_token_tool", idempotencyKey,
    sceneAlias: approvedScene.alias, revision: sceneRevision,
    messageHash: "a".repeat(64), expiresAt: Date.now() + 30_000 };
  const token = await automationToken({ homeId: "home-a", actionGrant: grant });
  const objects = new Map();
  const actionLedgerStore = {
    async get(key) { return objects.get(key) ?? null; },
    async setJSON(key, value) { if (objects.has(key)) throw new Error("EEXIST"); objects.set(key, value); },
  };
  let runs = 0;
  const deps = { ...tokenDeps(), actionLedgerStore,
    runScene: async () => { runs++; throw new Error("simulated timeout"); } };
  const invoke = tokenInput("activate_scene", { idempotencyKey,
    arguments: { sceneId: approvedScene.alias, revision: sceneRevision } });
  await assert.rejects(runRemoteTool(invoke, actionEnv, deps, token), /AI_EXECUTION_STATUS_UNKNOWN/);
  await assert.rejects(runRemoteTool(invoke, actionEnv, deps, token), /AI_EXECUTION_STATUS_UNKNOWN/);
  assert.equal(runs, 1);
});

test("device-property grants revalidate exposure and dispatch exactly once", async () => {
  const actionEnv = { ...tokenEnv, AI_DEVICE_EXECUTION_ENABLED: "true",
    AI_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars" };
  const idempotencyKey = "device-action-idempotency-0001";
  const deviceId = `entity_${"d".repeat(32)}`;
  const operationId = `op_${"e".repeat(24)}`;
  const revision = `rev_${"f".repeat(24)}`;
  const value = 24;
  const grant = { kind: "device_property", requestId: "req_test_token_tool", idempotencyKey,
    deviceId, operationId, revision, value, messageHash: "a".repeat(64), expiresAt: Date.now() + 30_000 };
  const token = await automationToken({ homeId: "home-a", actionGrant: grant });
  const objects = new Map();
  const actionLedgerStore = {
    async get(key) { return objects.get(key) ?? null; },
    async setJSON(key, stored) { if (objects.has(key)) throw new Error("EEXIST"); objects.set(key, stored); },
  };
  const device = { deviceId, name: "空调", room: "客厅", kind: "air-conditioner", online: true,
    did: "private-did", model: "fake.air-conditioner.v1", operations: [{ operationId: `op_${"a".repeat(24)}`, revision: `rev_${"b".repeat(24)}`,
      name: "mode", label: "模式", valueType: "number", range: { min: 0, max: 3, step: 1 }, siid: 2, piid: 4 }, { operationId, revision,
      name: "target-temperature", label: "目标温度", valueType: "number", range: { min: 16, max: 30, step: 1 }, siid: 2, piid: 3 }] };
  let writes = 0;
  const deps = { ...tokenDeps(), actionLedgerStore,
    exposureStore: { get: async () => ({ ...exposure, deviceActionsEnabled: true, deviceDids: ["private-did"] }) },
    discovery: async () => ({ homes: tokenHomes, devices: [], controlObjectResults: [], completeness: "complete", warnings: [], successfulHomeCount: 1, failedHomeCount: 0, requestAttemptCount: 1 }),
    deviceCatalog: async () => [device],
    setProperty: async () => { writes++; } };
  const listed = await runRemoteTool(tokenInput("list_device_controls"), actionEnv, deps, token);
  assert.equal(listed.devices[0].operations[0].operationId, operationId);
  const invoke = tokenInput("set_device_property", { idempotencyKey,
    arguments: { deviceId, operationId, revision, value } });
  const submitted = await runRemoteTool(invoke, actionEnv, deps, token);
  assert.equal(submitted.status, "success");
  assert.equal(submitted.message, "已为你设置空调的目标温度。");
  assert.equal((await runRemoteTool(invoke, actionEnv, deps, token)).message, submitted.message);
  assert.equal(writes, 1);
  await assert.rejects(runRemoteTool({ ...invoke, arguments: { deviceId, operationId, revision, value: 25 } },
    actionEnv, deps, token), /AI_SCOPE_FORBIDDEN/);
});

test("a Xiaomi property error after dispatch is unknown and never redispatched", async () => {
  const actionEnv = { ...tokenEnv, AI_DEVICE_EXECUTION_ENABLED: "true",
    AI_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars" };
  const idempotencyKey = "device-uncertain-idempotency-0001";
  const deviceId = `entity_${"d".repeat(32)}`;
  const operationId = `op_${"e".repeat(24)}`;
  const revision = `rev_${"f".repeat(24)}`;
  const grant = { kind: "device_property", requestId: "req_test_token_tool", idempotencyKey,
    deviceId, operationId, revision, value: true, messageHash: "a".repeat(64), expiresAt: Date.now() + 30_000 };
  const token = await automationToken({ homeId: "home-a", actionGrant: grant });
  const objects = new Map();
  const actionLedgerStore = {
    async get(key) { return objects.get(key) ?? null; },
    async setJSON(key, stored) { if (objects.has(key)) throw new Error("EEXIST"); objects.set(key, stored); },
  };
  const device = { deviceId, name: "客厅灯带", room: "客厅", kind: "light", online: true,
    did: "physical-did", model: "fake.light", operations: [{ operationId, revision,
      name: "on", label: "开关", valueType: "boolean", siid: 15, piid: 1 }] };
  let writes = 0;
  const deps = { ...tokenDeps(), actionLedgerStore,
    exposureStore: { get: async () => ({ ...exposure, deviceActionsEnabled: true, deviceDids: ["physical-did.s15"] }) },
    discovery: async () => ({ homes: tokenHomes, devices: [], controlObjectResults: [], completeness: "complete", warnings: [], successfulHomeCount: 1, failedHomeCount: 0, requestAttemptCount: 1 }),
    deviceCatalog: async () => [device],
    setProperty: async () => { writes++; throw new Error("XIAOMI_PROPERTY_CODE_-704220025"); } };
  const invoke = tokenInput("set_device_property", { idempotencyKey,
    arguments: { deviceId, operationId, revision, value: true } });
  await assert.rejects(runRemoteTool(invoke, actionEnv, deps, token), /AI_EXECUTION_STATUS_UNKNOWN/);
  await assert.rejects(runRemoteTool(invoke, actionEnv, deps, token), /AI_EXECUTION_STATUS_UNKNOWN/);
  assert.equal(writes, 1);
});

test("web chat grants device scope only for one exact selected safe operation", async () => {
  const actionEnv = { ...tokenEnv, AI_QUOTA_ENABLED: "false", AI_DEVICE_EXECUTION_ENABLED: "true",
    AI_ACTION_AUTHORIZATION_SECRET: "test-console-action-ticket-secret-32chars" };
  const device = { deviceId: `entity_${"1".repeat(32)}`, name: "空调", room: "客厅",
    kind: "air-conditioner", online: true, did: "private-did", model: "fake.model",
    operations: [{ operationId: `op_${"2".repeat(24)}`, revision: `rev_${"3".repeat(24)}`,
      name: "target-temperature", label: "目标温度", valueType: "number",
      range: { min: 16, max: 30, step: 1 }, siid: 2, piid: 3 }] };
  let captured;
  const service = new AiWebService({ env: actionEnv,
    agent: { async run(input) { captured = input; return { requestId: input.requestId,
      conversationId: input.conversationId, message: "accepted", intent: "set_device_property" }; } },
    loadHomes: async () => tokenHomes,
    readExposure: async () => ({ ...exposure, deviceActionsEnabled: true, deviceDids: ["private-did"] }),
    loadDevices: async () => ({ homes: tokenHomes, devices: [], controlObjectResults: [], completeness: "complete", warnings: [], successfulHomeCount: 1, failedHomeCount: 0, requestAttemptCount: 1 }),
    loadDeviceOperations: async () => [device] });
  await service.chat(session, { homeId: "home-a", message: "设置客厅空调目标温度为24度",
    idempotencyKey: "device-web-idempotency-0001" });
  assert.deepEqual(captured.scopes, ["ai:chat", "device:operate"]);
  const authorization = await runRemoteTool(tokenInput("authorize", { requestId: captured.requestId }),
    actionEnv, tokenDeps(), captured.automationToken);
  assert.deepEqual(authorization.scopes, ["ai:chat", "device:operate"]);
  assert.equal(authorization.actionIdempotencyKey, "device-web-idempotency-0001");
});
