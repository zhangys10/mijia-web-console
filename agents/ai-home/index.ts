import {
  agentErrorResponse,
  conversationIdFromContext,
  createAgentService,
  errorResponse,
  headerValue,
  isMakersConversationId,
  jsonResponse,
  parseInternalRequest,
  verifyAgentBinding,
  verifyInternalAuthorization,
  type MakersAgentContext,
} from "./_shared.ts";

export async function onRequest(context: MakersAgentContext) {
  const rawBody = typeof context.request.body === "object" && context.request.body !== null
    ? context.request.body as Record<string, unknown>
    : {};
  const requestId = typeof rawBody.requestId === "string" ? rawBody.requestId : undefined;
  try {
    if ((context.request.method ?? "POST") !== "POST") {
      return errorResponse("AI_INVALID_REQUEST", "只允许 POST 请求", 405, requestId);
    }
    const conversationId = conversationIdFromContext(context);
    if (!isMakersConversationId(conversationId)) {
      return errorResponse("AI_INVALID_REQUEST", "Makers-Conversation-Id 格式无效", 400, requestId);
    }
    if (!(await verifyInternalAuthorization(
      headerValue(context.request.headers, "Authorization"),
      context.env.AI_AGENT_INTERNAL_SECRET,
    ))) {
      return errorResponse("AI_UNAUTHENTICATED", "内部 Agent 鉴权无效", 401, requestId);
    }

    const request = parseInternalRequest(context.request.body);
    const binding = await verifyAgentBinding(
      request.sessionBinding,
      {
        principalId: request.principalId,
        homeId: request.homeId,
        scopes: request.scopes,
      },
      context.env.XIAOMI_SESSION_SECRET,
    );

    const service = createAgentService(context);
    const result = await service.run({
      requestId: request.requestId,
      conversationId,
      message: request.message,
      idempotencyKey: request.idempotencyKey,
      locale: request.locale,
      timezone: request.timezone,
      binding,
      signal: context.request.signal,
    });
    return jsonResponse(result);
  } catch (error) {
    return agentErrorResponse(error, requestId);
  }
}
