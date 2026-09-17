import { loadAiGatewayConfig, AiGatewayConfigError } from "../../lib/ai/config.ts";
import { MakersGatewayProvider, MakersGatewayError } from "../../lib/ai/providers/makers-gateway-provider.ts";
import { AiAgentError, AiAgentService } from "../../lib/ai/agent/ai-agent-service.ts";
import type { AgentConversationStore } from "../../lib/ai/agent/agent-store.ts";
import { AgentStateIdempotencyStore } from "../../lib/ai/agent/idempotency.ts";
import { AgentTraceCollector } from "../../lib/ai/agent/tracing.ts";
import { verifyAgentBinding, AgentBindingError, type AgentScope } from "../../lib/ai/security/agent-binding.ts";
import { loadAgentScenes, parseApprovedSceneIds } from "../../lib/ai/tools/agent-scene-catalog.ts";
import { activateScene } from "../../lib/ai/tools/activate-scene.ts";

export type MakersAgentContext = {
  request: {
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string;
  };
  env: Record<string, string | undefined>;
  store?: AgentConversationStore & {
    state?: {
      get<T>(key: string): Promise<T | null>;
      set(key: string, value: unknown): Promise<void>;
    };
  };
  conversation_id?: string;
  run_id?: string;
  utils?: {
    abortActiveRun?: (conversationId: string) => Promise<boolean> | boolean;
  };
};

export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId?: string,
) {
  return jsonResponse({ code, message, requestId }, status);
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined;
  const exact = headers[name];
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

async function digestBytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyInternalAuthorization(
  authorization: string | undefined,
  expectedSecret: string | undefined,
) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expectedSecret || expectedSecret.length < 32 || token.length < 32) return false;
  return timingSafeEqual(await digestBytes(token), await digestBytes(expectedSecret));
}

export function conversationIdFromContext(context: MakersAgentContext) {
  return context.conversation_id ?? "";
}

export function isMakersConversationId(value: string) {
  return /^[A-Za-z0-9_.-]{6,36}$/.test(value);
}

export function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiAgentError("AI_INVALID_REQUEST", `${name} 必填`);
  }
  return value.trim();
}

export function parseInternalRequest(body: unknown) {
  if (typeof body !== "object" || body === null) {
    throw new AiAgentError("AI_INVALID_REQUEST", "请求体必须是 JSON 对象");
  }
  const record = body as Record<string, unknown>;
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((item): item is AgentScope => item === "ai:chat" || item === "scene:activate")
    : [];
  if (!scopes.includes("ai:chat")) {
    throw new AiAgentError("AI_INVALID_REQUEST", "scopes 必须包含 ai:chat");
  }
  return {
    requestId: requireString(record.requestId, "requestId"),
    principalId: requireString(record.principalId, "principalId"),
    homeId: requireString(record.homeId, "homeId"),
    message: requireString(record.message, "message"),
    idempotencyKey: requireString(record.idempotencyKey, "idempotencyKey"),
    sessionBinding: requireString(record.sessionBinding, "sessionBinding"),
    locale: typeof record.locale === "string" && record.locale.trim() ? record.locale.trim() : "zh-CN",
    timezone: typeof record.timezone === "string" && record.timezone.trim() ? record.timezone.trim() : "Asia/Shanghai",
    scopes,
  };
}

export function createAgentService(context: MakersAgentContext) {
  if (!context.store?.getMessages || !context.store?.appendMessage || !context.store.state) {
    throw new AiAgentError("AI_AGENT_STORE_UNAVAILABLE", "Agent 会话存储不可用", 503);
  }
  const config = loadAiGatewayConfig(context.env);
  const approvedSceneIds = parseApprovedSceneIds(context.env.AI_SCENE_APPROVED_IDS);
  const trace = new AgentTraceCollector();
  return new AiAgentService({
    provider: new MakersGatewayProvider(config),
    loadScenes: (input) => loadAgentScenes({ ...input, approvedSceneIds }),
    executeScene: activateScene,
    store: context.store,
    idempotency: new AgentStateIdempotencyStore(context.store.state),
    trace,
  });
}

export function agentErrorResponse(error: unknown, requestId?: string) {
  if (error instanceof AiAgentError) {
    return errorResponse(error.code, error.message, error.httpStatus, requestId);
  }
  if (error instanceof AgentBindingError) {
    const status = error.code === "AI_AGENT_BINDING_MISMATCH" ? 403 : 401;
    return errorResponse(error.code, "内部 Agent 可信上下文无效", status, requestId);
  }
  if (error instanceof AiGatewayConfigError) {
    return errorResponse(error.code, "AI Gateway 配置无效", 500, requestId);
  }
  if (error instanceof MakersGatewayError) {
    if (error.code === "AI_GATEWAY_RATE_LIMITED") {
      return jsonResponse({
        code: error.code,
        message: "AI Gateway 限流，请稍后重试",
        requestId,
        retryAfterSeconds: error.retryAfterSeconds,
      }, 429);
    }
    if (error.code === "AI_GATEWAY_TIMEOUT") {
      return errorResponse(error.code, "AI Gateway 响应超时", 504, requestId);
    }
    if (error.code === "AI_GATEWAY_CANCELLED") {
      return errorResponse("AI_AGENT_CANCELLED", "请求已取消", 499, requestId);
    }
    return errorResponse(error.code, "AI Gateway 暂时不可用", 502, requestId);
  }
  return errorResponse("AI_AGENT_UNAVAILABLE", "AI 助手暂时不可用", 502, requestId);
}

export { headerValue, verifyAgentBinding, AgentBindingError };
