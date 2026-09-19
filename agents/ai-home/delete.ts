import { scopedAgentConversationId } from "../../lib/ai/agent/ai-agent-service.ts";
import {
  agentErrorResponse,
  conversationIdFromContext,
  errorResponse,
  headerValue,
  isMakersConversationId,
  jsonResponse,
  requireString,
  verifyAgentBinding,
  verifyInternalAuthorization,
  type MakersAgentContext,
} from "./_shared.ts";

export async function onRequest(context: MakersAgentContext) {
  const body = typeof context.request.body === "object" && context.request.body !== null
    ? context.request.body as Record<string, unknown>
    : {};
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
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

    const parsedRequestId = requireString(body.requestId, "requestId");
    const principalId = requireString(body.principalId, "principalId");
    const homeId = requireString(body.homeId, "homeId");
    const sessionBinding = requireString(body.sessionBinding, "sessionBinding");
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is "ai:chat" => scope === "ai:chat")
      : [];
    if (!scopes.includes("ai:chat")) {
      return errorResponse("AI_INVALID_REQUEST", "scopes 必须包含 ai:chat", 400, requestId);
    }
    await verifyAgentBinding(
      sessionBinding,
      { principalId, homeId, scopes },
      context.env.XIAOMI_SESSION_SECRET,
    );
    if (typeof context.store?.deleteConversation !== "function") {
      return errorResponse("AI_AGENT_STORE_UNAVAILABLE", "Agent 会话存储不可用", 503, requestId);
    }
    const scopedId = await scopedAgentConversationId(conversationId, principalId, homeId);
    // The embedded Makers runtime store implements deleteConversation({ conversationId }) -> Promise<void>
    // and raises MemoryNotFoundError when the conversation is absent; the legacy store type models
    // neither, so narrow to the runtime contract at the call site.
    const makersStore = context.store as NonNullable<typeof context.store> & {
      deleteConversation(input: { conversationId: string }): Promise<void>;
    };
    try {
      await makersStore.deleteConversation({ conversationId: scopedId });
      return jsonResponse({ ok: true, deleted: true, requestId: parsedRequestId });
    } catch (error) {
      // Makers raises MemoryNotFoundError only for an absent conversation: already deleted.
      if (error instanceof Error && (error as Error & { code?: unknown }).code === "MemoryNotFoundError") {
        return jsonResponse({ ok: true, deleted: false, requestId: parsedRequestId });
      }
      throw error;
    }
  } catch (error) {
    return agentErrorResponse(error, requestId);
  }
}
