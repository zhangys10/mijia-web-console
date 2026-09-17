import {
  principalKeyFromPrincipalId,
  quotaKey,
  quotaPeriodWindows,
} from "./periods.ts";
import type {
  QuotaActualUsage,
  QuotaLease,
  QuotaPeriodKeys,
  QuotaReservation,
  QuotaSnapshot,
  QuotaStore,
  QuotaUsage,
} from "./quota-store.ts";
import { QuotaExceededError, QuotaStoreError } from "./quota-store.ts";

type InMemoryQuotaStoreOptions = {
  env?: string;
  now?: () => number;
};

function emptyUsage(now: number): QuotaUsage {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    estimatedTokens: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

function totalTokens(usage: QuotaUsage) {
  return usage.promptTokens + usage.completionTokens + usage.estimatedTokens;
}

function latestUpdatedAt(...usages: QuotaUsage[]) {
  return usages.map((usage) => usage.updatedAt).sort().at(-1) ?? new Date(0).toISOString();
}

export class InMemoryQuotaStore implements QuotaStore {
  private readonly env: string;
  private readonly now: () => number;
  private readonly records = new Map<string, QuotaUsage>();
  private readonly leases = new Map<string, QuotaLease>();

  constructor(options: InMemoryQuotaStoreOptions = {}) {
    this.env = options.env ?? process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
    this.now = options.now ?? Date.now;
  }

  private usage(key: string, now: number) {
    const existing = this.records.get(key);
    if (existing) return existing;
    const created = emptyUsage(now);
    this.records.set(key, created);
    return created;
  }

  private async keys(principalId: string, now: number): Promise<{ keys: QuotaPeriodKeys; windows: ReturnType<typeof quotaPeriodWindows> }> {
    const windows = quotaPeriodWindows(now);
    const principalKey = await principalKeyFromPrincipalId(principalId);
    return {
      keys: {
        minute: quotaKey(this.env, principalKey, "min", windows.minuteKey),
        day: quotaKey(this.env, principalKey, "d", windows.dayKey),
        month: quotaKey(this.env, principalKey, "m", windows.monthKey),
      },
      windows,
    };
  }

  private snapshot(principalId: string, keys: QuotaPeriodKeys): QuotaSnapshot {
    const now = this.now();
    const minuteUsage = this.usage(keys.minute, now);
    const dayUsage = this.usage(keys.day, now);
    const monthUsage = this.usage(keys.month, now);
    return {
      principalId,
      requestsThisMinute: minuteUsage.requests,
      requestsToday: dayUsage.requests,
      promptTokensThisMonth: monthUsage.promptTokens,
      completionTokensThisMonth: monthUsage.completionTokens,
      estimatedTokensThisMonth: monthUsage.estimatedTokens,
      totalTokensThisMonth: totalTokens(monthUsage),
      updatedAt: latestUpdatedAt(minuteUsage, dayUsage, monthUsage),
    };
  }

  async reserve(input: QuotaReservation): Promise<QuotaLease> {
    const now = input.now ?? this.now();
    const { keys, windows } = await this.keys(input.principalId, now);
    const minuteUsage = this.usage(keys.minute, now);
    const dayUsage = this.usage(keys.day, now);
    const monthUsage = this.usage(keys.month, now);
    const snapshot = this.snapshot(input.principalId, keys);

    if (!input.unlimited && input.limits) {
      if (minuteUsage.requests >= input.limits.requestsPerMinute) {
        throw new QuotaExceededError({ period: "minute", retryAt: windows.minuteResetAt, snapshot });
      }
      if (dayUsage.requests >= input.limits.requestsPerDay) {
        throw new QuotaExceededError({ period: "day", retryAt: windows.dayResetAt, snapshot });
      }
      if (totalTokens(monthUsage) + input.estimatedTokens > input.limits.tokensPerMonth) {
        throw new QuotaExceededError({ period: "month", retryAt: windows.monthResetAt, snapshot });
      }
    }

    const lease: QuotaLease = {
      id: crypto.randomUUID(),
      principalId: input.principalId,
      estimatedTokens: input.estimatedTokens,
      createdAt: new Date(now).toISOString(),
      unlimited: input.unlimited,
      mode: input.unlimited ? "unlimited" : input.limits ? "default" : "disabled",
      keys,
    };
    this.leases.set(lease.id, lease);

    const updatedAt = new Date(now).toISOString();
    for (const key of [keys.minute, keys.day, keys.month]) {
      const usage = this.usage(key, now);
      usage.requests += 1;
      usage.estimatedTokens += input.estimatedTokens;
      usage.updatedAt = updatedAt;
    }
    return lease;
  }

  async commit(lease: QuotaLease, usage: QuotaActualUsage): Promise<void> {
    const stored = this.leases.get(lease.id);
    if (!stored?.keys) throw new QuotaStoreError("AI_QUOTA_LEASE_UNKNOWN", "配额租约不存在或已结算");
    const now = this.now();
    const updatedAt = new Date(now).toISOString();

    for (const key of [stored.keys.minute, stored.keys.day, stored.keys.month]) {
      const current = this.usage(key, now);
      current.estimatedTokens = Math.max(0, current.estimatedTokens - stored.estimatedTokens);
      current.promptTokens += usage.promptTokens;
      current.completionTokens += usage.completionTokens;
      current.updatedAt = updatedAt;
    }
    this.leases.delete(lease.id);
  }

  async release(lease: QuotaLease): Promise<void> {
    const stored = this.leases.get(lease.id);
    if (!stored?.keys) throw new QuotaStoreError("AI_QUOTA_LEASE_UNKNOWN", "配额租约不存在或已结算");
    const now = this.now();
    const updatedAt = new Date(now).toISOString();

    for (const key of [stored.keys.minute, stored.keys.day, stored.keys.month]) {
      const current = this.usage(key, now);
      current.requests = Math.max(0, current.requests - 1);
      current.estimatedTokens = Math.max(0, current.estimatedTokens - stored.estimatedTokens);
      current.updatedAt = updatedAt;
    }
    this.leases.delete(lease.id);
  }

  async getSnapshot(principalId: string): Promise<QuotaSnapshot> {
    const now = this.now();
    const { keys } = await this.keys(principalId, now);
    return this.snapshot(principalId, keys);
  }
}
