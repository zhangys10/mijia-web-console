import assert from "node:assert/strict";
import test from "node:test";

import { openAutomationToken, sealAutomationToken, computePrincipalId } from "../lib/ai/security/automation-token.ts";

process.env.APP_ENV = "test";
process.env.XIAOMI_SESSION_SECRET = "test-secret-at-least-32-chars-long-for-isolation-test";
process.env.AI_AUTOMATION_TOKEN_SECRET = "test-secret-at-least-32-chars-long-for-isolation-test";
const tokenOptions = { secret: process.env.AI_AUTOMATION_TOKEN_SECRET, env: "test" };

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

test("User A and User B tokens resolve completely isolated sessions", async () => {
  const now = Date.now();
  const principalA = await computePrincipalId("cn", sessionA.userId);
  const principalB = await computePrincipalId("cn", sessionB.userId);

  const tokenA = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId: principalA,
    xiaomiSession: sessionA,
    region: "cn",
    issuedAt: now,
    expiresAt: now + 86400000,
  }, tokenOptions);

  const tokenB = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId: principalB,
    xiaomiSession: sessionB,
    region: "cn",
    homeId: "home-beta",
    issuedAt: now,
    expiresAt: now + 86400000,
  }, tokenOptions);

  const openedA = await openAutomationToken(tokenA, { ...tokenOptions, now });
  const openedB = await openAutomationToken(tokenB, { ...tokenOptions, now });

  assert.equal(openedA.xiaomiSession.userId, sessionA.userId);
  assert.equal(openedA.principalId, principalA);
  assert.equal(openedA.homeId, undefined);
  assert.equal(openedB.xiaomiSession.userId, sessionB.userId);
  assert.equal(openedB.principalId, principalB);
  assert.equal(openedB.homeId, "home-beta");
  assert.notEqual(openedA.xiaomiSession.ssecurity, openedB.xiaomiSession.ssecurity);
  assert.notEqual(openedA.principalId, openedB.principalId);
});

test("phase-3 tokens carry no BYOK fields and legacy BYOK tokens still open", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", sessionA.userId);
  const base = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: sessionA,
    region: "cn",
    issuedAt: now,
    expiresAt: now + 86400000,
  };

  const plain = await openAutomationToken(
    await sealAutomationToken(base, tokenOptions),
    { ...tokenOptions, now },
  );
  assert.equal(plain.provider, undefined);
  assert.equal(plain.model, undefined);
  assert.equal(plain.apiKey, undefined);

  // 旧 BYOK token（Phase 3 之前签发）仍能被打开；读取方自行忽略这些字段。
  const legacy = await openAutomationToken(
    await sealAutomationToken({ ...base, provider: "qwen-cn", model: "qwen3.7-flash", apiKey: "sk-legacy" }, tokenOptions),
    { ...tokenOptions, now },
  );
  assert.equal(legacy.apiKey, "sk-legacy");
});

test("expired automation tokens fail closed", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", sessionA.userId);
  const expired = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: sessionA,
    region: "cn",
    issuedAt: now - 86400000,
    expiresAt: now - 1000,
  }, tokenOptions);

  await assert.rejects(
    () => openAutomationToken(expired, { ...tokenOptions, now }),
    (err) => err.code === "AUTOMATION_TOKEN_EXPIRED",
  );
});

test("tampered automation tokens are rejected without secret leakage", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", sessionA.userId);
  const token = await sealAutomationToken({
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: sessionA,
    region: "cn",
    issuedAt: now,
    expiresAt: now + 86400000,
  }, tokenOptions);
  const [prefix, keyId, iv, ct, tag] = token.split(".");
  const tamperedTag = (tag[0] === "X" ? "Y" : "X") + tag.slice(1);
  const tamperedToken = `${prefix}.${keyId}.${iv}.${ct}.${tamperedTag}`;

  await assert.rejects(
    () => openAutomationToken(tamperedToken, { ...tokenOptions, now }),
    (err) => err.code === "AUTOMATION_TOKEN_INVALID",
  );
});
