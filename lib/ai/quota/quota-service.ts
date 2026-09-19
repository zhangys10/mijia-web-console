import { quotaPeriodWindows } from "./periods.ts";
import type { QuotaPolicy, QuotaMode, QuotaLimits, ResolvedQuotaPolicy } from "./policy.ts";
import { isValidPrincipalId, resolveQuotaPolicy } from "./policy.ts";
import type { QuotaActualUsage, QuotaLease, QuotaSnapshot, QuotaStore } from "./quota-store.ts";
import { QuotaStoreError } from "./quota-store.ts";

export class QuotaServiceError extends Error {
  readonly code: "AI_QUOTA_PRINCIPAL_INVALID" | "AI_QUOTA_ESTIMATE_INVALID" | "AI_QUOTA_USAGE_INVALID";

  constructor(code: QuotaServiceError["code"], message: string) {
    super(message);
    this.name = "QuotaServiceError";
    this.code = code;
  }
}

export type QuotaSummary = {
  principalId: string;
  mode: QuotaMode;
  limits: QuotaLimits | null;
  usage: QuotaSnapshot | null;
  remaining: {
    requestsThisMinute: number | null;
    requestsToday: number | null;
    tokensThisMonth: number | null;
  };
  resetAt: string | null;
  softLimit: true;
};

export function disabledQuotaSummary(principalId: string): QuotaSummary {
  return {
    principalId,
    mode: "disabled",
    limits: null,
    usage: null,
    remaining: {
      requestsThisMinute: null,
      requestsToday: null,
      tokensThisMonth: null,
    },
    resetAt: null,
    softLimit: true,
  };
}

const MAX_ESTIMATED_TOKENS = 1_000_000;

type QuotaServiceOptions = {
  now?: () => number;
};

function validateActualUsage(usage: QuotaActualUsage) {
  if (
    !Number.isSafeInteger(usage.promptTokens)
    || !Number.isSafeInteger(usage.completionTokens)
    || usage.promptTokens < 0
    || usage.completionTokens < 0
    || (usage.estimated !== undefined && typeof usage.estimated !== "boolean")
  ) {
    throw new QuotaServiceError("AI_QUOTA_USAGE_INVALID", "实际模型 usage 必须是非负安全整数");
  }
}

export class QuotaService {
  private readonly store: QuotaStore;
  private readonly policy: QuotaPolicy;
  private readonly now: () => number;

  constructor(store: QuotaStore, policy: QuotaPolicy, options: QuotaServiceOptions = {}) {
    this.store = store;
    this.policy = policy;
    this.now = options.now ?? Date.now;
  }

  private resolved(principalId: string): ResolvedQuotaPolicy {
    if (!isValidPrincipalId(principalId)) {
      throw new QuotaServiceError("AI_QUOTA_PRINCIPAL_INVALID", "principalId 格式无效");
    }
    return resolveQuotaPolicy(principalId, this.policy);
  }

  private untrackedLease(principalId: string, mode: QuotaMode): QuotaLease {
    return {
      id: crypto.randomUUID(),
      principalId,
      estimatedTokens: 0,
      createdAt: new Date(this.now()).toISOString(),
      unlimited: true,
      mode,
      untracked: true,
    };
  }

  private summaryFromSnapshot(
    principalId: string,
    resolved: ResolvedQuotaPolicy,
    snapshot: QuotaSnapshot | null,
  ): QuotaSummary {
    const unlimited = resolved.mode === "unlimited" || resolved.mode === "disabled";
    const windows = quotaPeriodWindows(this.now());
    return {
      principalId,
      mode: resolved.mode,
      limits: resolved.limits,
      usage: snapshot,
      remaining: unlimited || !resolved.limits || !snapshot ? {
        requestsThisMinute: null,
        requestsToday: null,
        tokensThisMonth: null,
      } : {
        requestsThisMinute: Math.max(0, resolved.limits.requestsPerMinute - snapshot.requestsThisMinute),
        requestsToday: Math.max(0, resolved.limits.requestsPerDay - snapshot.requestsToday),
        tokensThisMonth: Math.max(0, resolved.limits.tokensPerMonth - snapshot.totalTokensThisMonth),
      },
      resetAt: unlimited ? null : windows.dayResetAt,
      softLimit: true,
    };
  }

  async reserve(principalId: string, estimatedTokens: number): Promise<QuotaLease> {
    const resolved = this.resolved(principalId);
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1 || estimatedTokens > MAX_ESTIMATED_TOKENS) {
      throw new QuotaServiceError("AI_QUOTA_ESTIMATE_INVALID", "预估 Token 必须在 1 到 1000000 之间");
    }
    if (resolved.mode === "disabled") return this.untrackedLease(principalId, "disabled");

    try {
      const lease = await this.store.reserve({
        principalId,
        estimatedTokens,
        limits: resolved.limits,
        unlimited: resolved.mode === "unlimited",
      });
      return { ...lease, mode: resolved.mode };
    } catch (error) {
      if (error instanceof QuotaStoreError && this.policy.failMode === "open") {
        return this.untrackedLease(principalId, resolved.mode);
      }
      throw error;
    }
  }

  async commit(lease: QuotaLease, usage: QuotaActualUsage): Promise<void> {
    validateActualUsage(usage);
    if (lease.untracked) return;
    try {
      await this.store.commit(lease, usage);
    } catch (error) {
      if (error instanceof QuotaStoreError && this.policy.failMode === "open") return;
      throw error;
    }
  }

  async release(lease: QuotaLease): Promise<void> {
    if (lease.untracked) return;
    try {
      await this.store.release(lease);
    } catch (error) {
      if (error instanceof QuotaStoreError && this.policy.failMode === "open") return;
      throw error;
    }
  }

  async getSummary(principalId: string): Promise<QuotaSummary> {
    const resolved = this.resolved(principalId);
    if (resolved.mode === "disabled") {
      return disabledQuotaSummary(principalId);
    }
    try {
      const snapshot = await this.store.getSnapshot(principalId);
      return this.summaryFromSnapshot(principalId, resolved, snapshot);
    } catch (error) {
      if (error instanceof QuotaStoreError && this.policy.failMode === "open") {
        return this.summaryFromSnapshot(principalId, resolved, null);
      }
      throw error;
    }
  }
}
