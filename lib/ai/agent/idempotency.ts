export type AgentIdempotencyRecord = {
  status: "processing" | "completed" | "failed";
  requestHash: string;
  response?: unknown;
  expiresAt: number;
};

export interface AgentIdempotencyStoreLike {
  requestHash(input: Record<string, unknown>): Promise<string>;
  lookup(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<"miss" | "processing" | "completed" | "failed" | "conflict">;
  start(principalId: string, homeId: string, idempotencyKey: string, hash: string): Promise<void>;
  complete(principalId: string, homeId: string, idempotencyKey: string, response: unknown): Promise<void>;
  fail(principalId: string, homeId: string, idempotencyKey: string, response: unknown): Promise<void>;
  get(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
  ): Promise<AgentIdempotencyRecord | null | undefined>;
}

export class AgentIdempotencyStore {
  private readonly records = new Map<string, AgentIdempotencyRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 600_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private key(principalId: string, homeId: string, idempotencyKey: string) {
    return `${principalId}:${homeId}:${idempotencyKey}`;
  }

  async requestHash(input: Record<string, unknown>) {
    const stable = JSON.stringify(input, Object.keys(input).sort());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async lookup(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<"miss" | "processing" | "completed" | "failed" | "conflict"> {
    const key = this.key(principalId, homeId, idempotencyKey);
    const record = this.records.get(key);
    if (!record || record.expiresAt < this.now()) {
      if (record) this.records.delete(key);
      return "miss";
    }
    if (record.requestHash !== hash) return "conflict";
    return record.status;
  }

  async start(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    hash: string,
  ) {
    this.records.set(this.key(principalId, homeId, idempotencyKey), {
      status: "processing",
      requestHash: hash,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  async complete(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    response: unknown,
  ) {
    const record = this.records.get(this.key(principalId, homeId, idempotencyKey));
    if (record) {
      record.status = "completed";
      record.response = response;
    }
  }

  async fail(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    response: unknown,
  ) {
    const record = this.records.get(this.key(principalId, homeId, idempotencyKey));
    if (record) {
      record.status = "failed";
      record.response = response;
    }
  }

  async get(principalId: string, homeId: string, idempotencyKey: string) {
    const record = this.records.get(this.key(principalId, homeId, idempotencyKey));
    if (record && record.expiresAt >= this.now()) return record;
    return undefined;
  }
}

type ConversationStateStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
};

export class AgentStateIdempotencyStore {
  private readonly state: ConversationStateStore;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(state: ConversationStateStore, ttlMs = 600_000, now: () => number = Date.now) {
    this.state = state;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  private key(principalId: string, homeId: string, idempotencyKey: string) {
    return `idempotency:${principalId}:${homeId}:${idempotencyKey}`;
  }

  private async record(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
  ): Promise<AgentIdempotencyRecord | null> {
    const record = await this.state.get<AgentIdempotencyRecord>(
      this.key(principalId, homeId, idempotencyKey),
    );
    if (
      !record
      || typeof record !== "object"
      || !["processing", "completed", "failed"].includes(record.status)
      || typeof record.requestHash !== "string"
      || !Number.isSafeInteger(record.expiresAt)
      || record.expiresAt < this.now()
    ) return null;
    return record;
  }

  async requestHash(input: Record<string, unknown>) {
    const stable = JSON.stringify(input, Object.keys(input).sort());
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async lookup(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<"miss" | "processing" | "completed" | "failed" | "conflict"> {
    const record = await this.record(principalId, homeId, idempotencyKey);
    if (!record) return "miss";
    if (record.requestHash !== hash) return "conflict";
    return record.status;
  }

  async start(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    hash: string,
  ) {
    await this.state.set(this.key(principalId, homeId, idempotencyKey), {
      status: "processing",
      requestHash: hash,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  async complete(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    response: unknown,
  ) {
    const record = await this.record(principalId, homeId, idempotencyKey);
    if (!record) return;
    await this.state.set(this.key(principalId, homeId, idempotencyKey), {
      ...record,
      status: "completed",
      response,
    });
  }

  async fail(
    principalId: string,
    homeId: string,
    idempotencyKey: string,
    response: unknown,
  ) {
    const record = await this.record(principalId, homeId, idempotencyKey);
    if (!record) return;
    await this.state.set(this.key(principalId, homeId, idempotencyKey), {
      ...record,
      status: "failed",
      response,
    });
  }

  async get(principalId: string, homeId: string, idempotencyKey: string) {
    return this.record(principalId, homeId, idempotencyKey);
  }
}
