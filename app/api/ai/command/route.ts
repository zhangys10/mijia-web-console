import { NextRequest, NextResponse } from "next/server";
import { listHomes, readXiaomiSession, type XiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { listManualScenes, type ManualScene } from "../../../../lib/xiaomi-scenes.ts";
import { loadAiCommandConfig, type AiCommandConfig } from "../../../../lib/ai/config.ts";
import { IntentOrchestrator } from "../../../../lib/ai/intent-orchestrator.ts";
import { QwenOpenAiCompatibleProvider } from "../../../../lib/ai/providers/qwen-openai-provider.ts";
import { IdempotencyStore, isValidIdempotencyKey, requestHash } from "../../../../lib/ai/security/idempotency.ts";
import { extractBearerToken, verifyShortcutAuth } from "../../../../lib/ai/security/auth.ts";
import { verifyAndExtractBinding } from "../../../../lib/ai/security/binding.ts";
import {
  appendConversationTurns,
  evaluateConversationState,
  normalizeHistory,
  sealConversationContext,
  toChatMessages,
  unsealConversationContext,
  type ConversationTurn,
} from "../../../../lib/ai/security/conversation.ts";
import { MiCloudSceneExecutor } from "../../../../lib/ai/executors/scene-executor.ts";
import { SceneService } from "../../../../lib/ai/scenes/scene-service.ts";
import { runtimeScenes, staticAllowedScenes, type AllowedScene } from "../../../../lib/ai/scenes/catalog.ts";
import { sanitizeLlmOutput, sanitizeUserFacingMessage } from "../../../../lib/ai/tools/tool-validator.ts";
import { aiCommandLog } from "../../../../lib/ai/observability/logger.ts";
import type { AiCommandResponse, IntentDecision } from "../../../../lib/ai/types.ts";

const idempotency = new IdempotencyStore();
const allowedTimezones = new Set(["Asia/Shanghai", "UTC"]);

function errorResponse(code: string, status: number, message: string, requestId?: string) {
  return NextResponse.json({ code, message, requestId }, { status });
}

type UserSceneContext = {
  session: XiaomiSession;
  homeId: string;
  scenes: ManualScene[];
};

async function loadUserSceneContext(
  config: AiCommandConfig,
  boundSession?: XiaomiSession,
  boundHomeId?: string,
  explicitHome?: string,
): Promise<UserSceneContext> {
  const session = boundSession ?? (config.session ? await readXiaomiSession(config.session) : undefined);
  if (!session) throw new Error("XIAOMI_AI_SESSION_NOT_CONFIGURED");

  const homes = await listHomes(session);
  if (!homes.length) throw new Error("AI_HOME_NOT_FOUND");

  let homeId: string | undefined;

  // 1. 优先使用显式传递的 home（支持 homeId 或家庭名称）
  if (explicitHome) {
    const matched = homes.find(h => h.id === explicitHome)
      ?? homes.find(h => h.name === explicitHome)
      ?? homes.find(h => h.name.includes(explicitHome) || explicitHome.includes(h.name));
    if (matched) {
      homeId = matched.id;
      console.log("[ai-command] Matched explicit home:", { input: explicitHome, resolvedId: homeId, name: matched.name });
    } else {
      console.warn("[ai-command] Explicit home not found in user homes:", explicitHome);
    }
  }

  // 2. 其次使用 Token 绑定或上下文推断或环境变量
  if (!homeId) {
    homeId = boundHomeId || config.homeId;
  }

  let scenes: ManualScene[] = [];
  if (homeId) {
    try {
      scenes = await listManualScenes(session, homeId);
    } catch (error) {
      console.warn("[ai-command] listManualScenes failed for homeId:", homeId, error instanceof Error ? error.message : error);
      scenes = [];
    }
  }

  // 3. 若指定家庭无场景且未显式强制指定，扫描其他家庭以防选错空家庭
  if (scenes.length === 0 && !explicitHome) {
    for (const home of homes) {
      if (home.id === homeId) continue;
      try {
        const candidate = await listManualScenes(session, home.id);
        if (candidate.length > 0) {
          console.log("[ai-command] Found active scenes in alternative home:", home.id, home.name, "count:", candidate.length);
          homeId = home.id;
          scenes = candidate;
          break;
        }
      } catch {
        // continue search
      }
    }
  }

  if (!homeId) homeId = homes[0].id;
  return { session, homeId, scenes };
}

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "mijia-web-console-ai",
    endpoint: "POST /api/ai/command",
    message: "请使用 POST 方法发送请求，并附带 Authorization 与 Idempotency-Key 标头。",
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Idempotency-Key, Content-Type",
    },
  });
}

export async function POST(request: NextRequest) {
  const config = loadAiCommandConfig();
  const requestId = `req_${crypto.randomUUID().replaceAll("-", "")}`;
  if (!config.enabled) return errorResponse("AI_COMMAND_DISABLED", 503, "AI 控制暂未启用", requestId);

  const authHeader = request.headers.get("authorization");
  const bearerToken = extractBearerToken(authHeader);
  let boundSession: XiaomiSession | undefined;
  let boundHomeId: string | undefined;

  if (bearerToken) {
    const binding = await verifyAndExtractBinding(bearerToken);
    if (binding) {
      boundSession = binding.session;
      boundHomeId = binding.homeId;
    }
  }

  if (!boundSession && !(await verifyShortcutAuth(authHeader, config.authHash))) {
    return errorResponse("UNAUTHORIZED", 401, "快捷指令认证失败", requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key");
  const idempotencyKey = isValidIdempotencyKey(rawIdempotencyKey) ? rawIdempotencyKey : undefined;
  const hash = requestHash(body);

  if (idempotencyKey) {
    const lookup = idempotency.lookup(idempotencyKey, hash);
    if (lookup === "conflict") return errorResponse("IDEMPOTENCY_CONFLICT", 409, "请求重复且内容不一致", requestId);
    if (lookup === "processing") return NextResponse.json({ requestId, status: "processing", message: "请求正在处理" }, { status: 202 });
    const saved = idempotency.get(idempotencyKey);
    if (saved?.status === "completed" && saved.response) {
      console.log("[ai-command] Replaying completed response for idempotency key:", idempotencyKey);
      const response = saved.response as { requestId?: string; code?: string };
      return NextResponse.json({ ...response, requestId: response.requestId ?? requestId }, { status: 200 });
    }
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const locale = body.locale === undefined ? "zh-CN" : body.locale;
  const timezone = body.timezone === undefined ? "Asia/Shanghai" : body.timezone;
  if (text.length < 1 || text.length > 200 || typeof locale !== "string" || locale !== "zh-CN" || typeof timezone !== "string" || !allowedTimezones.has(timezone)) {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }
  const homeParam = typeof body.home === "string" ? body.home.trim() : typeof body.homeId === "string" ? body.homeId.trim() : undefined;
  if (homeParam !== undefined && (homeParam.length < 1 || homeParam.length > 100)) {
    return errorResponse("INVALID_REQUEST", 400, "家庭标识格式有误", requestId);
  }
  const client = body.client;
  if (client !== undefined && (typeof client !== "object" || client === null || Array.isArray(client) || (client as Record<string, unknown>).type !== "siri_shortcut")) {
    return errorResponse("INVALID_REQUEST", 400, "请求格式有误", requestId);
  }

  // 连续对话参数解析与校验
  const conversationIdParam = typeof body.conversationId === "string" ? body.conversationId.trim() : undefined;
  if (conversationIdParam !== undefined && (conversationIdParam.length < 1 || conversationIdParam.length > 128)) {
    return errorResponse("INVALID_REQUEST", 400, "会话标识格式有误", requestId);
  }
  const sessionContextParam = typeof body.sessionContext === "string" ? body.sessionContext.trim() : undefined;
  if (body.sessionContext !== undefined && sessionContextParam === undefined) {
    return errorResponse("INVALID_REQUEST", 400, "上下文格式有误", requestId);
  }

  const explicitHistory = normalizeHistory(body.history, config.conversationMaxTurns);
  if (explicitHistory === null) {
    return errorResponse("INVALID_REQUEST", 400, "历史对话格式有误", requestId);
  }

  let rawPriorTurns: ConversationTurn[] = [];
  let resolvedConversationId = conversationIdParam;
  let contextHomeId: string | undefined;

  if (sessionContextParam) {
    const unsealed = await unsealConversationContext(sessionContextParam, config.conversationMaxTurns);
    if (unsealed) {
      rawPriorTurns = unsealed.turns;
      if (!resolvedConversationId) resolvedConversationId = unsealed.conversationId;
      contextHomeId = unsealed.homeId;
    } else {
      console.warn("[ai-command] sessionContext invalid or expired; starting fresh turn");
    }
  }

  if (explicitHistory && explicitHistory.length > 0) {
    rawPriorTurns = explicitHistory.map(m => ({ role: m.role, content: m.content, timestamp: Date.now() }));
  }

  // 评估对话轮数状态
  const { isReset: conversationReset, effectivePriorTurns, currentTurnIndex } = evaluateConversationState(
    rawPriorTurns,
    config.conversationMaxTurns,
  );

  if (conversationReset) {
    resolvedConversationId = `conv_${crypto.randomUUID().replaceAll("-", "")}`;
  } else if (!resolvedConversationId) {
    resolvedConversationId = `conv_${crypto.randomUUID().replaceAll("-", "")}`;
  }

  const effectiveHome = homeParam || boundHomeId || contextHomeId;
  console.log("[ai-command] Received command:", {
    text,
    homeParam,
    effectiveHome,
    conversationId: resolvedConversationId,
    priorTurnsCount: effectivePriorTurns.length,
    turnIndex: currentTurnIndex,
    conversationReset,
    idempotencyKey,
    hasBoundSession: !!boundSession,
  });


  try {
    const userContext = await loadUserSceneContext(config, boundSession, boundHomeId, effectiveHome);
    const candidateScenes = userContext.scenes.length > 0
      ? runtimeScenes(userContext.scenes)
      : staticAllowedScenes;

    const provider = new QwenOpenAiCompatibleProvider(config);
    const orchestrator = new IntentOrchestrator(provider, config);
    const chatHistory = toChatMessages(effectivePriorTurns);
    let decision: IntentDecision;
    try {
      decision = await orchestrator.decide(text, candidateScenes, locale, timezone, chatHistory);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      const status = message.includes("LLM_TIMEOUT") ? 504 : 502;
      const code = message.includes("LLM_TIMEOUT")
        ? "LLM_TIMEOUT"
        : message.includes("UNSUPPORTED_INTENT")
          ? "UNSUPPORTED_INTENT"
          : "LLM_PROVIDER_ERROR";
      const httpStatus = message.includes("UNSUPPORTED_INTENT") ? 422 : status;
      const response = {
        code,
        message: code === "UNSUPPORTED_INTENT"
          ? ("目前还不支持这个操作：" + message)
          : code === "LLM_TIMEOUT"
            ? "AI 响应超时"
            : ("AI 服务暂时不可用：" + message),
        requestId,
        conversationId: resolvedConversationId,
        conversationReset,
        turnIndex: currentTurnIndex,
        llmError: message,
      };
      if (idempotencyKey) idempotency.fail(idempotencyKey, response, httpStatus);
      aiCommandLog("ai_command_failed", {
        requestId,
        conversationId: resolvedConversationId,
        client: "siri_shortcut",
        code,
        llmError: message,
      });
      console.error("[ai-command] LLM decision error:", message);
      return NextResponse.json(response, { status: httpStatus });
    }

    if (decision.type === "no_action") {
      const rawReplyMessage = decision.llmOutput && !decision.llmOutput.startsWith("call ")
        ? decision.llmOutput
        : "未找到匹配的场景，您可以告诉我具体的场景名称，例如回家模式。";

      const cleanedReply = sanitizeUserFacingMessage(rawReplyMessage, candidateScenes);
      const finalReplyMessage = conversationReset ? `已开启新一轮对话。${cleanedReply}` : cleanedReply;

      const updatedTurns = appendConversationTurns(
        effectivePriorTurns,
        text,
        finalReplyMessage,
        config.conversationMaxTurns,
      );
      const nextSessionContext = await sealConversationContext(
        resolvedConversationId,
        updatedTurns,
        boundSession?.userId,
        userContext.homeId,
        config.conversationMaxTurns,
      );

      const response: AiCommandResponse = {
        requestId,
        conversationId: resolvedConversationId,
        sessionContext: nextSessionContext,
        conversationReset,
        turnIndex: currentTurnIndex,
        status: "completed",
        intent: "none",
        message: finalReplyMessage,
        decisionSource: decision.model === "deterministic_fallback" ? "deterministic_fallback" : "llm",
        llmOutput: sanitizeLlmOutput(decision.llmOutput, candidateScenes),
      };
      if (idempotencyKey) idempotency.complete(idempotencyKey, response);
      aiCommandLog("ai_command_completed", {
        requestId,
        conversationId: resolvedConversationId,
        client: "siri_shortcut",
        decisionSource: response.decisionSource,
        provider: config.provider,
        model: decision.model,
        intent: "none",
        result: "success",
        turnIndex: currentTurnIndex,
        conversationReset,
        turnCount: updatedTurns.length,
        llmLatencyMs: decision.latencyMs,
        llmOutput: response.llmOutput,
      });
      return NextResponse.json(response, { status: 200 });
    }

    // 只有触发实际执行的工具调用时，才强制校验并启用 Idempotency-Key
    if (!idempotencyKey) {
      return errorResponse("INVALID_REQUEST", 400, "执行场景操作必须提供有效的 Idempotency-Key 标头", requestId);
    }
    idempotency.start(idempotencyKey, hash);

    const matchedScene: AllowedScene | undefined = candidateScenes.find(scene => scene.id === decision.arguments.sceneId);
    let targetSceneId = matchedScene?.id;
    if (targetSceneId === "home" && config.sceneId) {
      targetSceneId = config.sceneId;
    }
    if (!targetSceneId || targetSceneId === "home") {
      throw new Error("AI_SCENE_NOT_CONFIGURED");
    }

    const executorConfig = { ...config, homeId: userContext.homeId, sceneId: targetSceneId };
    const sceneService = new SceneService(new MiCloudSceneExecutor(userContext.session, executorConfig), candidateScenes);
    const executionStart = Date.now();
    const execution = await sceneService.activate(targetSceneId, requestId);
    const executionLatencyMs = Date.now() - executionStart;
    const sceneName = matchedScene?.name ?? "指定场景";
    const defaultFallbackMessage = /回家|到家|进门/.test(sceneName)
      ? ("欢迎回家，已经开启「" + sceneName + "」。")
      : ("已经开启「" + sceneName + "」。");
    const rawResponseMessage = (decision.arguments.replyMessage && decision.arguments.replyMessage.trim())
      ? decision.arguments.replyMessage.trim()
      : defaultFallbackMessage;

    const cleanedMessage = sanitizeUserFacingMessage(rawResponseMessage, candidateScenes);
    const finalResponseMessage = conversationReset ? `已开启新一轮对话。${cleanedMessage}` : cleanedMessage;

    const updatedTurns = appendConversationTurns(
      effectivePriorTurns,
      text,
      finalResponseMessage,
      config.conversationMaxTurns,
    );
    const nextSessionContext = await sealConversationContext(
      resolvedConversationId,
      updatedTurns,
      boundSession?.userId,
      userContext.homeId,
      config.conversationMaxTurns,
    );

    const response: AiCommandResponse = {
      requestId,
      conversationId: resolvedConversationId,
      sessionContext: nextSessionContext,
      conversationReset,
      turnIndex: currentTurnIndex,
      status: execution.status === "success" ? "completed" : "partial_success",
      intent: "activate_scene",
      sceneId: targetSceneId,
      sceneName,
      message: finalResponseMessage,
      execution: { status: execution.status, succeeded: execution.succeeded, failed: execution.failed },
      decisionSource: decision.model === "deterministic_fallback" ? "deterministic_fallback" : "llm",
      llmOutput: sanitizeLlmOutput(decision.llmOutput, candidateScenes),
    };
    idempotency.complete(idempotencyKey, response);
    aiCommandLog("ai_command_completed", {
      requestId,
      conversationId: resolvedConversationId,
      client: "siri_shortcut",
      decisionSource: response.decisionSource,
      provider: config.provider,
      model: decision.model,
      intent: response.intent,
      sceneId: response.sceneId,
      sceneName,
      turnIndex: currentTurnIndex,
      conversationReset,
      turnCount: updatedTurns.length,
      llmLatencyMs: decision.latencyMs,
      executionLatencyMs,
      llmOutput: response.llmOutput,
      result: execution.status,
    });
    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error("[ai-command] Unhandled exception occurred:", error instanceof Error ? error.stack || error.message : error);
    const message = error instanceof Error ? error.message : "MI_CLOUD_ERROR";
    if (message === "XIAOMI_AI_SESSION_NOT_CONFIGURED" || message === "AI_SCENE_NOT_CONFIGURED" || message === "AI_HOME_NOT_FOUND") {
      if (idempotencyKey) idempotency.fail(idempotencyKey, { code: "MI_CLOUD_ERROR", message: "米家服务尚未完成配置", requestId }, 502);
      aiCommandLog("ai_command_failed", {
        requestId,
        conversationId: resolvedConversationId,
        client: "siri_shortcut",
        code: "MI_CLOUD_ERROR",
        executorError: message,
      });
      return errorResponse("MI_CLOUD_ERROR", 502, "米家服务尚未完成配置", requestId);
    }
    const isTimeout = message === "DEVICE_TIMEOUT" || message.includes("TIMEOUT") || message.includes("timeout");
    const code = isTimeout ? "DEVICE_TIMEOUT" : "MI_CLOUD_ERROR";
    const status = isTimeout ? 504 : 502;
    if (idempotencyKey) idempotency.fail(idempotencyKey, { code, message: isTimeout ? "设备响应超时" : "米家服务暂时不可用", requestId }, status);
    aiCommandLog("ai_command_failed", {
      requestId,
      conversationId: resolvedConversationId,
      client: "siri_shortcut",
      code,
      executorError: message,
    });
    return errorResponse(code, status, isTimeout ? "设备响应超时" : "米家服务暂时不可用", requestId);
  }
}
