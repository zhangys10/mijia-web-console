import { listHomes, readXiaomiSessionWithSecret } from "../../../lib/xiaomi-cloud.ts";
import { MakersAgentClient } from "../../../lib/ai/web-chat/agent-client.ts";
import { AiWebService } from "../../../lib/ai/web-chat/web-chat-service.ts";
import {
  authenticateXiaomiSession,
  jsonResponse,
  readJsonBody,
  webApiErrorResponse,
  type AiWebContext,
} from "../../../lib/ai/web-chat/web-api-boundary.ts";

type ChatHandlerDependencies = {
  fetchImpl?: typeof fetch;
  loadHomes?: typeof listHomes;
  readSession?: typeof readXiaomiSessionWithSecret;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  randomUuid?: () => string;
};

const MAX_CHAT_REQUEST_BYTES = 8 * 1024;

export function createChatHandler(dependencies: ChatHandlerDependencies = {}) {
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
      const body = await readJsonBody(context.request, MAX_CHAT_REQUEST_BYTES);
      const agent = context.env.AI_AGENT_BASE_URL
        ? new MakersAgentClient({
          baseUrl: context.env.AI_AGENT_BASE_URL,
          internalSecret: context.env.AI_AGENT_INTERNAL_SECRET,
          fetchImpl: dependencies.fetchImpl,
        })
        : undefined;
      const service = new AiWebService({
        env: context.env,
        agent,
        loadHomes: dependencies.loadHomes,
        now: dependencies.now,
        randomBytes: dependencies.randomBytes,
        randomUuid: dependencies.randomUuid,
      });
      return jsonResponse(await service.chat(session, body, context.request.signal), 200);
    } catch (error) {
      return webApiErrorResponse(error);
    }
  };
}

export const onRequest = createChatHandler();
