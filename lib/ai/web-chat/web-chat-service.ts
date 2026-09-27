import { listHomes, type XiaomiHome, type XiaomiSession } from "../../xiaomi-cloud.ts";
import type { AgentRunResult } from "./agent-client.ts";
import { isPreviewEnvironment } from "../config.ts";
import { isQuotaEnabled } from "../quota/policy.ts";
import { disabledQuotaSummary, type QuotaSummary } from "../quota/quota-service.ts";
import type { AgentScope } from "../security/agent-binding.ts";
import { AUTOMATION_TOKEN_REALM, sealAutomationToken } from "../security/automation-token.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { loadAgentScenes, type AgentSceneRecord } from "../tools/agent-scene-catalog.ts";
import { isSceneExposed, readAssistantExposure } from "../tools/assistant-exposure.ts";
import { matchSceneActionIntent } from "../tools/scene-action-intent.ts";
import type { WebAgentClient } from "./agent-client.ts";
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
  homeStatus?: AgentRunResult["homeStatus"];
  deviceStatus?: AgentRunResult["deviceStatus"];
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
  agent?: WebAgentClient;
  loadHomes?: (session: XiaomiSession) => Promise<XiaomiHome[]>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  randomUuid?: () => string;
  loadScenes?: typeof loadAgentScenes;
  readExposure?: typeof readAssistantExposure;
};

const allowedFields = new Set(["conversationId", "homeId", "message", "idempotencyKey"]);

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

function publicQuota(summary: QuotaSummary): PublicQuotaSummary {
  return {
    mode: summary.mode,
    remainingRequestsToday: summary.remaining.requestsToday,
    remainingTokensThisMonth: summary.remaining.tokensThisMonth,
    resetAt: summary.resetAt,
    softLimit: true,
  };
}

function previewQuota(): PublicQuotaSummary {
  return {
    mode: "disabled",
    remainingRequestsToday: null,
    remainingTokensThisMonth: null,
    resetAt: null,
    softLimit: true,
  };
}

export class AiWebService {
  private readonly env: WebChatEnvironment;
  private readonly agent: WebAgentClient | undefined;
  private readonly loadHomes: (session: XiaomiSession) => Promise<XiaomiHome[]>;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly randomUuid: () => string;
  private readonly loadScenes: typeof loadAgentScenes;
  private readonly readExposure: typeof readAssistantExposure;

  constructor(options: AiWebServiceOptions) {
    this.env = options.env;
    this.agent = options.agent;
    this.loadHomes = options.loadHomes ?? listHomes;
    this.now = options.now ?? Date.now;
    this.randomBytes = options.randomBytes
      ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
    this.randomUuid = options.randomUuid ?? (() => crypto.randomUUID());
    this.loadScenes = options.loadScenes ?? loadAgentScenes;
    this.readExposure = options.readExposure ?? readAssistantExposure;
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

  private async issueAutomationToken(
    principalId: string,
    homeId: string,
    session: XiaomiSession,
    now: number,
    actionGrant?: NonNullable<import("../security/automation-token.ts").AutomationTokenPayload["actionGrant"]>,
  ) {
    try {
      return await sealAutomationToken({
        version: 1,
        purpose: "ai-home-automation",
        audience: "mijia-agent",
        principalId,
        xiaomiSession: session,
        region: session.region || "cn",
        homeId,
        actionGrant,
        issuedAt: now,
        expiresAt: now + 5 * 60_000,
      }, {
        secret: this.env.AI_AUTOMATION_TOKEN_SECRET,
        keyId: this.env.AI_AUTOMATION_TOKEN_KEY_ID,
        env: AUTOMATION_TOKEN_REALM,
      });
    } catch {
      throw new WebChatError("AI_AGENT_UNAVAILABLE", "AI 助手鉴权暂时不可用", 502);
    }
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
    if (isPreviewEnvironment(this.env)) {
      return { requestId: id, conversationId, deleted: true };
    }
    const scopes: AgentScope[] = ["ai:chat"];
    const now = this.now();
    const automationToken = await this.issueAutomationToken(principalId, homeId, session, now);
    const result = await this.requireAgent().deleteConversation({
      conversationId,
      requestId: id,
      principalId,
      homeId,
      scopes,
      automationToken,
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

    if (isPreviewEnvironment(this.env)) {
      return {
        requestId: requestId(this.randomUuid),
        conversationId,
        message: "预览模式：不会调用模型或控制真实设备。",
        intent: "none",
        quota: previewQuota(),
      };
    }

    const id = requestId(this.randomUuid);
    // The server grants scene scope only for a current, approved exact-name request.
    // A caller-provided idempotency key never grants write access by itself.
    const scopes: AgentScope[] = ["ai:chat"];
    const now = this.now();
    const idempotencyKey = input.idempotencyKey ?? `readonly_${id}`;
    let actionGrant: NonNullable<import("../security/automation-token.ts").AutomationTokenPayload["actionGrant"]> | undefined;
    if (this.env.AI_SCENE_EXECUTION_ENABLED === "true"
      && (this.env.AI_SCENE_ACTION_AUTHORIZATION_SECRET?.length ?? 0) >= 32
      && /^(?:执行|运行|启动|run\s|activate\s|execute\s)/iu.test(input.message)) {
      const scenes: AgentSceneRecord[] = await this.loadScenes({ principalId, homeId: input.homeId, session });
      const selected = matchSceneActionIntent(input.message, scenes);
      if (selected) {
        const exposure = await this.readExposure(input.homeId, undefined, this.env);
        if (isSceneExposed(exposure, selected)) {
          const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.message));
          const messageHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
          actionGrant = { requestId: id, idempotencyKey, sceneAlias: selected.alias,
            revision: selected.revision, messageHash, expiresAt: now + 60_000 };
          scopes.push("scene:activate");
        }
      }
    }
    const automationToken = await this.issueAutomationToken(principalId, input.homeId, session, now, actionGrant);
    const remoteQuotaDisabled = !isQuotaEnabled(this.env);
    const agentResult = await this.requireAgent().run({
      conversationId,
      requestId: id,
      principalId,
      homeId: input.homeId,
      message: input.message,
      idempotencyKey,
      scopes,
      automationToken,
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      signal,
    });

    const quotaSummary = remoteQuotaDisabled
      ? disabledQuotaSummary(principalId)
      : agentResult.quota;
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
      homeStatus: agentResult.homeStatus,
      deviceStatus: agentResult.deviceStatus,
      quota: publicQuota(quotaSummary),
    };
  }
}
