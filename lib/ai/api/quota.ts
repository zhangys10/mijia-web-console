import { readXiaomiSessionWithSecret } from "../../xiaomi-cloud.ts";
import { MakersAgentClient } from "../web-chat/agent-client.ts";
import { webApiErrorResponse } from "../web-chat/web-api-boundary.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { isQuotaEnabled } from "../quota/policy.ts";
import { disabledQuotaSummary } from "../quota/quota-service.ts";

type QuotaContext = { request: Request; env: Record<string, string | undefined> };
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator) === name) {
      try { return decodeURIComponent(part.slice(separator + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

export async function onRequest(context: QuotaContext) {
  if (context.request.method !== "GET") return json({ code: "AI_INVALID_REQUEST", message: "只允许 GET 请求" }, 405);
  const cookie = readCookie(context.request, "xiaomi_session");
  if (!cookie) return json({ code: "AI_UNAUTHENTICATED", message: "请先登录米家账号" }, 401);
  let session;
  try { session = await readXiaomiSessionWithSecret(cookie, context.env.XIAOMI_SESSION_SECRET); }
  catch { return json({ code: "AI_UNAUTHENTICATED", message: "小米会话无效或已过期" }, 401); }
  let principalId: string;
  try { principalId = await derivePrincipalId(session, context.env); }
  catch { return json({ code: "AI_PRINCIPAL_ERROR", message: "服务端身份派生尚未配置" }, 500); }
  let enabled: boolean;
  try { enabled = isQuotaEnabled(context.env); }
  catch { return json({ code: "AI_QUOTA_CONFIG_INVALID", message: "配额配置无效" }, 500); }
  if (!enabled) return json({ quota: disabledQuotaSummary(principalId) });
  if (!context.env.AI_AGENT_BASE_URL) {
    return json({ code: "AI_AGENT_UNAVAILABLE", message: "AI 助手服务暂时不可用" }, 502);
  }
  try {
    const agent = new MakersAgentClient({
      baseUrl: context.env.AI_AGENT_BASE_URL,
      internalSecret: context.env.AI_AGENT_INTERNAL_SECRET,
    });
    return json({ quota: await agent.getQuota(principalId) });
  } catch (error) {
    return webApiErrorResponse(error);
  }
}
