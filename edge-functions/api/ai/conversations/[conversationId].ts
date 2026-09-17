import { listHomes, readXiaomiSessionWithSecret } from "../../../../lib/xiaomi-cloud.ts";
import { MakersAgentClient } from "../../../../lib/ai/web-chat/agent-client.ts";
import { AiWebService, WebChatError } from "../../../../lib/ai/web-chat/web-chat-service.ts";
import {
  authenticateXiaomiSession,
  jsonResponse,
  webApiErrorResponse,
  type AiWebContext,
} from "../../../../lib/ai/web-chat/web-api-boundary.ts";

type DeleteConversationHandlerDependencies = {
  fetchImpl?: typeof fetch;
  loadHomes?: typeof listHomes;
  readSession?: typeof readXiaomiSessionWithSecret;
  now?: () => number;
  randomUuid?: () => string;
};

function conversationIdFromRequest(request: Request) {
  const segment = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

export function createDeleteConversationHandler(
  dependencies: DeleteConversationHandlerDependencies = {},
) {
  return async function onRequest(context: AiWebContext) {
    if (context.request.method !== "DELETE") {
      return jsonResponse({ code: "AI_INVALID_REQUEST", message: "只允许 DELETE 请求" }, 405);
    }
    try {
      const conversationId = conversationIdFromRequest(context.request);
      if (!conversationId) {
        throw new WebChatError("AI_INVALID_REQUEST", "conversationId 必填", 400);
      }
      const session = await authenticateXiaomiSession(
        context.request,
        context.env,
        dependencies.readSession,
      );
      const agent = new MakersAgentClient({
        baseUrl: new URL("/", context.request.url).toString(),
        internalSecret: context.env.AI_AGENT_INTERNAL_SECRET,
        fetchImpl: dependencies.fetchImpl,
      });
      const service = new AiWebService({
        env: context.env,
        agent,
        loadHomes: dependencies.loadHomes,
        now: dependencies.now,
        randomUuid: dependencies.randomUuid,
      });
      return jsonResponse(
        await service.deleteConversation(session, conversationId, context.request.signal),
        200,
      );
    } catch (error) {
      return webApiErrorResponse(error);
    }
  };
}

export const onRequest = createDeleteConversationHandler();
