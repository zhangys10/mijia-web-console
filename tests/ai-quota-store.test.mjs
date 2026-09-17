import assert from "node:assert/strict";
import test from "node:test";

import { principalKeyFromPrincipalId, quotaKey, quotaPeriodWindows } from "../lib/ai/quota/periods.ts";
import { EdgeOneKvQuotaStore } from "../lib/ai/quota/edgeone-kv-quota-store.ts";
import { InMemoryQuotaStore } from "../lib/ai/quota/in-memory-quota-store.ts";
import { QuotaExceededError, QuotaStoreError } from "../lib/ai/quota/quota-store.ts";

const fixedTime = Date.UTC(2026, 8, 17, 1, 0);
const limits = {
  requestsPerMinute: 2,
  requestsPerDay: 3,
  tokensPerMonth: 100,
};

function memoryStore() {
  return new InMemoryQuotaStore({ env: "test", now: () => fixedTime });
}

test("quota periods use Asia/Shanghai and remain DST-independent", () => {
  const windows = quotaPeriodWindows(fixedTime);
  assert.equal(windows.dayKey, "20260917");
  assert.equal(windows.monthKey, "202609");
  assert.equal(windows.dayResetAt, "2026-09-18T00:00:00+08:00");
  assert.equal(windows.monthResetAt, "2026-10-01T00:00:00+08:00");

  const leapDay = quotaPeriodWindows(Date.UTC(2028, 1, 28, 16, 30));
  assert.equal(leapDay.dayKey, "20280229");
  assert.equal(leapDay.dayResetAt, "2028-03-01T00:00:00+08:00");

  const monthEnd = quotaPeriodWindows(Date.UTC(2026, 11, 31, 16, 30));
  assert.equal(monthEnd.dayKey, "20270101");
  assert.equal(monthEnd.monthResetAt, "2027-02-01T00:00:00+08:00");
});

test("principal key is a truncated SHA-256 hexadecimal segment", async () => {
  const principalId = "usr_user_with_long_id";
  const key = await principalKeyFromPrincipalId(principalId);
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(key.includes(principalId), false);
});

test("InMemoryQuotaStore reserves, commits actual usage, and releases cleanly", async () => {
  const store = memoryStore();
  const lease = await store.reserve({
    principalId: "usr_store_user",
    estimatedTokens: 20,
    limits,
    unlimited: false,
  });

  let snapshot = await store.getSnapshot("usr_store_user");
  assert.equal(snapshot.requestsToday, 1);
  assert.equal(snapshot.totalTokensThisMonth, 20);
  assert.equal(snapshot.estimatedTokensThisMonth, 20);

  await store.commit(lease, { promptTokens: 12, completionTokens: 4 });
  snapshot = await store.getSnapshot("usr_store_user");
  assert.equal(snapshot.requestsToday, 1);
  assert.equal(snapshot.promptTokensThisMonth, 12);
  assert.equal(snapshot.completionTokensThisMonth, 4);
  assert.equal(snapshot.estimatedTokensThisMonth, 0);
  assert.equal(snapshot.totalTokensThisMonth, 16);

  const releaseLease = await store.reserve({
    principalId: "usr_release_user",
    estimatedTokens: 10,
    limits,
    unlimited: false,
  });
  await store.release(releaseLease);
  const released = await store.getSnapshot("usr_release_user");
  assert.equal(released.requestsToday, 0);
  assert.equal(released.totalTokensThisMonth, 0);
});

test("InMemoryQuotaStore maps minute, day, and month rejections with reset times", async () => {
  const store = memoryStore();
  for (let index = 0; index < 2; index += 1) {
    await store.reserve({
      principalId: "usr_minute_user",
      estimatedTokens: 1,
      limits,
      unlimited: false,
    });
  }
  await assert.rejects(
    () => store.reserve({ principalId: "usr_minute_user", estimatedTokens: 1, limits, unlimited: false }),
    (error) => error instanceof QuotaExceededError && error.period === "minute",
  );

  const dayStore = new InMemoryQuotaStore({
    env: "test",
    now: () => fixedTime,
  });
  const dayLimits = { ...limits, requestsPerMinute: 10 };
  for (let index = 0; index < 3; index += 1) {
    await dayStore.reserve({ principalId: "usr_day_user", estimatedTokens: 1, limits: dayLimits, unlimited: false });
  }
  await assert.rejects(
    () => dayStore.reserve({ principalId: "usr_day_user", estimatedTokens: 1, limits: dayLimits, unlimited: false }),
    (error) => error instanceof QuotaExceededError && error.period === "day",
  );

  const monthStore = memoryStore();
  await assert.rejects(
    () => monthStore.reserve({ principalId: "usr_month_user", estimatedTokens: 101, limits, unlimited: false }),
    (error) => error instanceof QuotaExceededError && error.period === "month",
  );
});

class MemoryKv {
  constructor() {
    this.values = new Map();
    this.keys = [];
  }
  async get(key) {
    return this.values.get(key) ?? null;
  }
  async put(key, value) {
    this.keys.push(key);
    this.values.set(key, value);
  }
}

test("EdgeOneKvQuotaStore uses safe keys and records compact JSON usage", async () => {
  const kv = new MemoryKv();
  const store = new EdgeOneKvQuotaStore(kv, { env: "test", now: () => fixedTime });
  const lease = await store.reserve({
    principalId: "usr_kv_user",
    estimatedTokens: 15,
    limits,
    unlimited: false,
  });
  await store.commit(lease, { promptTokens: 10, completionTokens: 3 });

  assert.equal(kv.keys.length, 6);
  for (const key of kv.keys) {
    assert.match(key, /^q_v1_test_[a-f0-9]{32}_(?:min|d|m)_\d+$/);
    assert.equal(key.includes("usr_kv_user"), false);
  }
  const monthKey = kv.keys.find((key) => key.includes("_m_"));
  const usage = JSON.parse(kv.values.get(monthKey));
  assert.equal(usage.requests, 1);
  assert.equal(usage.promptTokens, 10);
  assert.equal(usage.completionTokens, 3);
  assert.equal(usage.estimatedTokens, 0);
  assert.equal(typeof usage.updatedAt, "string");
});

test("EdgeOneKvQuotaStore fails closed on malformed stored values", async () => {
  const kv = new MemoryKv();
  const principalKey = await principalKeyFromPrincipalId("usr_bad_user");
  kv.values.set(quotaKey("test", principalKey, "m", quotaPeriodWindows(fixedTime).monthKey), "not-json");
  const store = new EdgeOneKvQuotaStore(kv, { env: "test", now: () => fixedTime });
  await assert.rejects(
    () => store.getSnapshot("usr_bad_user"),
    (error) => error instanceof QuotaStoreError && error.code === "AI_QUOTA_STORE_UNAVAILABLE",
  );
});

test("synthetic propagation window documents soft-limit overuse rather than hard rejection", async () => {
  const written = new Map();
  const staleKv = {
    async get() {
      return null;
    },
    async put(key, value) {
      written.set(key, value);
    },
  };
  const store = new EdgeOneKvQuotaStore(staleKv, { env: "test", now: () => fixedTime });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () =>
    store.reserve({
      principalId: "usr_concurrent_user",
      estimatedTokens: 1,
      limits,
      unlimited: false,
    }),
  ));
  const accepted = results.filter((result) => result.status === "fulfilled").length;

  assert.equal(accepted, 5);
  assert.ok(accepted > limits.requestsPerDay);
  assert.ok(written.size > 0);
});
