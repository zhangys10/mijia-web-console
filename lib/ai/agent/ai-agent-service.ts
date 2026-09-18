import type { AgentBindingPayload } from "../security/agent-binding.ts";
import type { SafeAgentScene, AgentSceneRecord, AgentSceneSummary } from "../tools/agent-scene-catalog.ts";
import { safeScenesForModel } from "../tools/agent-scene-catalog.ts";
import { listScenes } from "../tools/list-scenes.ts";
import { validateActivateSceneCall } from "../tools/activate-scene.ts";
import { sanitizeUserFacingMessage } from "../tools/tool-validator.ts";
import type { ModelUsage, RawIntentDecision, SceneExecutionResult } from "../types.ts";
import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import type { AgentConversationStore, StoredAgentMessage } from "./agent-store.ts";
import type { AgentIdempotencyStoreLike } from "./idempotency.ts";
import { AgentTraceCollector } from "./tracing.ts";

export type AgentIntentProvider = {
  decide(
    text: string,
    allowedScenes: readonly SafeAgentScene[],
    locale: string,
    timezone: string,
    history?: readonly StoredAgentMessage[],
    signal?: AbortSignal,
  ): Promise<RawIntentDecision>;
};

export type AgentSceneLoader = (input: {
  principalId: string;
  homeId: string;
  session: XiaomiSession;
}) => Promise<AgentSceneRecord[]>;

export type AgentSceneExecutor = (input: {
  session: XiaomiSession;
  scene: AgentSceneRecord;
  requestId: string;
}) => Promise<SceneExecutionResult>;

export type AgentRunInput = {
  requestId: string;
  conversationId: string;
  message: string;
  idempotencyKey: string;
  locale: string;
  timezone: string;
  binding: AgentBindingPayload;
  signal?: AbortSignal;
};

export type AgentRunResult = {
  requestId: string;
  conversationId: string;
  message: string;
  intent: "none" | "list_scenes" | "activate_scene";
  scenes?: AgentSceneSummary[];
  tool?: {
    name: "list_scenes" | "activate_scene";
    status: "success" | "partial_success";
    sceneName?: string;
  };
  usage?: ModelUsage;
};

export class AiAgentError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "AiAgentError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const MESSAGE_MIN_LENGTH = 1;
const MESSAGE_MAX_LENGTH = 500;
const REQUEST_ID_MIN_LENGTH = 16;
const REQUEST_ID_MAX_LENGTH = 128;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_.-]{6,36}$/;
const HISTORY_LIMIT = 12;

function validateRunInput(input: AgentRunInput) {
  const message = input.message.trim();
  if (message.length < MESSAGE_MIN_LENGTH || message.length > MESSAGE_MAX_LENGTH) {
    throw new AiAgentError("AI_INVALID_REQUEST", "消息长度必须在 1 到 500 个字符之间");
  }
  if (
    input.requestId.length < REQUEST_ID_MIN_LENGTH
    || input.requestId.length > REQUEST_ID_MAX_LENGTH
  ) {
    throw new AiAgentError("AI_INVALID_REQUEST", "requestId 格式无效");
  }
  if (!CONVERSATION_ID_PATTERN.test(input.conversationId)) {
    throw new AiAgentError("AI_INVALID_REQUEST", "conversationId 格式无效");
  }
  if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) {
    throw new AiAgentError("AI_INVALID_REQUEST", "idempotencyKey 长度必须在 16 到 128 之间");
  }
  return { ...input, message };
}

export async function scopedAgentConversationId(
  conversationId: string,
  principalId: string,
  homeId: string,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${conversationId}:${principalId}:${homeId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `agent_${hex.slice(0, 24)}`;
}

function noActionMessage(decision: RawIntentDecision, safeScenes: readonly SafeAgentScene[]) {
  const raw = decision.llmOutput?.trim();
  if (!raw) return "我还不确定要执行哪个场景，可以说“查看可用场景”或直接说出场景名称。";
  return sanitizeUserFacingMessage(raw, safeScenes);
}

export class AiAgentService {
  private readonly provider: AgentIntentProvider;
  private readonly loadScenes: AgentSceneLoader;
  private readonly executeScene: AgentSceneExecutor;
  private readonly store: AgentConversationStore;
  private readonly idempotency: AgentIdempotencyStoreLike;
  private readonly trace: AgentTraceCollector;

  constructor(input: {
    provider: AgentIntentProvider;
    loadScenes: AgentSceneLoader;
    executeScene: AgentSceneExecutor;
    store: AgentConversationStore;
    idempotency: AgentIdempotencyStoreLike;
    trace?: AgentTraceCollector;
  }) {
    this.provider = input.provider;
    this.loadScenes = input.loadScenes;
    this.executeScene = input.executeScene;
    this.store = input.store;
    this.idempotency = input.idempotency;
    this.trace = input.trace ?? new AgentTraceCollector();
  }

  async run(rawInput: AgentRunInput): Promise<AgentRunResult> {
    const input = validateRunInput(rawInput);
    const binding = rawInput.binding;
    if (binding.principalId !== input.binding.principalId || binding.homeId !== input.binding.homeId) {
      throw new AiAgentError("AI_AGENT_BINDING_MISMATCH", "可信上下文不匹配", 403);
    }

    const scopedId = await scopedAgentConversationId(
      input.conversationId,
      binding.principalId,
      binding.homeId,
    );
    await this.store.updateConversation(scopedId, {
      metadata: { principalId: binding.principalId, homeId: binding.homeId },
    });

    const hash = await this.idempotency.requestHash({
      principalId: binding.principalId,
      homeId: binding.homeId,
      conversationId: input.conversationId,
      message: input.message,
      locale: input.locale,
      timezone: input.timezone,
    });
    const idempotencyState = await this.idempotency.lookup(
      binding.principalId,
      binding.homeId,
      input.idempotencyKey,
      hash,
    );
    if (idempotencyState === "completed") {
      const record = await this.idempotency.get(
        binding.principalId,
        binding.homeId,
        input.idempotencyKey,
      );
      return record?.response as AgentRunResult;
    }
    if (idempotencyState === "processing") {
      throw new AiAgentError("AI_REQUEST_IN_PROGRESS", "相同请求正在处理中", 409);
    }
    if (idempotencyState === "conflict") {
      throw new AiAgentError("AI_IDEMPOTENCY_CONFLICT", "相同幂等键对应不同请求", 409);
    }
    await this.idempotency.start(
      binding.principalId,
      binding.homeId,
      input.idempotencyKey,
      hash,
    );

    try {
      if (input.signal?.aborted) throw new AiAgentError("AI_AGENT_CANCELLED", "请求已取消", 499);
      const history = await this.store.getMessages({
        conversationId: scopedId,
        limit: HISTORY_LIMIT,
        order: "asc",
      });
      await this.store.appendMessage({
        conversationId: scopedId,
        role: "user",
        content: input.message,
        metadata: { requestId: input.requestId },
      });

      const scenes = await this.loadScenes({
        principalId: binding.principalId,
        homeId: binding.homeId,
        session: binding.session,
      });
      const safeScenes = safeScenesForModel(scenes);
      const modelStartedAt = Date.now();
      const decision = await this.provider.decide(
        input.message,
        safeScenes,
        input.locale,
        input.timezone,
        history,
        input.signal,
      );
      this.trace.record({
        type: "model_call",
        requestId: input.requestId,
        model: decision.model,
        latencyMs: Date.now() - modelStartedAt,
      });

      let result: AgentRunResult;
      if (decision.type === "no_action") {
        result = {
          requestId: input.requestId,
          conversationId: input.conversationId,
          message: noActionMessage(decision, safeScenes),
          intent: "none",
          usage: decision.usage,
        };
      } else if (decision.tool === "list_scenes") {
        const toolStartedAt = Date.now();
        const list = listScenes(scenes);
        this.trace.record({
          type: "tool_call",
          requestId: input.requestId,
          tool: "list_scenes",
          status: "success",
          latencyMs: Date.now() - toolStartedAt,
        });
        result = {
          requestId: input.requestId,
          conversationId: input.conversationId,
          message: scenes.length
            ? "当前家庭可用场景如下。"
            : "当前家庭还没有可用于 AI 的审核场景。",
          intent: "list_scenes",
          scenes: list.scenes,
          tool: { name: "list_scenes", status: "success" },
          usage: decision.usage,
        };
      } else {
        const validation = validateActivateSceneCall({
          tool: decision.tool,
          alias: decision.arguments.sceneId,
          scenes,
          context: {
            principalId: binding.principalId,
            homeId: binding.homeId,
            scopes: binding.scopes,
            idempotencyKey: input.idempotencyKey,
          },
        });
        if (!validation.valid) {
          this.trace.record({
            type: "tool_call",
            requestId: input.requestId,
            tool: "activate_scene",
            status: "rejected",
            latencyMs: 0,
          });
          const status = validation.reason === "AI_SCOPE_FORBIDDEN" ? 403 : 400;
          throw new AiAgentError(validation.reason, "模型请求的场景不可用或缺少执行条件", status);
        }

        if (input.signal?.aborted) throw new AiAgentError("AI_AGENT_CANCELLED", "请求已取消", 499);
        const toolStartedAt = Date.now();
        const execution = await this.executeScene({
          session: binding.session,
          scene: validation.scene,
          requestId: input.requestId,
        });
        this.trace.record({
          type: "tool_call",
          requestId: input.requestId,
          tool: "activate_scene",
          status: execution.status === "success" ? "success" : "failed",
          latencyMs: Date.now() - toolStartedAt,
        });
        const modelReply = typeof decision.arguments.replyMessage === "string"
          ? sanitizeUserFacingMessage(decision.arguments.replyMessage.trim(), safeScenes)
          : "";
        result = {
          requestId: input.requestId,
          conversationId: input.conversationId,
          message: modelReply || execution.message,
          intent: "activate_scene",
          tool: {
            name: "activate_scene",
            status: execution.status,
            sceneName: validation.scene.name,
          },
          usage: decision.usage,
        };
      }

      await this.store.appendMessage({
        conversationId: scopedId,
        role: "assistant",
        content: result.message,
        metadata: { requestId: input.requestId, intent: result.intent },
      });
      await this.idempotency.complete(
        binding.principalId,
        binding.homeId,
        input.idempotencyKey,
        result,
      );
      return result;
    } catch (error) {
      const response = error instanceof AiAgentError
        ? { code: error.code, message: error.message }
        : { code: "AI_AGENT_UNAVAILABLE", message: "AI 助手暂时不可用" };
      await this.idempotency.fail(
        binding.principalId,
        binding.homeId,
        input.idempotencyKey,
        response,
      );
      throw error;
    }
  }
}
