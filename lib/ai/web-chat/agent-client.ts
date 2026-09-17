import type { AgentRunResult } from "../agent/ai-agent-service.ts";
import type { AgentScope } from "../security/agent-binding.ts";

export type AgentClientRunInput = {
  conversationId: string;
  requestId: string;
  principalId: string;
  homeId: string;
  message: string;
  idempotencyKey: string;
  scopes: AgentScope[];
  sessionBinding: string;
  locale: string;
  timezone: string;
  signal?: AbortSignal;
};

export type AgentClientDeleteInput = {
  conversationId: string;
  requestId: string;
  principalId: string;
  homeId: string;
  scopes: AgentScope[];
  sessionBinding: string;
  signal?: AbortSignal;
};

export interface WebAgentClient {
  run(input: AgentClientRunInput): Promise<AgentRunResult>;
  deleteConversation(input: AgentClientDeleteInput): Promise<{ deleted: boolean }>;
}

export class AgentClientError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    message: string,
    httpStatus: number,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "AgentClientError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

type MakersAgentClientOptions = {
  baseUrl: string;
  internalSecret: string | undefined;
  fetchImpl?: typeof fetch;
};

const knownIntent = new Set(["none", "list_scenes", "activate_scene"]);
const knownTool = new Set(["list_scenes", "activate_scene"]);
const knownToolStatus = new Set(["success", "partial_success"]);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function responseBody(response: Response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 64 * 1024) return null;
  try {
    return objectRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function mappedAgentError(body: Record<string, unknown> | null) {
  const code = typeof body?.code === "string" ? body.code : "";
  const retryAfterSeconds = Number.isSafeInteger(body?.retryAfterSeconds)
    ? body?.retryAfterSeconds as number
    : undefined;
  switch (code) {
    case "AI_INVALID_REQUEST":
      return new AgentClientError(code, "AI 请求格式无效", 400);
    case "AI_SCOPE_FORBIDDEN":
      return new AgentClientError(code, "当前请求不允许执行设备动作", 403);
    case "AI_PREVIEW_READ_ONLY":
      return new AgentClientError(code, "当前预览环境只允许只读对话", 403);
    case "AI_IDEMPOTENCY_CONFLICT":
      return new AgentClientError(code, "相同幂等键对应不同请求", 409);
    case "AI_REQUEST_IN_PROGRESS":
      return new AgentClientError(code, "相同请求仍在处理中", 409);
    case "AI_GATEWAY_RATE_LIMITED":
      return new AgentClientError(code, "AI Gateway 限流，请稍后重试", 429, { retryAfterSeconds });
    case "AI_GATEWAY_TIMEOUT":
      return new AgentClientError(code, "AI Gateway 响应超时", 504);
    case "AI_SCENE_FAILED":
      return new AgentClientError(code, "米家场景执行失败", 502);
    case "AI_SCENE_TIMEOUT":
      return new AgentClientError(code, "米家场景执行超时", 504);
    case "AI_AGENT_CANCELLED":
      return new AgentClientError(code, "请求已取消", 499);
    default:
      return new AgentClientError(
        code.startsWith("AI_GATEWAY_") ? "AI_GATEWAY_UNAVAILABLE" : "AI_AGENT_UNAVAILABLE",
        code.startsWith("AI_GATEWAY_") ? "AI Gateway 暂时不可用" : "AI 助手暂时不可用",
        502,
      );
  }
}

function normalizeUsage(value: unknown) {
  const usage = objectRecord(value);
  if (!usage) return undefined;
  const promptTokens = usage.promptTokens;
  const completionTokens = usage.completionTokens;
  const totalTokens = usage.totalTokens;
  if (
    !Number.isSafeInteger(promptTokens)
    || !Number.isSafeInteger(completionTokens)
    || !Number.isSafeInteger(totalTokens)
    || (promptTokens as number) < 0
    || (completionTokens as number) < 0
    || (totalTokens as number) < 0
  ) {
    return undefined;
  }
  return {
    promptTokens: promptTokens as number,
    completionTokens: completionTokens as number,
    totalTokens: totalTokens as number,
    estimated: usage.estimated === true,
  };
}

function normalizeAgentResult(
  body: Record<string, unknown> | null,
  expected: Pick<AgentClientRunInput, "requestId" | "conversationId">,
): AgentRunResult {
  if (
    !body
    || body.requestId !== expected.requestId
    || body.conversationId !== expected.conversationId
    || typeof body.message !== "string"
    || typeof body.intent !== "string"
    || !knownIntent.has(body.intent)
  ) {
    throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手返回无效响应", 502);
  }

  const result: AgentRunResult = {
    requestId: body.requestId,
    conversationId: body.conversationId,
    message: body.message.slice(0, 2000),
    intent: body.intent as AgentRunResult["intent"],
    usage: normalizeUsage(body.usage),
  };
  if (Array.isArray(body.scenes)) {
    result.scenes = body.scenes.flatMap((item) => {
      const scene = objectRecord(item);
      return scene
        && typeof scene.alias === "string"
        && typeof scene.name === "string"
        && typeof scene.description === "string"
        && Number.isSafeInteger(scene.actionCount)
        && (scene.actionCount as number) >= 0
        ? [{
          alias: scene.alias,
          name: scene.name,
          description: scene.description,
          actionCount: scene.actionCount as number,
        }]
        : [];
    });
  }
  const tool = objectRecord(body.tool);
  if (
    tool
    && typeof tool.name === "string"
    && knownTool.has(tool.name)
    && typeof tool.status === "string"
    && knownToolStatus.has(tool.status)
  ) {
    result.tool = {
      name: tool.name as NonNullable<AgentRunResult["tool"]>["name"],
      status: tool.status as NonNullable<AgentRunResult["tool"]>["status"],
      sceneName: typeof tool.sceneName === "string" ? tool.sceneName : undefined,
    };
  }
  return result;
}

export class MakersAgentClient implements WebAgentClient {
  private readonly baseUrl: string;
  private readonly internalSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MakersAgentClientOptions) {
    const endpoint = new URL(options.baseUrl);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "Agent URL 配置无效", 502);
    }
    this.baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
    this.internalSecret = options.internalSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, conversationId: string, body: unknown, signal?: AbortSignal) {
    if (!this.internalSecret || this.internalSecret.length < 32) {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手内部鉴权尚未配置", 502);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "Makers-Conversation-Id": conversationId,
          Authorization: `Bearer ${this.internalSecret}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手暂时不可用", 502);
    }
    const parsed = await responseBody(response);
    if (!response.ok) throw mappedAgentError(parsed);
    return parsed;
  }

  async run(input: AgentClientRunInput) {
    const body = await this.post("ai-home", input.conversationId, {
      requestId: input.requestId,
      principalId: input.principalId,
      homeId: input.homeId,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      scopes: input.scopes,
      sessionBinding: input.sessionBinding,
      locale: input.locale,
      timezone: input.timezone,
    }, input.signal);
    return normalizeAgentResult(body, input);
  }

  async deleteConversation(input: AgentClientDeleteInput) {
    const body = await this.post("ai-home/delete", input.conversationId, {
      requestId: input.requestId,
      principalId: input.principalId,
      homeId: input.homeId,
      scopes: input.scopes,
      sessionBinding: input.sessionBinding,
    }, input.signal);
    if (!body || body.ok !== true || typeof body.deleted !== "boolean") {
      throw new AgentClientError("AI_AGENT_UNAVAILABLE", "AI 助手返回无效响应", 502);
    }
    return { deleted: body.deleted };
  }
}
