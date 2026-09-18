import { listHomes, type XiaomiHome, type XiaomiSession } from "../../xiaomi-cloud.ts";
import type { AgentRunResult } from "../agent/ai-agent-service.ts";
import type { QuotaService, QuotaSummary } from "../quota/quota-service.ts";
import type { QuotaActualUsage } from "../quota/quota-store.ts";
import { createAgentBinding, type AgentScope } from "../security/agent-binding.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { AgentClientError, type WebAgentClient } from "./agent-client.ts";
import {
  createConversationHandle,
  resolveConversationHomeId,
  verifyConversationHandle,
} from "./conversation-handle.ts";

export type WebChatEnvironment = Record<string, string | undefined>;

export type WebChatInput = {
  conversationId?: string;
  homeId: string;
  message: string;
  idempotencyKey?: string;
};

export type PublicQuotaSummary = {
  mode: QuotaSummary["mode"];
  remainingRequestsToday: number | null;
  remainingTokensThisMonth: number | null;
  resetAt: string | null;
  softLimit: true;
};

export type WebChatResult = {
  requestId: string;
  conversationId: string;
  message: string;
  intent: AgentRunResult["intent"];
  tool?: AgentRunResult["tool"];
  scenes?: Array<{ name: string; description: string; actionCount: number }>;
  quota: PublicQuotaSummary;
};

export class WebChatError extends Error {
  readonly code: "AI_INVALID_REQUEST" | "AI_HOME_FORBIDDEN" | "AI_AGENT_UNAVAILABLE";
  readonly httpStatus: number;

  constructor(code: WebChatError["code"], message: string, httpStatus: number) {
    super(message);
    this.name = "WebChatError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

type AiWebServiceOptions = {
  env: WebChatEnvironment;
  quota?: QuotaService;
  agent?: WebAgentClient;
  loadHomes?: (session: XiaomiSession) => Promise<XiaomiHome[]>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  randomUuid?: () => string;
};

const allowedFields = new Set(["conversationId", "homeId", "message", "idempotencyKey"]);
const encoder = new TextEncoder();

function requireField(value: unknown, name: string, maximum: number) {
  if (typeof value !== "string") {
    throw new WebChatError("AI_INVALID_REQUEST", `${name} 必填`, 400);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new WebChatError("AI_INVALID_REQUEST", `${name} 格式无效`, 400);
  }
  return normalized;
}

export function parseWebChatInput(value: unknown): WebChatInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebChatError("AI_INVALID_REQUEST", "请求体必须是 JSON 对象", 400);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedFields.has(key))) {
    throw new WebChatError("AI_INVALID_REQUEST", "请求包含不允许的字段", 400);
  }
  const message = requireField(record.message, "message", 500);
  const homeId = requireField(record.homeId, "homeId", 100);
  const conversationId = record.conversationId === undefined
    ? undefined
    : requireField(record.conversationId, "conversationId", 36);
  const idempotencyKey = record.idempotencyKey === undefined
    ? undefined
    : requireField(record.idempotencyKey, "idempotencyKey", 128);
  if (idempotencyKey && idempotencyKey.length < 16) {
    throw new WebChatError("AI_INVALID_REQUEST", "idempotencyKey 长度必须在 16 到 128 之间", 400);
  }
  return { conversationId, homeId, message, idempotencyKey };
}

function requestId(randomUuid: () => string) {
  return `req_${randomUuid().replace(/-/g, "")}`;
}

function estimatedReservationTokens(message: string) {
  const bytes = encoder.encode(message).byteLength;
  return Math.min(16_384, Math.max(1024, 1024 + bytes * 2));
}

function usageForQuota(result: AgentRunResult, fallback: number): QuotaActualUsage {
  const usage = result.usage;
  if (
    usage
    && Number.isSafeInteger(usage.promptTokens)
    && Number.isSafeInteger(usage.completionTokens)
    && usage.promptTokens >= 0
    && usage.completionTokens >= 0
  ) {
    return {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimated: usage.estimated === true,
    };
  }
  return { promptTokens: fallback, completionTokens: 0, estimated: true };
}

function usageForError(error: unknown, fallback: number): QuotaActualUsage | null {
  if (!(error instanceof AgentClientError)) return null;
  if (error.usage) {
    return {
      promptTokens: error.usage.promptTokens,
      completionTokens: error.usage.completionTokens,
      estimated: error.usage.estimated === true,
    };
  }
  return error.usageUnknown
    ? { promptTokens: fallback, completionTokens: 0, estimated: true }
    : null;
}

function publicQuota(summary: QuotaSummary): PublicQuotaSummary {
  return {
    mode: summary.mode,
    remainingRequestsToday: summary.remaining.requestsToday,
    remainingTokensThisMonth: summary.remaining.tokensThisMonth,
    resetAt: summary.resetAt,
    softLimit: true,
  };
}

export class AiWebService {
  private readonly env: WebChatEnvironment;
  private readonly quota: QuotaService | undefined;
  private readonly agent: WebAgentClient | undefined;
  private readonly loadHomes: (session: XiaomiSession) => Promise<XiaomiHome[]>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly randomUuid: () => string;

  constructor(options: AiWebServiceOptions) {
    this.env = options.env;
    this.quota = options.quota;
    this.agent = options.agent;
    this.loadHomes = options.loadHomes ?? listHomes;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes
      ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
    this.randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
  }

  private async identity(session: XiaomiSession) {
    const principalId = await derivePrincipalId(session, this.env);
    let homes: XiaomiHome[];
    try {
      homes = await this.loadHomes(session);
    } catch {
      throw new WebChatError("AI_AGENT_UNAVAILABLE", "暂时无法验证米家家庭", 502);
    }
    return { principalId, homes };
  }

  private authorizedHome(homes: readonly XiaomiHome[], homeId: string) {
    const home = homes.find((candidate) => candidate.id === homeId);
    if (!home) throw new WebChatError("AI_HOME_FORBIDDEN", "当前账号无权访问该家庭", 403);
    return home;
  }

  private requireAgent() {
    if (!this.agent) throw new WebChatError("AI_AGENT_UNAVAILABLE", "AI 助手尚未配置", 502);
    return this.agent;
  }

  private requireQuota() {
    if (!this.quota) throw new WebChatError("AI_AGENT_UNAVAILABLE", "AI 配额服务尚未配置", 502);
    return this.quota;
  }

  async createConversation(session: XiaomiSession, rawHomeId: unknown) {
    const homeId = requireField(rawHomeId, "homeId", 100);
    const { principalId, homes } = await this.identity(session);
    this.authorizedHome(homes, homeId);
    return createConversationHandle(principalId, homeId, this.env, this.randomBytes);
  }

  async deleteConversation(session: XiaomiSession, conversationId: string, signal?: AbortSignal) {
    const { principalId, homes } = await this.identity(session);
    const homeId = await resolveConversationHomeId(
      conversationId,
      principalId,
      homes.map((home) => home.id),
      this.env,
    );
    if (!homeId) throw new WebChatError("AI_INVALID_REQUEST", "conversationId 无效", 400);
    const id = requestId(this.randomUuid);
    const scopes: AgentScope[] = ["ai:chat"];
    const now = this.now();
    const sessionBinding = await createAgentBinding({
      principalId,
      homeId,
      scopes,
      session,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
    }, this.env.XIAOMI_SESSION_SECRET);
    const result = await this.requireAgent().deleteConversation({
      conversationId,
      requestId: id,
      principalId,
      homeId,
      scopes,
      sessionBinding,
      signal,
    });
    return { requestId: id, conversationId, deleted: result.deleted };
  }

  async chat(session: XiaomiSession, rawInput: unknown, signal?: AbortSignal): Promise<WebChatResult> {
    const input = parseWebChatInput(rawInput);
    const { principalId, homes } = await this.identity(session);
    this.authorizedHome(homes, input.homeId);
    const conversationId = input.conversationId
      ?? await createConversationHandle(principalId, input.homeId, this.env, this.randomBytes);
    if (
      input.conversationId
      && !(await verifyConversationHandle(input.conversationId, principalId, input.homeId, this.env))
    ) {
      throw new WebChatError("AI_INVALID_REQUEST", "conversationId 无效", 400);
    }

    const id = requestId(this.randomUuid);
    const scopes: AgentScope[] = input.idempotencyKey
      ? ["ai:chat", "scene:activate"]
      : ["ai:chat"];
    const now = this.now();
    const sessionBinding = await createAgentBinding({
      principalId,
      homeId: input.homeId,
      scopes,
      session,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
    }, this.env.XIAOMI_SESSION_SECRET);
    const quota = this.env.AI_AGENT_BASE_URL ? undefined : this.requireQuota();
    const estimatedTokens = estimatedReservationTokens(input.message);
    const lease = await quota?.reserve(principalId, estimatedTokens);

    let agentResult: AgentRunResult & { quota?: QuotaSummary };
    try {
      agentResult = await this.requireAgent().run({
        conversationId,
        requestId: id,
        principalId,
        homeId: input.homeId,
        message: input.message,
        idempotencyKey: input.idempotencyKey ?? `readonly_${id}`,
        scopes,
        sessionBinding,
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        signal,
      });
    } catch (error) {
      if (quota && lease) {
        const failureUsage = usageForError(error, estimatedTokens);
        if (failureUsage) await quota.commit(lease, failureUsage);
        else await quota.release(lease);
      }
      throw error;
    }

    if (quota && lease) await quota.commit(lease, usageForQuota(agentResult, estimatedTokens));
    const quotaSummary = quota ? await quota.getSummary(principalId) : agentResult.quota;
    if (!quotaSummary) {
      throw new WebChatError("AI_AGENT_UNAVAILABLE", "Agent 未返回配额摘要", 502);
    }
    return {
      requestId: agentResult.requestId,
      conversationId,
      message: agentResult.message,
      intent: agentResult.intent,
      tool: agentResult.tool,
      scenes: agentResult.scenes?.map(({ name, description, actionCount }) => ({
        name,
        description,
        actionCount,
      })),
      quota: publicQuota(quotaSummary),
    };
  }
}
