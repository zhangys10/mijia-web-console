import assert from "node:assert/strict";
import test from "node:test";

import { loadQuotaPolicy, QuotaPolicyError, resolveQuotaPolicy } from "../lib/ai/quota/policy.ts";

const overridePrincipalId = "usr_override_user";
const unlimitedPrincipalId = "usr_unlimited_user";

const validEnv = {
  AI_QUOTA_ENABLED: "true",
  AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE: "12",
  AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "100",
  AI_QUOTA_DEFAULT_TOKENS_PER_MONTH: "1000",
  AI_QUOTA_UNLIMITED_IDS: `${unlimitedPrincipalId}, usr_other`,
  AI_QUOTA_OVERRIDES_JSON: JSON.stringify({
    [overridePrincipalId]: { requestsPerDay: 300, tokensPerMonth: 3000 },
  }),
  AI_QUOTA_FAIL_MODE: "closed",
};

test("loadQuotaPolicy parses defaults, allowlist, overrides, and fail mode", () => {
  const policy = loadQuotaPolicy(validEnv);
  assert.equal(policy.enabled, true);
  assert.equal(policy.failMode, "closed");
  assert.deepEqual(policy.defaultLimits, {
    requestsPerMinute: 12,
    requestsPerDay: 100,
    tokensPerMonth: 1000,
  });
  assert.deepEqual(policy.unlimitedIds, [unlimitedPrincipalId, "usr_other"]);
  assert.deepEqual(policy.overrides[overridePrincipalId], {
    requestsPerDay: 300,
    tokensPerMonth: 3000,
  });
});

test("resolveQuotaPolicy uses unlimited > override > default and supports disabled mode", () => {
  const policy = loadQuotaPolicy(validEnv);
  assert.equal(resolveQuotaPolicy(unlimitedPrincipalId, policy).mode, "unlimited");
  assert.deepEqual(resolveQuotaPolicy(overridePrincipalId, policy), {
    mode: "override",
    limits: {
      requestsPerMinute: 12,
      requestsPerDay: 300,
      tokensPerMonth: 3000,
    },
  });
  assert.deepEqual(resolveQuotaPolicy("usr_default", policy), {
    mode: "default",
    limits: policy.defaultLimits,
  });

  const disabledPolicy = loadQuotaPolicy({ ...validEnv, AI_QUOTA_ENABLED: "false" });
  assert.deepEqual(resolveQuotaPolicy("usr_default", disabledPolicy), {
    mode: "disabled",
    limits: null,
  });
});

test("loadQuotaPolicy fails fast on invalid quota configuration", () => {
  const invalidCases = [
    { AI_QUOTA_ENABLED: "yes" },
    { AI_QUOTA_FAIL_MODE: "relaxed" },
    { AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE: "abc" },
    { AI_QUOTA_DEFAULT_REQUESTS_PER_DAY: "0" },
    { AI_QUOTA_DEFAULT_TOKENS_PER_MONTH: "10000000001" },
    { AI_QUOTA_UNLIMITED_IDS: "email@example.com" },
    { AI_QUOTA_OVERRIDES_JSON: "not-json" },
    { AI_QUOTA_OVERRIDES_JSON: JSON.stringify(["array"]) },
    { AI_QUOTA_OVERRIDES_JSON: JSON.stringify({ usr_invalid: {} }) },
    { AI_QUOTA_OVERRIDES_JSON: JSON.stringify({ usr_valid: { unknownField: 1 } }) },
    { AI_QUOTA_OVERRIDES_JSON: JSON.stringify({ usr_valid: { requestsPerDay: 0 } }) },
  ];

  for (const overrides of invalidCases) {
    assert.throws(
      () => loadQuotaPolicy({ ...validEnv, ...overrides }),
      (error) => error instanceof QuotaPolicyError && error.code === "AI_QUOTA_CONFIG_INVALID",
    );
  }
});

test("resolveQuotaPolicy rejects malformed principal IDs", () => {
  const policy = loadQuotaPolicy(validEnv);
  for (const principalId of ["", "user_invalid", "usr_/bad", "usr space"]) {
    assert.throws(
      () => resolveQuotaPolicy(principalId, policy),
      (error) => error instanceof QuotaPolicyError && error.code === "AI_QUOTA_PRINCIPAL_INVALID",
    );
  }
});
