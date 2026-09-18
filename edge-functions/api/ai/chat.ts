import { listHomes, readXiaomiSessionWithSecret } from "../../../lib/xiaomi-cloud.ts";
import type { QuotaStore } from "../../../lib/ai/quota/quota-store.ts";
import { MakersAgentClient } from "../../../lib/ai/web-chat/agent-client.ts";
import { AiWebService } from "../../../lib/ai/web-chat/web-chat-service.ts";
import {
  authenticateXiaomiSession,
  createQuotaService,
  jsonResponse,
  readJsonBody,
  webApiErrorResponse,
  type AiWebContext,
} from "../../../lib/ai/web-chat/web-api-boundary.ts";

type ChatHandlerDependencies = {
  fetchImpl?: typeof fetch;
  loadHomes?: typeof listHomes;
  quotaStore?: QuotaStore;
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
      const quota = context.env.AI_AGENT_BASE_URL
        ? undefined
        : createQuotaService(context.env, {
          store: dependencies.quotaStore,
          now: dependencies.now,
        });
      const agent = new MakersAgentClient({
        baseUrl: context.env.AI_AGENT_BASE_URL || new URL("/", context.request.url).toString(),
        internalSecret: context.env.AI_AGENT_INTERNAL_SECRET,
        fetchImpl: dependencies.fetchImpl,
      });
      const service = new AiWebService({
        env: context.env,
        quota,
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
