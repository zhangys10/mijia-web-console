export type QuotaEnvironment = Record<string, string | undefined>;

export type QuotaLimits = {
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerMonth: number;
};

export type QuotaMode = "default" | "override" | "unlimited" | "disabled";
export type QuotaFailMode = "closed" | "open";

export type QuotaPolicy = {
  enabled: boolean;
  failMode: QuotaFailMode;
  defaultLimits: QuotaLimits;
  unlimitedIds: string[];
  overrides: Record<string, Partial<QuotaLimits>>;
};

export type ResolvedQuotaPolicy = {
  mode: QuotaMode;
  limits: QuotaLimits | null;
};

export class QuotaPolicyError extends Error {
  readonly code: "AI_QUOTA_CONFIG_INVALID" | "AI_QUOTA_PRINCIPAL_INVALID";

  constructor(code: QuotaPolicyError["code"], message: string) {
    super(message);
    this.name = "QuotaPolicyError";
    this.code = code;
  }
}

const PRINCIPAL_ID_PATTERN = /^usr_[A-Za-z0-9_-]{1,128}$/;
const LIMIT_FIELDS = ["requestsPerMinute", "requestsPerDay", "tokensPerMonth"] as const;
const MAX_LIMITS: Record<keyof QuotaLimits, number> = {
  requestsPerMinute: 10_000,
  requestsPerDay: 1_000_000,
  tokensPerMonth: 10_000_000_000,
};

export function isValidPrincipalId(principalId: string) {
  return PRINCIPAL_ID_PATTERN.test(principalId);
}

function bool(env: QuotaEnvironment, name: string, fallback: boolean) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${name} 必须是 true 或 false`);
}

function positiveInteger(
  env: QuotaEnvironment,
  name: string,
  fallback: number,
  maximum: number,
) {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${name} 必须在 1 到 ${maximum} 之间`);
  }
  return parsed;
}

function parseUnlimitedIds(value: string | undefined) {
  const ids = Array.from(new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
  for (const id of ids) {
    if (!isValidPrincipalId(id)) {
      throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `AI_QUOTA_UNLIMITED_IDS 包含非法 principalId: ${id}`);
    }
  }
  return ids;
}

function parseOverrides(value: string | undefined): Record<string, Partial<QuotaLimits>> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", "AI_QUOTA_OVERRIDES_JSON 必须是合法 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", "AI_QUOTA_OVERRIDES_JSON 必须是 JSON 对象");
  }

  const overrides: Record<string, Partial<QuotaLimits>> = {};
  for (const [principalId, rawLimits] of Object.entries(parsed)) {
    if (!isValidPrincipalId(principalId)) {
      throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `AI_QUOTA_OVERRIDES_JSON 包含非法 principalId: ${principalId}`);
    }
    if (typeof rawLimits !== "object" || rawLimits === null || Array.isArray(rawLimits)) {
      throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${principalId} 的配额覆盖必须是对象`);
    }

    const limitRecord = rawLimits as Record<string, unknown>;
    for (const field of Object.keys(limitRecord)) {
      if (!LIMIT_FIELDS.includes(field as (typeof LIMIT_FIELDS)[number])) {
        throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${principalId} 的配额覆盖包含未知字段 ${field}`);
      }
    }
    if (!Object.keys(limitRecord).length) {
      throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${principalId} 的配额覆盖不能为空`);
    }

    const override: Partial<QuotaLimits> = {};
    for (const field of LIMIT_FIELDS) {
      const rawValue = limitRecord[field];
      if (rawValue === undefined) continue;
      const parsedValue = typeof rawValue === "number" ? rawValue : Number(String(rawValue));
      if (!Number.isSafeInteger(parsedValue) || parsedValue < 1 || parsedValue > MAX_LIMITS[field]) {
        throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", `${principalId}.${field} 必须在 1 到 ${MAX_LIMITS[field]} 之间`);
      }
      override[field] = parsedValue;
    }
    overrides[principalId] = override;
  }
  return overrides;
}

export function loadQuotaPolicy(env: QuotaEnvironment = process.env): QuotaPolicy {
  const failModeValue = env.AI_QUOTA_FAIL_MODE ?? "closed";
  if (failModeValue !== "closed" && failModeValue !== "open") {
    throw new QuotaPolicyError("AI_QUOTA_CONFIG_INVALID", "AI_QUOTA_FAIL_MODE 只允许 closed 或 open");
  }

  return {
    enabled: bool(env, "AI_QUOTA_ENABLED", true),
    failMode: failModeValue,
    defaultLimits: {
      requestsPerMinute: positiveInteger(env, "AI_QUOTA_DEFAULT_REQUESTS_PER_MINUTE", 10, MAX_LIMITS.requestsPerMinute),
      requestsPerDay: positiveInteger(env, "AI_QUOTA_DEFAULT_REQUESTS_PER_DAY", 50, MAX_LIMITS.requestsPerDay),
      tokensPerMonth: positiveInteger(env, "AI_QUOTA_DEFAULT_TOKENS_PER_MONTH", 100_000, MAX_LIMITS.tokensPerMonth),
    },
    unlimitedIds: parseUnlimitedIds(env.AI_QUOTA_UNLIMITED_IDS),
    overrides: parseOverrides(env.AI_QUOTA_OVERRIDES_JSON),
  };
}

export function resolveQuotaPolicy(
  principalId: string,
  policy: QuotaPolicy,
): ResolvedQuotaPolicy {
  if (!isValidPrincipalId(principalId)) {
    throw new QuotaPolicyError("AI_QUOTA_PRINCIPAL_INVALID", "principalId 格式无效");
  }
  if (!policy.enabled) return { mode: "disabled", limits: null };
  if (policy.unlimitedIds.includes(principalId)) return { mode: "unlimited", limits: null };
  if (Object.hasOwn(policy.overrides, principalId)) {
    return {
      mode: "override",
      limits: { ...policy.defaultLimits, ...policy.overrides[principalId] },
    };
  }
  return { mode: "default", limits: { ...policy.defaultLimits } };
}
