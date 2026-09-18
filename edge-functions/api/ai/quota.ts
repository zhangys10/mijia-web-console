import { readXiaomiSessionWithSecret } from "../../../lib/xiaomi-cloud.ts";
import { MakersAgentClient } from "../../../lib/ai/web-chat/agent-client.ts";
import { webApiErrorResponse } from "../../../lib/ai/web-chat/web-api-boundary.ts";
import { derivePrincipalId } from "../../../lib/ai/security/principal.ts";
import { loadQuotaPolicy } from "../../../lib/ai/quota/policy.ts";
import { EdgeOneKvQuotaStore, type EdgeOneKvBinding } from "../../../lib/ai/quota/edgeone-kv-quota-store.ts";
import { QuotaService } from "../../../lib/ai/quota/quota-service.ts";
import { QuotaStoreError } from "../../../lib/ai/quota/quota-store.ts";

type EdgeOneQuotaContext = {
  request: Request;
  env: Record<string, string | undefined>;
};

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE_HEADERS });
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("Cookie") ?? "";
  for (const part of cookies.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator) === name) return decodeURIComponent(part.slice(separator + 1));
  }
  return undefined;
}

function resolveKvBinding(env: Record<string, string | undefined>) {
  const bindingName = env.AI_QUOTA_KV_BINDING?.trim() || "ai_quota_kv";
  const bindings = globalThis as typeof globalThis & Record<string, unknown>;
  const binding = bindings[bindingName];
  return binding && typeof binding === "object" && "get" in binding && "put" in binding
    ? binding as EdgeOneKvBinding
    : undefined;
}

const unavailableStore = {
  async reserve() {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额存储未绑定");
  },
  async commit() {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额存储未绑定");
  },
  async release() {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额存储未绑定");
  },
  async getSnapshot() {
    throw new QuotaStoreError("AI_QUOTA_STORE_UNAVAILABLE", "配额存储未绑定");
  },
};

export async function onRequest(context: EdgeOneQuotaContext) {
  if (context.request.method !== "GET") {
    return json({ code: "AI_INVALID_REQUEST", message: "只允许 GET 请求" }, 405);
  }

  const sessionCookie = readCookie(context.request, "xiaomi_session");
  if (!sessionCookie) {
    return json({ code: "AI_UNAUTHENTICATED", message: "请先登录米家账号" }, 401);
  }

  let session;
  try {
    session = await readXiaomiSessionWithSecret(sessionCookie, context.env.XIAOMI_SESSION_SECRET);
  } catch {
    return json({ code: "AI_UNAUTHENTICATED", message: "小米会话无效或已过期" }, 401);
  }

  let principalId;
  try {
    principalId = await derivePrincipalId(session, context.env);
  } catch {
    return json({ code: "AI_PRINCIPAL_ERROR", message: "服务端身份派生尚未配置" }, 500);
  }

  if (context.env.AI_AGENT_BASE_URL) {
    try {
      const agent = new MakersAgentClient({
        baseUrl: context.env.AI_AGENT_BASE_URL,
        internalSecret: context.env.AI_AGENT_INTERNAL_SECRET,
      });
      return json({ quota: await agent.getQuota(principalId) }, 200);
    } catch (error) {
      return webApiErrorResponse(error);
    }
  }

  let policy;
  try {
    policy = loadQuotaPolicy(context.env);
  } catch {
    return json({ code: "AI_QUOTA_CONFIG_INVALID", message: "配额配置无效" }, 500);
  }

  const binding = resolveKvBinding(context.env);
  const store = binding
    ? new EdgeOneKvQuotaStore(binding, {
      env: context.env.APP_ENV ?? context.env.NODE_ENV ?? "development",
    })
    : unavailableStore;
  const service = new QuotaService(store, policy);

  try {
    const quota = await service.getSummary(principalId);
    return json({ quota }, 200);
  } catch (error) {
    if (error instanceof QuotaStoreError) {
      return json({ code: "AI_QUOTA_STORE_UNAVAILABLE", message: "配额存储暂时不可用" }, 503);
    }
    return json({ code: "AI_QUOTA_ERROR", message: "暂时无法读取配额摘要" }, 500);
  }
}
