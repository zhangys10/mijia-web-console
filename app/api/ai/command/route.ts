import { NextRequest, NextResponse } from "next/server";
import { readXiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { loadAiCommandConfig, type AiCommandConfig } from "../../../../lib/ai/config.ts";
import { IntentOrchestrator } from "../../../../lib/ai/intent-orchestrator.ts";
import { QwenOpenAiCompatibleProvider } from "../../../../lib/ai/providers/qwen-openai-provider.ts";
import { IdempotencyStore, requestHash } from "../../../../lib/ai/security/idempotency.ts";
import { verifyShortcutAuth } from "../../../../lib/ai/security/auth.ts";
import { MiCloudSceneExecutor } from "../../../../lib/ai/executors/scene-executor.ts";
import { SceneService } from "../../../../lib/ai/scenes/scene-service.ts";
import { aiCommandLog } from "../../../../lib/ai/observability/logger.ts";
import type { AiCommandResponse, IntentDecision } from "../../../../lib/ai/types.ts";

const idempotency = new IdempotencyStore();
const allowedTimezones = new Set(["Asia/Shanghai", "UTC"]);

function errorResponse(code: string, status: number, message: string, requestId?: string) {
  return NextResponse.json({ code, message, requestId }, { status });
}

async function createExecutor(config: AiCommandConfig) {
  const session = await readXiaomiSession(config.session);
  return new SceneService(new MiCloudSceneExecutor(session, config));
}

export async function POST(request: NextRequest) {
  const config = loadAiCommandConfig();
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!config.enabled) return errorResponse("AI_COMMAND_DISABLED", 503, "AI 控制暂未启用", requestId);
  if (!(await verifyShortcutAuth(request.headers.get("authorization"), config.authHash))) {
    return errorResponse("UNAUTHORIZED", 401, "快捷指令认证失败", requestId);
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }
  const hash = requestHash(body);
  const lookup = idempotency.lookup(idempotencyKey, hash);
  if (lookup === "conflict") return errorResponse("IDEMPOTENCY_CONFLICT", 409, "请求重复且内容不一致", requestId);
  if (lookup === "processing") return NextResponse.json({ requestId, status: "processing", message: "请求正在处理" }, { status: 202 });
  const saved = idempotency.get(idempotencyKey);
  if (saved?.response) {
    const response = saved.response as { requestId?: string; code?: string };
    const status = saved.httpStatus ?? (saved.status === "failed" ? 502 : 200);
    return NextResponse.json({ ...response, requestId: response.requestId ?? requestId }, { status });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const locale = body.locale === undefined ? "zh-CN" : body.locale;
  const timezone = body.timezone === undefined ? "Asia/Shanghai" : body.timezone;
  if (text.length < 1 || text.length > 200 || typeof locale !== "string" || locale !== "zh-CN" || typeof timezone !== "string" || !allowedTimezones.has(timezone)) {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }
  const client = body.client;
  if (client !== undefined && (typeof client !== "object" || client === null || Array.isArray(client) || (client as Record<string, unknown>).type !== "siri_shortcut")) {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }

  idempotency.start(idempotencyKey, hash);
  try {
    const provider = new QwenOpenAiCompatibleProvider(config);
    const orchestrator = new IntentOrchestrator(provider, config);
    let decision: IntentDecision;
    try {
      decision = await orchestrator.decide(text, locale, timezone);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      const status = message === "LLM_TIMEOUT" ? 504 : 502;
      const code = message === "LLM_TIMEOUT" ? "LLM_TIMEOUT" : message === "UNSUPPORTED_INTENT" ? "UNSUPPORTED_INTENT" : "LLM_PROVIDER_ERROR";
      const httpStatus = message === "UNSUPPORTED_INTENT" ? 422 : status;
      const response = { code, message: code === "UNSUPPORTED_INTENT" ? "目前还不支持这个操作" : code === "LLM_TIMEOUT" ? "AI 响应超时" : "AI 服务暂时不可用", requestId };
      idempotency.fail(idempotencyKey, response, httpStatus);
      aiCommandLog("ai_command_failed", { requestId, code, llmError: message });
      return NextResponse.json(response, { status: httpStatus });
    }

    if (decision.type === "no_action") {
      const response: AiCommandResponse = { requestId, status: "not_understood", message: "我目前只能执行回家模式。你可以说：我回家了。" };
      idempotency.complete(idempotencyKey, response);
      aiCommandLog("ai_command_completed", { requestId, status: response.status, result: "not_understood" });
      return NextResponse.json(response, { status: 200 });
    }

    const sceneService = await createExecutor(config);
    const execution = await sceneService.activate(decision.arguments.sceneId, requestId);
    const response: AiCommandResponse = {
      requestId,
      status: execution.status === "success" ? "completed" : "partial_success",
      intent: "activate_scene",
      sceneId: decision.arguments.sceneId,
      message: execution.message,
      execution: { status: execution.status, succeeded: execution.succeeded, failed: execution.failed },
      decisionSource: decision.model === "deterministic_fallback" ? "deterministic_fallback" : "llm",
    };
    idempotency.complete(idempotencyKey, response);
    aiCommandLog("ai_command_completed", { requestId, decisionSource: response.decisionSource, provider: config.provider, model: decision.model, intent: response.intent, sceneId: response.sceneId, result: execution.status, llmLatencyMs: decision.latencyMs });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MI_CLOUD_ERROR";
    const code = message === "DEVICE_TIMEOUT" ? "DEVICE_TIMEOUT" : message === "SCENE_NOT_CONFIGURED" ? "MI_CLOUD_ERROR" : "MI_CLOUD_ERROR";
    const status = code === "DEVICE_TIMEOUT" ? 504 : 502;
    idempotency.fail(idempotencyKey, { code, message: code === "DEVICE_TIMEOUT" ? "设备响应超时" : "米家服务暂时不可用", requestId }, status);
    aiCommandLog("ai_command_failed", { requestId, code, executorError: message });
    return errorResponse(code, code === "DEVICE_TIMEOUT" ? 504 : 502, code === "DEVICE_TIMEOUT" ? "设备响应超时" : "米家服务暂时不可用", requestId);
  }
}
