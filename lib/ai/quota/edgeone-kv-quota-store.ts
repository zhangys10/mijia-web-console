import { principalKeyFromPrincipalId, quotaKey, quotaPeriodWindows } from "./periods.ts";
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

export type EdgeOneKvBinding = {
  get(key: string): Promise<string | null | undefined>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

type EdgeOneKvQuotaStoreOptions = {
  env: string;
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

function parseUsage(raw: string | null | undefined, now: number): QuotaUsage {
  if (raw === null || raw === undefined || raw === "") return emptyUsage(now);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额记录不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额记录格式无效");
  }
  const record = parsed as Record<string, unknown>;
  const numbers = ["requests", "promptTokens", "completionTokens", "estimatedTokens"] as const;
  const usage = emptyUsage(now);
  for (const field of numbers) {
    const value = record[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额记录计数无效");
    }
    usage[field] = value as number;
  }
  if (typeof record.updatedAt === "string") usage.updatedAt = record.updatedAt;
  return usage;
}

/**
 * EdgeOne KV 只有 get/put/delete，没有原子自增或 CAS，且跨节点最长约 60 秒传播。
 * 该实现按设计作为软限额使用：并发或传播窗口内允许少量超额，不做硬限额承诺。
 */
export class EdgeOneKvQuotaStore implements QuotaStore {
  private readonly binding: EdgeOneKvBinding;
  private readonly env: string;
  private readonly now: () => number;

  constructor(binding: EdgeOneKvBinding, options: EdgeOneKvQuotaStoreOptions) {
    this.binding = binding;
    this.env = options.env;
    this.now = options.now ?? Date.now;
  }

  private async readUsage(key: string, now: number) {
    try {
      return parseUsage(await this.binding.get(key), now);
    } catch (error) {
      if (error instanceof QuotaStoreError) throw error;
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "读取配额存储失败");
    }
  }

  private async writeUsage(key: string, usage: QuotaUsage) {
    try {
      await this.binding.put(key, JSON.stringify(usage));
    } catch {
      throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "写入配额存储失败");
    }
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

  private async snapshot(principalId: string, keys: QuotaPeriodKeys): Promise<QuotaSnapshot> {
    const now = this.now();
    const minuteUsage = await this.readUsage(keys.minute, now);
    const dayUsage = await this.readUsage(keys.day, now);
    const monthUsage = await this.readUsage(keys.month, now);
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
    const minuteUsage = await this.readUsage(keys.minute, now);
    const dayUsage = await this.readUsage(keys.day, now);
    const monthUsage = await this.readUsage(keys.month, now);

    if (!input.unlimited && input.limits) {
      if (minuteUsage.requests >= input.limits.requestsPerMinute) {
        throw new QuotaExceededError({
          period: "minute",
          retryAt: windows.minuteResetAt,
          snapshot: await this.snapshot(input.principalId, keys),
        });
      }
      if (dayUsage.requests >= input.limits.requestsPerDay) {
        throw new QuotaExceededError({
          period: "day",
          retryAt: windows.dayResetAt,
          snapshot: await this.snapshot(input.principalId, keys),
        });
      }
      if (totalTokens(monthUsage) + input.estimatedTokens > input.limits.tokensPerMonth) {
        throw new QuotaExceededError({
          period: "month",
          retryAt: windows.monthResetAt,
          snapshot: await this.snapshot(input.principalId, keys),
        });
      }
    }

    const updatedAt = new Date(now).toISOString();
    const reservations: Array<[string, QuotaUsage]> = [
      [keys.minute, minuteUsage],
      [keys.day, dayUsage],
      [keys.month, monthUsage],
    ];
    for (const [key, usage] of reservations) {
      usage.requests += 1;
      usage.estimatedTokens += input.estimatedTokens;
      usage.updatedAt = updatedAt;
      await this.writeUsage(key, usage);
    }

    return {
      id: crypto.randomUUID(),
      principalId: input.principalId,
      estimatedTokens: input.estimatedTokens,
      createdAt: updatedAt,
      unlimited: input.unlimited,
      mode: input.unlimited ? "unlimited" : input.limits ? "default" : "disabled",
      keys,
    };
  }

  async commit(lease: QuotaLease, usage: QuotaActualUsage): Promise<void> {
    if (!lease.keys) throw new QuotaStoreError("AI_QUOTA_LEASE_UNKNOWN", "配额租约缺少周期 key");
    const now = this.now();
    const updatedAt = new Date(now).toISOString();

    for (const key of [lease.keys.minute, lease.keys.day, lease.keys.month]) {
      const current = await this.readUsage(key, now);
      current.estimatedTokens = Math.max(0, current.estimatedTokens - lease.estimatedTokens);
      if (usage.estimated) {
        current.estimatedTokens += usage.promptTokens + usage.completionTokens;
      } else {
        current.promptTokens += usage.promptTokens;
        current.completionTokens += usage.completionTokens;
      }
      current.updatedAt = updatedAt;
      await this.writeUsage(key, current);
    }
  }

  async release(lease: QuotaLease): Promise<void> {
    if (!lease.keys) throw new QuotaStoreError("AI_QUOTA_LEASE_UNKNOWN", "配额租约缺少周期 key");
    const now = this.now();
    const updatedAt = new Date(now).toISOString();

    for (const key of [lease.keys.minute, lease.keys.day, lease.keys.month]) {
      const current = await this.readUsage(key, now);
      current.requests = Math.max(0, current.requests - 1);
      current.estimatedTokens = Math.max(0, current.estimatedTokens - lease.estimatedTokens);
      current.updatedAt = updatedAt;
      await this.writeUsage(key, current);
    }
  }

  async getSnapshot(principalId: string): Promise<QuotaSnapshot> {
    const now = this.now();
    const { keys } = await this.keys(principalId, now);
    return this.snapshot(principalId, keys);
  }
}
