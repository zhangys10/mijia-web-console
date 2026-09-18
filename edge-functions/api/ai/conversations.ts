import { listHomes, readXiaomiSessionWithSecret } from "../../../lib/xiaomi-cloud.ts";
import { AiWebService, WebChatError } from "../../../lib/ai/web-chat/web-chat-service.ts";
import {
  authenticateXiaomiSession,
  jsonResponse,
  readJsonBody,
  webApiErrorResponse,
  type AiWebContext,
} from "../../../lib/ai/web-chat/web-api-boundary.ts";

type ConversationHandlerDependencies = {
  loadHomes?: typeof listHomes;
  readSession?: typeof readXiaomiSessionWithSecret;
  randomBytes?: (length: number) => Uint8Array;
};

export function createConversationHandler(dependencies: ConversationHandlerDependencies = {}) {
  return async function onRequest(context: AiWebContext) {
    if (context.request.method !== "POST") {
      return jsonResponse({ code: "AI_INVALID_REQUEST", message: "只允许 POST 请求" }, 405);
    }
    try {
      const session = await authenticateXiaomiSession(
        context.request,
        context.env,
        dependencies.readSession,
      );
      const body = await readJsonBody(context.request, 1024);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new WebChatError("AI_INVALID_REQUEST", "请求体必须是 JSON 对象", 400);
      }
      const record = body as Record<string, unknown>;
      if (Object.keys(record).some((key) => key !== "homeId")) {
        throw new WebChatError("AI_INVALID_REQUEST", "请求包含不允许的字段", 400);
      }
      const service = new AiWebService({
        env: context.env,
        loadHomes: dependencies.loadHomes,
        randomBytes: dependencies.randomBytes,
      });
      const conversationId = await service.createConversation(session, record.homeId);
      return jsonResponse({ conversationId }, 201);
    } catch (error) {
      return webApiErrorResponse(error);
    }
  };
}

export const onRequest = createConversationHandler();
