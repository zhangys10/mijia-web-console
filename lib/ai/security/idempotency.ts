import { createHash } from "node:crypto";

export type IdempotencyRecord = {
  key: string;
  requestHash: string;
  status: "processing" | "completed" | "failed";
  response?: unknown;
  httpStatus?: number;
  expiresAt: number;
};

/** Idempotency-Key 只用于保护有副作用的场景执行；长度约束用于拒绝畸形输入。 */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= IDEMPOTENCY_KEY_MIN_LENGTH
    && value.length <= IDEMPOTENCY_KEY_MAX_LENGTH;
}

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs = 600_000) {
    this.ttlMs = ttlMs;
  }

  lookup(key: string, requestHash: string): "processing" | "completed" | "failed" | "miss" | "conflict" {
    const record = this.records.get(key);
    if (!record) return "miss";
    if (record.expiresAt < Date.now()) {
      this.records.delete(key);
      return "miss";
    }
    if (record.requestHash !== requestHash) return "conflict";
    return record.status;
  }

  start(key: string, requestHash: string) {
    this.records.set(key, { key, requestHash, status: "processing", expiresAt: Date.now() + this.ttlMs });
  }

  complete(key: string, response: unknown) {
    const record = this.records.get(key);
    if (record) {
      record.status = "completed";
      record.response = response;
      record.httpStatus = 200;
    }
  }

  fail(key: string, response: unknown, httpStatus: number) {
    const record = this.records.get(key);
    if (record) {
      record.status = "failed";
      record.response = response;
      record.httpStatus = httpStatus;
    }
  }

  get(key: string): IdempotencyRecord | undefined {
    const record = this.records.get(key);
    if (record && record.expiresAt < Date.now()) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }
}

export function requestHash(body: Record<string, unknown>): string {
  const stable = JSON.stringify(body, Object.keys(body).sort());
  return createHash("sha256").update(stable).digest("hex");
}
