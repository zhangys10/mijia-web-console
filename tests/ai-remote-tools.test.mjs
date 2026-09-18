import test from "node:test";
import assert from "node:assert/strict";
import { authorizeRemoteTool, runRemoteTool } from "../lib/ai/tools/remote-tool-service.ts";
import { createAgentBinding } from "../lib/ai/security/agent-binding.ts";
import { derivePrincipalId } from "../lib/ai/security/principal.ts";

const env = { XIAOMI_SESSION_SECRET: "test-session-secret-not-real-123456789", AI_PRINCIPAL_SECRET: "test-principal-secret-not-real-123456789" };
const session = { userId: "test-user", serviceToken: "fake-token", ssecurity: "fake-security", region: "cn" };
async function input(scopes = ["ai:chat"]) {
  const principalId = await derivePrincipalId(session, env);
  return { requestId: "req_test_remote_tool", principalId, homeId: "test-home", scopes,
    sessionBinding: await createAgentBinding({ principalId, homeId: "test-home", scopes, session, expiresAt: Date.now() + 60000 }, env.XIAOMI_SESSION_SECRET),
    tool: "list_scenes", arguments: {} };
}
const dependencies = { homes: async () => [{ id: "test-home" }], scenes: async () => [{ alias: "scene_0123456789abcdef", sceneId: "private-real-id", homeId: "test-home", name: "回家模式", description: "审核场景", actionCount: 1 }] };

test("remote tools require independent service authentication", async () => {
  const secret = "test-tools-secret-not-real-123456789";
  assert.equal(await authorizeRemoteTool(`Bearer ${secret}`, secret), true);
  assert.equal(await authorizeRemoteTool("Bearer wrong", secret), false);
  assert.equal(await authorizeRemoteTool(null, secret), false);
});
test("catalog response never exports private scene or Xiaomi credentials", async () => {
  const result = await runRemoteTool(await input(), env, dependencies);
  assert.equal(result.scenes[0].alias, "scene_0123456789abcdef");
  for (const secret of ["private-real-id", "fake-token", "fake-security", "test-user"]) assert.ok(!JSON.stringify(result).includes(secret));
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
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef" },
  };
  await assert.rejects(runRemoteTool(body, env, dependencies), /AI_SCENE_EXECUTION_DISABLED/);
});

test("remote execution requires a valid idempotency key and strict scene argument", async () => {
  const base = {
    ...await input(["ai:chat", "scene:activate"]),
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef" },
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
      arguments: { sceneId: "scene_0123456789abcdef", extra: 1 },
    }, env, dependencies),
    /AI_INVALID_REQUEST/,
  );
});

test("remote execution stays read-only under both preview environment flags", async () => {
  const body = {
    ...await input(["ai:chat", "scene:activate"]),
    idempotencyKey: "valid-idempotency-key-0001",
    tool: "activate_scene",
    arguments: { sceneId: "scene_0123456789abcdef" },
  };
  for (const previewEnv of [
    { AI_ENVIRONMENT: "preview" },
    { VERCEL_ENV: "preview" },
  ]) {
    await assert.rejects(
      runRemoteTool(body, { ...env, ...previewEnv }, dependencies),
      /AI_PREVIEW_READ_ONLY/,
    );
  }
});
