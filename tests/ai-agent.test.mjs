import assert from "node:assert/strict";
import test from "node:test";

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
    approvedSceneIds: new Set(["real-scene-id", "real-disabled-scene-id", "real-other-home-scene-id"]),
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
