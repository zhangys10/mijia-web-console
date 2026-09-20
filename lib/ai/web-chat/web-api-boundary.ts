import { readXiaomiSessionWithSecret, type XiaomiSession } from "../../xiaomi-cloud.ts";
import { QuotaPolicyError } from "../quota/policy.ts";
import { QuotaExceededError, QuotaStoreError } from "../quota/quota-store.ts";
import { AgentBindingError } from "../security/agent-binding.ts";
import { PrincipalError } from "../security/principal.ts";
import { AgentClientError } from "./agent-client.ts";
import { ConversationHandleError } from "./conversation-handle.ts";
import { WebChatError } from "./web-chat-service.ts";

export type AiWebContext = {
  request: Request;
  env: Record<string, string | undefined>;
};

export const NO_STORE_JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

export class WebApiAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebApiAuthenticationError";
  }
}

export function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_JSON_HEADERS });
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("Cookie") ?? "";
  for (const part of cookies.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator) !== name) continue;
    const value = part.slice(separator + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

export async function authenticateXiaomiSession(
  request: Request,
  env: Record<string, string | undefined>,
  reader: typeof readXiaomiSessionWithSecret = readXiaomiSessionWithSecret,
): Promise<XiaomiSession> {
  const cookie = readCookie(request, "xiaomi_session");
  if (!cookie) throw new WebApiAuthenticationError("请先登录米家账号");
  try {
    return await reader(cookie, env.XIAOMI_SESSION_SECRET);
  } catch {
    throw new WebApiAuthenticationError("小米会话无效或已过期");
  }
}

export async function readJsonBody(request: Request, maximumBytes: number) {
  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new WebChatError("AI_INVALID_REQUEST", "Content-Type 必须是 application/json", 400);
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new WebChatError("AI_INVALID_REQUEST", "请求体过大", 400);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new WebChatError("AI_INVALID_REQUEST", "请求体过大", 400);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebChatError("AI_INVALID_REQUEST", "请求体必须是合法 JSON", 400);
  }
}

export function webApiErrorResponse(error: unknown) {
  if (error instanceof WebApiAuthenticationError) {
    return jsonResponse({ code: "AI_UNAUTHENTICATED", message: error.message }, 401);
  }
  if (error instanceof WebChatError || error instanceof AgentClientError) {
    const body: Record<string, unknown> = { code: error.code, message: error.message };
    if (error instanceof AgentClientError && error.quota) body.quota = error.quota;
    if (error instanceof AgentClientError && error.retryAfterSeconds !== undefined) {
      body.retryAfterSeconds = error.retryAfterSeconds;
    }
    return jsonResponse(body, error.httpStatus);
  }
  if (error instanceof QuotaExceededError) {
    return jsonResponse({
      code: "AI_QUOTA_EXCEEDED",
      message: "当前 AI 助手额度已用完，请稍后再试。",
      quota: { period: error.period, retryAfter: error.retryAt },
    }, 429);
  }
  if (error instanceof QuotaStoreError) {
    return jsonResponse({ code: "AI_QUOTA_STORE_UNAVAILABLE", message: "配额存储暂时不可用" }, 503);
  }
  if (error instanceof QuotaPolicyError) {
    return jsonResponse({ code: "AI_QUOTA_CONFIG_INVALID", message: "配额配置无效" }, 500);
  }
  if (
    error instanceof PrincipalError
    || error instanceof ConversationHandleError
    || error instanceof AgentBindingError
  ) {
    return jsonResponse({ code: "AI_AGENT_UNAVAILABLE", message: "AI 助手服务端配置无效" }, 502);
  }
  return jsonResponse({ code: "AI_AGENT_UNAVAILABLE", message: "AI 助手暂时不可用" }, 502);
}
