import { NextRequest, NextResponse } from "next/server";
import { listHomes, readXiaomiSession, type XiaomiSession } from "../../../../lib/xiaomi-cloud.ts";
import { listManualScenes, type ManualScene } from "../../../../lib/xiaomi-scenes.ts";
import { loadAiCommandConfig, type AiCommandConfig } from "../../../../lib/ai/config.ts";
import { IntentOrchestrator } from "../../../../lib/ai/intent-orchestrator.ts";
import {
  QwenOpenAiCompatibleProvider,
  type ResolvedProviderCredential,
} from "../../../../lib/ai/providers/qwen-openai-provider.ts";
import { resolveProvider } from "../../../../lib/ai/providers/provider-catalog.ts";
import {
  openAutomationToken,
  AutomationTokenError,
} from "../../../../lib/ai/security/automation-token.ts";
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
    }
  }

  // 2. 其次使用 Siri Binding 绑定的默认 homeId
  if (!homeId && boundHomeId) {
    const matchedBound = homes.find(h => h.id === boundHomeId);
    if (matchedBound) {
      homeId = matchedBound.id;
      console.log("[ai-command] Using bound session home:", { homeId, name: matchedBound.name });
    }
  }

  // 3. 再次使用服务端配置的全局备选 homeId
  if (!homeId && config.homeId) {
    const matchedConfig = homes.find(h => h.id === config.homeId);
    if (matchedConfig) {
      homeId = matchedConfig.id;
      console.log("[ai-command] Using configured default home:", { homeId, name: matchedConfig.name });
    }
  }

  // 4. 最后兜底为用户拥有的第一个家庭
  if (!homeId) {
    homeId = homes[0].id;
    console.log("[ai-command] Falling back to user first home:", { homeId, name: homes[0].name });
  }

  // 异步获取该家庭下的所有手动场景，构建动态意图匹配列表
  let scenes: ManualScene[] = [];
  try {
    scenes = await listManualScenes(session, homeId);
    console.log(`[ai-command] Loaded ${scenes.length} manual scenes for home:`, homeId);
  } catch (err) {
    console.warn(`[ai-command] Failed to load manual scenes for home ${homeId}:`, err);
  }

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
  let requestCredential: ResolvedProviderCredential | undefined;

  if (bearerToken) {
    if (bearerToken.startsWith("v1.") && bearerToken.split(".").length === 5) {
      try {
        const payload = await openAutomationToken(bearerToken);
        boundSession = payload.xiaomiSession;
        boundHomeId = payload.homeId;
        const resolved = resolveProvider(payload.provider, payload.model);
        requestCredential = {
          provider: resolved.provider.id,
          apiToken: payload.apiKey,
          baseUrl: resolved.baseUrl,
          model: resolved.model,
        };
      } catch (err) {
        if (err instanceof AutomationTokenError) {
          if (err.code === "AUTOMATION_TOKEN_EXPIRED") {
            return errorResponse("AUTOMATION_TOKEN_EXPIRED", 401, "自动化凭据已过期，请重新生成", requestId);
          }
          return errorResponse("AUTOMATION_TOKEN_INVALID", 401, "自动化凭据无效，请重新生成", requestId);
        }
        return errorResponse("AUTOMATION_TOKEN_INVALID", 401, "自动化凭据无效，请重新生成", requestId);
      }
    } else {
      const binding = await verifyAndExtractBinding(bearerToken);
      if (binding) {
        boundSession = binding.session;
        boundHomeId = binding.homeId;
      }
    }
  }

  const isStaticAuthorized = !boundSession && (await verifyShortcutAuth(authHeader, config.authHash));

  if (!boundSession && !isStaticAuthorized) {
    return errorResponse("UNAUTHORIZED", 401, "快捷指令认证失败", requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
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

  // 必须拥有有效的用户模型凭据；未配置时返回 422 LLM_CREDENTIAL_NOT_CONFIGURED
  if (!requestCredential) {
    return errorResponse(
      "LLM_CREDENTIAL_NOT_CONFIGURED",
      422,
      "当前用户未配置模型 Token，请先在网页控制台生成包含个人 API Key 的自动化凭据",
      requestId,
    );
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
      decision = await orchestrator.decide(text, candidateScenes, locale, timezone, chatHistory, requestCredential);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      if (message === "LLM_CREDENTIAL_INVALID") {
        if (idempotencyKey) {
          idempotency.fail(idempotencyKey, { code: "LLM_CREDENTIAL_INVALID", message: "模型 API Token 已失效，请重新生成", requestId }, 422);
        }
        aiCommandLog("ai_command_failed", {
          requestId,
          conversationId: resolvedConversationId,
          client: "siri_shortcut",
          code: "LLM_CREDENTIAL_INVALID",
          executorError: message,
        });
        return errorResponse("LLM_CREDENTIAL_INVALID", 422, "模型 API Token 已失效，请重新生成", requestId);
      }
      if (message === "LLM_CREDENTIAL_NOT_CONFIGURED") {
        if (idempotencyKey) {
          idempotency.fail(idempotencyKey, { code: "LLM_CREDENTIAL_NOT_CONFIGURED", message: "当前用户未配置模型 Token", requestId }, 422);
        }
        aiCommandLog("ai_command_failed", {
          requestId,
          conversationId: resolvedConversationId,
          client: "siri_shortcut",
          code: "LLM_CREDENTIAL_NOT_CONFIGURED",
          executorError: message,
        });
        return errorResponse("LLM_CREDENTIAL_NOT_CONFIGURED", 422, "当前用户未配置模型 Token", requestId);
      }
      const isTimeout = message.includes("LLM_TIMEOUT") || message.includes("TIMEOUT");
      const status = isTimeout ? 504 : 502;
      const code = isTimeout
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
        status: "not_understood",
        intent: "none",
        message: finalReplyMessage,
        decisionSource: decision.model === "deterministic_fallback" ? "deterministic_fallback" : "llm",
        llmOutput: sanitizeLlmOutput(decision.llmOutput, candidateScenes),
      };
      aiCommandLog("ai_command_completed", {
        requestId,
        conversationId: resolvedConversationId,
        client: "siri_shortcut",
        decisionSource: response.decisionSource,
        provider: requestCredential.provider,
        model: decision.model,
        intent: "none",
        turnIndex: currentTurnIndex,
        conversationReset,
        turnCount: updatedTurns.length,
        llmLatencyMs: decision.latencyMs,
        executionLatencyMs: 0,
        llmOutput: response.llmOutput,
        result: "not_understood",
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
      provider: requestCredential.provider,
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
