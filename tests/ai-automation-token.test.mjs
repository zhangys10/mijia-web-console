import assert from "node:assert/strict";
import test from "node:test";

import {
  sealAutomationToken,
  openAutomationToken,
  computePrincipalId,
  AutomationTokenError,
} from "../lib/ai/security/automation-token.ts";

const fakeSecret = "test-secret-at-least-32-chars-long-for-automation-token";
const fakeSession = {
  userId: "user-12345",
  cUserId: "c-user-12345",
  ssecurity: "mock-ssecurity",
  serviceToken: "mock-serviceToken",
  region: "cn",
  deviceId: "mock-device",
  userAgent: "mock-agent",
  createdAt: Date.now(),
};

test("computePrincipalId generates deterministic SHA-256 hex hash", async () => {
  const p1 = await computePrincipalId("cn", "12345");
  const p2 = await computePrincipalId("cn", "12345");
  const p3 = await computePrincipalId("sg", "12345");
  assert.equal(p1, p2);
  assert.equal(p1.length, 64);
  assert.notEqual(p1, p3);
});

test("sealAutomationToken and openAutomationToken round trip successfully", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    homeId: "home-999",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-mock-key-for-test-isolation",
    issuedAt: now,
    expiresAt: now + 30 * 86400 * 1000,
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, keyId: "key-2026-01", env: "test" });
  assert.match(token, /^v1\.key-2026-01\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const decoded = await openAutomationToken(token, { secret: fakeSecret, expectedKeyId: "key-2026-01", env: "test", now });
  assert.deepEqual(decoded, payload);
});

test("two seal calls on the same payload produce different ciphertexts due to random IV", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-mock-key-for-test-isolation",
    issuedAt: now,
    expiresAt: now + 86400000,
  };

  const token1 = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  const token2 = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  assert.notEqual(token1, token2);
});

test("modifying IV, ciphertext, or authTag causes open to fail with AUTOMATION_TOKEN_INVALID", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-mock-key-for-test-isolation",
    issuedAt: now,
    expiresAt: now + 86400000,
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  const [prefix, keyId, iv, ct, tag] = token.split(".");

  // Tamper IV
  const tamperedIv = (iv[0] === "A" ? "B" : "A") + iv.slice(1);
  await assert.rejects(
    () => openAutomationToken(`${prefix}.${keyId}.${tamperedIv}.${ct}.${tag}`, { secret: fakeSecret, env: "test", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );

  // Tamper ciphertext
  const tamperedCt = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
  await assert.rejects(
    () => openAutomationToken(`${prefix}.${keyId}.${iv}.${tamperedCt}.${tag}`, { secret: fakeSecret, env: "test", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );

  // Tamper tag
  const tamperedTag = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
  await assert.rejects(
    () => openAutomationToken(`${prefix}.${keyId}.${iv}.${ct}.${tamperedTag}`, { secret: fakeSecret, env: "test", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );
});

test("malformed token segments, unexpected keyId or environment mismatch are rejected", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-secret-user-key-value",
    issuedAt: now,
    expiresAt: now + 86400000,
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, keyId: "key-1", env: "production" });

  // Wrong keyId
  await assert.rejects(
    () => openAutomationToken(token, { secret: fakeSecret, expectedKeyId: "key-2", env: "production", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );

  // Environment mismatch (AAD check)
  await assert.rejects(
    () => openAutomationToken(token, { secret: fakeSecret, keyId: "key-1", env: "preview", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );

  // Malformed structure
  await assert.rejects(
    () => openAutomationToken("invalid.token", { secret: fakeSecret }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );
  await assert.rejects(
    () => openAutomationToken("v2.key.iv.ct.tag", { secret: fakeSecret }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );
});

test("expired token is rejected with AUTOMATION_TOKEN_EXPIRED", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-mock-key-for-test-isolation",
    issuedAt: now - 10000,
    expiresAt: now - 1000, // already expired
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  await assert.rejects(
    () => openAutomationToken(token, { secret: fakeSecret, env: "test", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_EXPIRED"
  );
});

test("issuedAt in unreasonable future is rejected with AUTOMATION_TOKEN_INVALID", async () => {
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: "sk-mock-key-for-test-isolation",
    issuedAt: now + 10 * 60 * 1000, // 10 minutes in future
    expiresAt: now + 86400000,
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  await assert.rejects(
    () => openAutomationToken(token, { secret: fakeSecret, env: "test", now }),
    (err) => err instanceof AutomationTokenError && err.code === "AUTOMATION_TOKEN_INVALID"
  );
});

test("raw API key is never exposed in error messages", async () => {
  const secretKeyPattern = "sk-super-secret-user-key-value-12345";
  const now = Date.now();
  const principalId = await computePrincipalId("cn", fakeSession.userId);
  const payload = {
    version: 1,
    purpose: "ai-home-automation",
    principalId,
    xiaomiSession: fakeSession,
    region: "cn",
    provider: "qwen-cn",
    model: "qwen3.7-flash-2026-07-15",
    apiKey: secretKeyPattern,
    issuedAt: now - 10000,
    expiresAt: now - 1000, // expired to trigger error
  };

  const token = await sealAutomationToken(payload, { secret: fakeSecret, env: "test" });
  try {
    await openAutomationToken(token, { secret: fakeSecret, env: "test", now });
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.message.includes(secretKeyPattern), false);
    assert.equal(String(err).includes(secretKeyPattern), false);
  }
});
