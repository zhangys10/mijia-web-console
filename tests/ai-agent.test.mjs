import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentBindingError,
  createAgentBinding,
  verifyAgentBinding,
} from "../lib/ai/security/agent-binding.ts";
import {
  buildAgentSceneCatalog,
  safeScenesForModel,
} from "../lib/ai/tools/agent-scene-catalog.ts";

const sessionSecret = "agent-binding-test-secret-at-least-32-characters";
const now = Date.now();
const principalId = "usr_agent_principal_000000000000000000";
const otherPrincipalId = "usr_agent_other_principal_00000000000000";
const homeId = "home-agent-1";
const otherHomeId = "home-agent-2";

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
  });
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

test("scene catalog exposes every enabled scene of the home as principal-scoped aliases", async () => {
  const catalog = await sceneCatalog();
  const safeScenes = safeScenesForModel(catalog);
  const serialized = JSON.stringify(safeScenes);

  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map((scene) => scene.sceneId), ["real-scene-id", "real-other-scene-id"]);
  assert.equal(catalog.every((scene) => scene.homeId === homeId), true);
  assert.match(catalog[0].alias, /^scene_[0-9a-f]{16}$/);
  assert.equal(serialized.includes("real-scene-id"), false);
  assert.equal(serialized.includes("real-other-scene-id"), false);
  assert.equal(serialized.includes("raw-user-id"), false);
  assert.deepEqual(safeScenes, [
    {
      id: catalog[0].alias,
      name: "回家模式",
      description: "当前家庭的手动场景：回家模式",
    },
    {
      id: catalog[1].alias,
      name: "观影模式",
      description: "当前家庭的手动场景：观影模式",
    },
  ]);

  const otherPrincipalCatalog = await sceneCatalog(otherPrincipalId);
  assert.notEqual(otherPrincipalCatalog[0].alias, catalog[0].alias);
});
