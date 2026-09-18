import type { QuotaLimits, QuotaMode } from "./policy.ts";
import type { QuotaPeriodWindows } from "./periods.ts";

export type QuotaUsage = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  estimatedTokens: number;
  updatedAt: string;
};

export type QuotaPeriodKeys = {
  minute: string;
  day: string;
  month: string;
};

export type QuotaReservation = {
  principalId: string;
  estimatedTokens: number;
  limits: QuotaLimits | null;
  unlimited: boolean;
  now?: number;
};

export type QuotaLease = {
  id: string;
  principalId: string;
  estimatedTokens: number;
  createdAt: string;
  unlimited: boolean;
  mode: QuotaMode;
  keys?: QuotaPeriodKeys;
  untracked?: true;
};

export type QuotaActualUsage = {
  promptTokens: number;
  completionTokens: number;
  estimated?: boolean;
};

export type QuotaSnapshot = {
  principalId: string;
  requestsThisMinute: number;
  requestsToday: number;
  promptTokensThisMonth: number;
  completionTokensThisMonth: number;
  estimatedTokensThisMonth: number;
  totalTokensThisMonth: number;
  updatedAt: string;
};

export type QuotaPeriodWindowsSnapshot = QuotaPeriodWindows;

export interface QuotaStore {
  reserve(input: QuotaReservation): Promise<QuotaLease>;
  commit(lease: QuotaLease, usage: QuotaActualUsage): Promise<void>;
  release(lease: QuotaLease): Promise<void>;
  getSnapshot(principalId: string): Promise<QuotaSnapshot>;
}

export class QuotaStoreError extends Error {
  readonly code: "AI_QUOTA_STORE_UNAVAILABLE" | "AI_QUOTA_LEASE_UNKNOWN";

  constructor(code: QuotaStoreError["code"], message: string) {
    super(message);
    this.name = "QuotaStoreError";
    this.code = code;
  }
}

export class QuotaExceededError extends Error {
  readonly period: "minute" | "day" | "month";
  readonly retryAt: string;
  readonly snapshot: QuotaSnapshot;

  constructor(input: {
    period: "minute" | "day" | "month";
    retryAt: string;
    snapshot: QuotaSnapshot;
  }) {
    super("AI_QUOTA_EXCEEDED");
    this.name = "QuotaExceededError";
    this.period = input.period;
    this.retryAt = input.retryAt;
    this.snapshot = input.snapshot;
  }
}
