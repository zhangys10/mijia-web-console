import {
  errorResponse,
  headerValue,
  jsonResponse,
  verifyInternalAuthorization,
  type MakersAgentContext,
} from "./_shared.ts";

export async function onRequest(context: MakersAgentContext) {
  const body = typeof context.request.body === "object" && context.request.body !== null
    ? context.request.body as Record<string, unknown>
    : {};
  if ((context.request.method ?? "POST") !== "POST") {
    return errorResponse("AI_INVALID_REQUEST", "只允许 POST 请求", 405);
  }
  if (!(await verifyInternalAuthorization(
    headerValue(context.request.headers, "Authorization"),
    context.env.AI_AGENT_INTERNAL_SECRET,
  ))) {
    return errorResponse("AI_UNAUTHENTICATED", "内部 Agent 鉴权无效", 401);
  }

  const conversationId = typeof body.conversation_id === "string"
    ? body.conversation_id
    : typeof body.conversationId === "string"
      ? body.conversationId
      : "";
  if (!/^[A-Za-z0-9_.-]{6,36}$/.test(conversationId)) {
    return errorResponse("AI_INVALID_REQUEST", "conversationId 格式无效", 400);
  }
  const abortActiveRun = context.utils?.abortActiveRun;
  if (typeof abortActiveRun !== "function") {
    return errorResponse("AI_AGENT_STOP_UNAVAILABLE", "当前运行时不支持取消 Agent", 503);
  }
  const stopped = await abortActiveRun(conversationId);
  return jsonResponse({ ok: true, stopped });
}
