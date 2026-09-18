import type { AiGatewayConfig } from "../config.ts";
import type { AllowedScene } from "../scenes/catalog.ts";
import type { ChatMessage, ModelUsage, RawIntentDecision } from "../types.ts";

type SceneProjection = Pick<AllowedScene, "id" | "name" | "description">;

type OpenAiResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: {
          arguments?: string;
          name?: string;
        };
      }>;
    };
  }>;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

export type MakersGatewayErrorCode =
  | "AI_GATEWAY_MODEL_NOT_ALLOWED"
  | "AI_GATEWAY_AUTH_FAILED"
  | "AI_GATEWAY_RATE_LIMITED"
  | "AI_GATEWAY_REQUEST_REJECTED"
  | "AI_GATEWAY_TIMEOUT"
  | "AI_GATEWAY_CANCELLED"
  | "AI_GATEWAY_UNAVAILABLE"
  | "AI_GATEWAY_RESPONSE_INVALID";

export class MakersGatewayError extends Error {
  readonly code: MakersGatewayErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: MakersGatewayErrorCode, options?: { retryAfterSeconds?: number }) {
    super(code);
    this.name = "MakersGatewayError";
    this.code = code;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

const systemPrompt = `你是家庭控制意图路由器。只有在用户明确要求执行当前家庭的已审核场景时，才能调用 activate_scene。
否定、假设、询问、转述或含糊意图不得执行。禁止声称执行了未调用的工具，禁止输出思考过程。`;

function gatewayTools(scenes: readonly SceneProjection[]) {
  return [
    {
      type: "function",
      function: {
        name: "list_scenes",
        description: "列出当前家庭允许 AI 使用的已审核场景摘要。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "activate_scene",
        description: "激活当前家庭中一个已审核且可用的手动场景。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            sceneId: {
              type: "string",
              enum: scenes.map((scene) => scene.id),
            },
            replyMessage: {
              type: "string",
              maxLength: 50,
            },
          },
          required: ["sceneId", "replyMessage"],
        },
      },
    },
  ];
}

function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return Math.max(1, new TextEncoder().encode(text).byteLength);
}

function parseUsage(body: OpenAiResponse, requestBody: unknown, responseText: string): ModelUsage {
  const promptTokens = body.usage?.prompt_tokens;
  const completionTokens = body.usage?.completion_tokens;
  const totalTokens = body.usage?.total_tokens;
  if (
    typeof promptTokens === "number"
    && typeof completionTokens === "number"
    && typeof totalTokens === "number"
    && Number.isSafeInteger(promptTokens)
    && Number.isSafeInteger(completionTokens)
    && Number.isSafeInteger(totalTokens)
    && promptTokens >= 0
    && completionTokens >= 0
    && totalTokens >= 0
  ) {
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      estimated: false,
    };
  }

  const estimatedPromptTokens = estimateTokens(requestBody);
  const estimatedCompletionTokens = estimateTokens(responseText);
  return {
    promptTokens: estimatedPromptTokens,
    completionTokens: estimatedCompletionTokens,
    totalTokens: estimatedPromptTokens + estimatedCompletionTokens,
    estimated: true,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (/^\d+$/.test(value) && Number.isSafeInteger(seconds)) return seconds;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

export class MakersGatewayProvider {
  private readonly config: AiGatewayConfig;

  constructor(config: AiGatewayConfig) {
    this.config = config;
  }

  async decide(
    text: string,
    allowedScenes: readonly SceneProjection[],
    locale = "zh-CN",
    timezone = "Asia/Shanghai",
    history?: readonly ChatMessage[],
    externalSignal?: AbortSignal,
  ): Promise<RawIntentDecision> {
    const { apiKey, baseUrl, model } = this.config;
    if (!this.config.allowedModels.includes(model)) {
      throw new MakersGatewayError("AI_GATEWAY_MODEL_NOT_ALLOWED");
    }

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...(history ?? [])
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({ role: item.role, content: item.content })),
      {
        role: "user" as const,
        content: JSON.stringify({
          text,
          locale,
          timezone,
          availableScenes: allowedScenes.map(({ id, name, description }) => ({ id, name, description })),
        }),
      },
    ];
    const requestBody = {
      model,
      temperature: 0,
      max_tokens: this.config.maxOutputTokens,
      enable_thinking: this.config.enableThinking,
      messages,
      tools: gatewayTools(allowedScenes),
      tool_choice: "auto",
    };

    const controller = new AbortController();
    let cancelled = externalSignal?.aborted ?? false;
    if (cancelled) throw new MakersGatewayError("AI_GATEWAY_CANCELLED");
    const abortFromExternal = () => {
      cancelled = true;
      controller.abort();
    };
    externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new MakersGatewayError("AI_GATEWAY_AUTH_FAILED");
        }
        if (response.status === 429) {
          throw new MakersGatewayError("AI_GATEWAY_RATE_LIMITED", {
            retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
          });
        }
        if (response.status >= 400 && response.status < 500) {
          throw new MakersGatewayError("AI_GATEWAY_REQUEST_REJECTED");
        }
        throw new MakersGatewayError("AI_GATEWAY_UNAVAILABLE");
      }

      let body: OpenAiResponse;
      try {
        body = (await response.json()) as OpenAiResponse;
      } catch {
        throw new MakersGatewayError("AI_GATEWAY_RESPONSE_INVALID");
      }

      const message = body.choices?.[0]?.message;
      if (!message) {
        throw new MakersGatewayError("AI_GATEWAY_RESPONSE_INVALID");
      }
      const textContent = typeof message.content === "string" ? message.content.trim() : "";
      const usage = parseUsage(body, requestBody, textContent);
      const toolCall = message.tool_calls?.[0];
      if (!toolCall) {
        return {
          type: "no_action",
          reason: "unsupported",
          model,
          latencyMs: Date.now() - startedAt,
          llmOutput: textContent || undefined,
          usage,
        };
      }

      let argumentsJson: Record<string, unknown>;
      try {
        argumentsJson = JSON.parse(toolCall.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        throw new MakersGatewayError("AI_GATEWAY_RESPONSE_INVALID");
      }

      return {
        type: "tool_call",
        tool: toolCall.function?.name ?? "unknown",
        arguments: {
          sceneId: argumentsJson.sceneId,
          replyMessage: argumentsJson.replyMessage,
        },
        model,
        latencyMs: Date.now() - startedAt,
        llmOutput: textContent || undefined,
        usage,
      };
    } catch (error) {
      if (error instanceof MakersGatewayError) throw error;
      if (error instanceof Error && error.name === "AbortError" && cancelled) {
        throw new MakersGatewayError("AI_GATEWAY_CANCELLED");
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new MakersGatewayError("AI_GATEWAY_TIMEOUT");
      }
      throw new MakersGatewayError("AI_GATEWAY_UNAVAILABLE");
    } finally {
      externalSignal?.removeEventListener("abort", abortFromExternal);
      clearTimeout(timer);
    }
  }
}
