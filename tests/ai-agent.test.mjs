import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentBindingError,
  createAgentBinding,
  verifyAgentBinding,
} from "../lib/ai/security/agent-binding.ts";
import {
  buildAgentSceneCatalog,
  loadAgentScenes,
  safeScenesForModel,
} from "../lib/ai/tools/agent-scene-catalog.ts";
import { parseManualScenes, sceneDeviceCapabilityKey } from "../lib/xiaomi-scenes.ts";

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

const lightAction = (deviceName, room = "客厅") => ({
  order: 0,
  label: "开启灯光",
  deviceName,
  room,
  details: [{ kind: "power", label: "电源", value: "开启" }],
});

const scenes = [
  { id: "real-scene-id", homeId, name: "回家模式", enabled: true, actionCount: 2, actions: [lightAction("客厅灯")] },
  { id: "real-other-scene-id", homeId, name: "观影模式", enabled: true, actionCount: 1, actions: [lightAction("客厅射灯")] },
  { id: "real-disabled-scene-id", homeId, name: "离家模式", enabled: false, actionCount: 1 },
  { id: "real-other-home-scene-id", homeId: otherHomeId, name: "其它家庭", enabled: true, actionCount: 1 },
];

async function sceneCatalog(principal = principalId, home = homeId) {
  return buildAgentSceneCatalog({
    principalId: principal,
    homeId: home,
    scenes,
    devices: [
      { name: "客厅灯", room: "客厅", kind: "light" },
      { name: "客厅射灯", room: "客厅", kind: "light" },
    ],
  });
}

test("parsed scene revisions bind hidden target identifiers without exposing them", async () => {
  async function revision(targetDid, sceneName = "回家模式") {
    const devices = [{ did: targetDid, homeId, roomName: "客厅", name: "客厅灯" }];
    const capabilities = new Map([[sceneDeviceCapabilityKey(homeId, targetDid), [{
      name: "light",
      properties: [{ name: "on", label: "电源", siid: 2, piid: 1, format: "bool", readable: true, writable: true }],
    }]]]);
    const [scene] = parseManualScenes({ result: [{
      scene_id: "private-real-id",
      home_id: homeId,
      name: sceneName,
      enable: 1,
      scene_trigger: { triggers: [{ src: "user" }] },
      scene_action: { actions: [{
        order: 1,
        name: "开灯",
        payload_json: { command: "set_properties", device_name: "客厅灯", did: targetDid, value: [{ siid: 2, piid: 1, value: true }] },
      }] },
    }] }, homeId, devices, capabilities);
    return buildAgentSceneCatalog({
      principalId,
      homeId,
      scenes: [scene],
      devices: [{ name: "客厅灯", room: "客厅", kind: "light" }],
    });
  }
  const first = await revision("private-target-a");
  const replacement = await revision("private-target-b");
  const renamed = await revision("private-target-a", "新的场景名称");
  assert.notEqual(first[0].revision, replacement[0].revision);
  assert.equal(first[0].revision, renamed[0].revision);
  assert.equal("risk" in first[0], false);
  assert.doesNotMatch(JSON.stringify(safeScenesForModel(first)), /private-target-a|private-real-id/);
});

test("live catalog loader enriches manual scenes", async () => {
  const rawScene = {
    scene_id: "private-real-id",
    home_id: homeId,
    name: "回家模式",
    enable: 1,
    scene_trigger: { triggers: [{ src: "user" }] },
    scene_action: { actions: [{
      order: 1,
      name: "开灯",
      payload_json: { command: "set_properties", device_name: "客厅灯", did: "private-target", value: [{ siid: 2, piid: 1, value: true }] },
    }] },
  };
  const catalog = await loadAgentScenes({
    principalId,
    homeId,
    session,
    request: async () => ({ result: [rawScene] }),
    loadDevices: async () => ({ devices: [{ did: "private-target", homeId, roomName: "客厅", name: "客厅灯", model: "test.light" }] }),
    loadCapabilities: async () => ({ groups: [{
      name: "light",
      properties: [{ name: "on", label: "电源", siid: 2, piid: 1, format: "bool", readable: true, writable: true }],
    }] }),
  });
  assert.equal(catalog.length, 1);
  assert.equal("risk" in catalog[0], false);
  assert.deepEqual(catalog[0].actionSummaries[0], { room: "客厅", device: "客厅灯", actions: [{ label: "电源", value: "开启" }] });
  assert.doesNotMatch(JSON.stringify(safeScenesForModel(catalog)), /private-target|private-real-id/);
});

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

test("agent bindings default to read-only scope", async () => {
  const token = await createAgentBinding(
    { principalId, homeId, session, issuedAt: now - 60_000, expiresAt: now + 300_000 },
    sessionSecret,
  );
  const payload = await verifyAgentBinding(token, { principalId, homeId, now }, sessionSecret);
  assert.deepEqual(payload.scopes, ["ai:chat"]);
  await assert.rejects(
    verifyAgentBinding(token, { principalId, homeId, scopes: ["ai:chat", "scene:activate"], now }, sessionSecret),
    /AI_AGENT_BINDING_MISMATCH/,
  );
});

test("scene catalog exposes sanitized scenes of the home as principal-scoped aliases", async () => {
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
  assert.deepEqual(safeScenes.map(scene => scene.name), ["回家模式", "观影模式"]);
  assert.match(safeScenes[0].revision, /^rev_[a-f0-9]{24}$/);
  assert.deepEqual(safeScenes[0].actionSummaries, [{ room: "客厅", device: "客厅灯", actions: [{ label: "电源", value: "开启" }] }]);

  const otherPrincipalCatalog = await sceneCatalog(otherPrincipalId);
  assert.notEqual(otherPrincipalCatalog[0].alias, catalog[0].alias);
});

test("scene catalog does not filter manual scenes by action type or device category", async () => {
  const catalog = await buildAgentSceneCatalog({
    principalId,
    homeId,
    scenes: [{ id: "private-lock-scene", homeId, name: "门锁场景", enabled: true, actionCount: 1,
      actions: [{ order: 0, label: "开锁", deviceName: "门锁", room: "玄关", details: [{ kind: "unknown", label: "开锁", value: "执行" }] }] }],
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "门锁场景");
  assert.equal("risk" in catalog[0], false);
});

test("scene display name changes do not revoke an unchanged action approval", async () => {
  const original = { id: "private-scene", homeId, name: "旧名称", enabled: true, actionCount: 1, actions: [lightAction("客厅灯")] };
  const [before] = await buildAgentSceneCatalog({ principalId, homeId, scenes: [original] });
  const [renamed] = await buildAgentSceneCatalog({ principalId, homeId, scenes: [{ ...original, name: "新名称" }] });
  const [changed] = await buildAgentSceneCatalog({ principalId, homeId, scenes: [{ ...original, actions: [lightAction("另一盏灯")] }] });
  assert.equal(before.revision, renamed.revision);
  assert.notEqual(before.revision, changed.revision);
});
