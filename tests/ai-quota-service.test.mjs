import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryQuotaStore } from "../lib/ai/quota/in-memory-quota-store.ts";
import { loadQuotaPolicy } from "../lib/ai/quota/policy.ts";
import { QuotaService } from "../lib/ai/quota/quota-service.ts";
import { QuotaStoreError } from "../lib/ai/quota/quota-store.ts";

const fixedTime = Date.UTC(2026, 8, 17, 1, 0);
const principalId = "usr_service_user";
const unlimitedId = "usr_service_unlimited";
const overrideId = "usr_service_override";

function createService(overrides = {}) {
  const policy = loadQuotaPolicy({
    AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE: "10",
    AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "10",
    AI_QUOTA_DEFAULT_TOKENS_PER_MONTH: "100",
    AI_QUOTA_UNLIMITED_IDS: unlimitedId,
    AI_QUOTA_OVERRIDES_JSON: JSON.stringify({ [overrideId]: { tokensPerMonth: 500 } }),
    AI_QUOTA_FAIL_MODE: "closed",
    ...overrides,
  });
  const store = new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
  return { service: new QuotaService(store, policy, { now: () => fixedTime }), store, policy };
}

test("QuotaService reserves, commits actual usage, and reports remaining quota", async () => {
  const { service } = createService();
  const lease = await service.reserve(principalId, 30);
  assert.equal(lease.mode, "default");
  assert.equal(lease.estimatedTokens, 30);

  await service.commit(lease, { promptTokens: 18, completionTokens: 5 });
  const summary = await service.getSummary(principalId);

  assert.equal(summary.mode, "default");
  assert.equal(summary.usage.requestsToday, 1);
  assert.equal(summary.usage.totalTokensThisMonth, 23);
  assert.equal(summary.remaining.requestsToday, 9);
  assert.equal(summary.remaining.tokensThisMonth, 77);
  assert.equal(summary.resetAt, "2026-09-18T00:00:00+08:00");
  assert.equal(summary.softLimit, true);
});

test("QuotaService releases a reservation when the request fails", async () => {
  const { service } = createService();
  const lease = await service.reserve(principalId, 40);
  await service.release(lease);

  const summary = await service.getSummary(principalId);
  assert.equal(summary.usage.requestsToday, 0);
  assert.equal(summary.usage.totalTokensThisMonth, 0);
});

test("override and unlimited principals keep their effective modes", async () => {
  const { service } = createService();

  const overrideSummary = await service.getSummary(overrideId);
  assert.equal(overrideSummary.mode, "override");
  assert.equal(overrideSummary.limits.tokensPerMonth, 500);

  const unlimitedSummary = await service.getSummary(unlimitedId);
  assert.equal(unlimitedSummary.mode, "unlimited");
  assert.equal(unlimitedSummary.limits, null);
  assert.equal(unlimitedSummary.remaining.requestsToday, null);

  const lease = await service.reserve(unlimitedId, 999);
  await service.commit(lease, { promptTokens: 100_000, completionTokens: 1 });
  const metrics = await service.getSummary(unlimitedId);
  assert.equal(metrics.usage.totalTokensThisMonth, 100_001);
});

test("QuotaService fails closed when the store is unavailable", async () => {
  const policy = loadQuotaPolicy({ AI_QUOTA_FAIL_MODE: "closed" });
  const failingStore = {
    async reserve() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
    async commit() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
    async release() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
    async getSnapshot() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
  };
  const service = new QuotaService(failingStore, policy, { now: () => fixedTime });

  await assert.rejects(
    () => service.reserve(principalId, 10),
    (error) => error instanceof QuotaStoreError,
  );
  await assert.rejects(
    () => service.getSummary(principalId),
    (error) => error instanceof QuotaStoreError,
  );
});

test("QuotaService open fail mode degrades to untracked leases instead of blocking", async () => {
  const policy = loadQuotaPolicy({ AI_QUOTA_FAIL_MODE: "open" });
  const failingStore = {
    async reserve() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
    async commit() {},
    async release() {},
    async getSnapshot() {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "store down");
    },
  };
  const service = new QuotaService(failingStore, policy, { now: () => fixedTime });

  const lease = await service.reserve(principalId, 10);
  assert.equal(lease.untracked, true);
  await service.commit(lease, { promptTokens: 1, completionTokens: 1 });
  await service.release(lease);

  const summary = await service.getSummary(principalId);
  assert.equal(summary.usage, null);
  assert.equal(summary.remaining.tokensThisMonth, null);
});

test("QuotaService rejects invalid principals and estimates", async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.reserve("user_invalid", 10),
    (error) => error.code === "AI_QUOTA_PRINCIPAL_INVALID",
  );
  await assert.rejects(
    () => service.reserve(principalId, 0),
    (error) => error.code === "AI_QUOTA_ESTIMATE_INVALID",
  );
  await assert.rejects(
    () => service.commit({ id: "lease", principalId, estimatedTokens: 1, createdAt: "", unlimited: false, mode: "default", keys: { minute: "a", day: "b", month: "c" } }, { promptTokens: -1, completionTokens: 0 }),
    (error) => error.code === "AI_QUOTA_USAGE_INVALID",
  );
});
