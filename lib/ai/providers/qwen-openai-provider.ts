import type { AiCommandConfig } from "../config.ts";
import type { AllowedScene } from "../scenes/catalog.ts";
import type { ChatMessage, RawIntentDecision } from "../types.ts";

export type ResolvedProviderCredential = {
  provider: string;
  apiToken: string;
  baseUrl: string;
  model: string;
};

const systemPrompt = `你是家庭控制意图路由器，你的核心职责是识别用户想要执行的家庭场景并调用工具。

【核心规则】
1. 当用户表达要开启、激活、执行、运行、切换到某个场景（例如“打开明亮模式”、“切换到离家”、“回家了”），或者在多轮对话中指代具体场景时，你【必须且只能】调用 activate_scene 工具！
2. 绝对禁止在纯文本回复中声称或假装“已经打开/已经开启/已为您执行”了某个场景！纯文本回复没有任何执行能力，声称已执行但未调用工具是严重故障！
3. availableScenes 列出了当前家庭所有可用场景及其 ID 和名称。调用 activate_scene 时，sceneId 必须严格取自 availableScenes 中的 id；replyMessage 为向用户反馈的自然口语（如“好的，已开启明亮模式”），且 replyMessage 中严禁出现任何纯数字场景 ID！
4. 否定、假设、询问等意图不执行。例如“我还没回家”、“不要开明亮模式”、“明亮模式是什么”。
5. 只有当指令完全与场景无关、指令含糊不清无法确认场景、或者用户在闲聊/提问时，才不要调用工具，直接输出简短文本答复引导用户。
6. 结合上下文历史理解用户的代词指代（例如“那离家呢”、“帮我打开它”、“换成那个”）或后续澄清（例如上一轮询问场景，这一轮回复具体模式名），在明确意图后调用 activate_scene。
7. 每个请求最多调用一次工具。
8. 严禁在任何文本或回复中向用户透露、引用或输出任何纯数字场景 ID 代码，回复中只能使用场景的自然中文显示名称。
9. 禁止输出任何思考过程或思维链，只能调用工具或输出简短答复。`;

type SceneProjection = Pick<AllowedScene, "id" | "name" | "description">;

function tools(scenes: readonly SceneProjection[]) {
  const sceneIds = scenes.map((scene) => scene.id);
  return [
    {
      type: "function",
      function: {
        name: "activate_scene",
        description:
          "激活一个已配置且可用的家庭手动场景（如回家模式、明亮模式、离家模式、观影模式、睡眠模式等）。当用户想要开启或切换到某个场景时必须调用此工具。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            sceneId: {
              type: "string",
              enum: sceneIds,
              description: "从 availableScenes 中选择最贴合用户意图的场景 ID。",
            },
            replyMessage: {
              type: "string",
              description:
                "执行该场景后向用户回复的一句自然口语表达（不超过25字）。严禁包含任何数字ID或代码，只能使用自然的场景中文名称。例如离家时说“好的，已开启离家模式，路上注意安全”；回家时说“欢迎回家，已为您打开回家模式”；明亮时说“好的，已为您开启明亮模式”。",
            },
          },
          required: ["sceneId", "replyMessage"],
        },
      },
    },
  ];
}

type OpenAiChoice = {
  message?: {
    tool_calls?: Array<{
      function?: {
        name?: string;
        arguments?: string;
      };
    }>;
    content?: string;
  };
};

export class QwenOpenAiCompatibleProvider {
  private readonly config: AiCommandConfig;

  constructor(config: AiCommandConfig) {
    this.config = config;
  }

  async decide(
    text: string,
    allowedScenes: readonly SceneProjection[],
    locale = "zh-CN",
    timezone = "Asia/Shanghai",
    history?: readonly ChatMessage[],
    credential?: ResolvedProviderCredential,
  ): Promise<RawIntentDecision> {
    const apiKey = credential?.apiToken;
    const baseUrl = credential?.baseUrl;
    const model = credential?.model;

    if (!apiKey || !baseUrl || !model) {
      throw new Error("LLM_CREDENTIAL_NOT_CONFIGURED");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();
    try {
      const historyMessages = Array.isArray(history)
        ? history
            .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
            .map((item) => ({ role: item.role, content: item.content }))
        : [];

      const currentTurnMessage = {
        role: "user" as const,
        content: JSON.stringify({
          text,
          locale,
          timezone,
          availableScenes: allowedScenes.map((scene) => ({
            id: scene.id,
            name: scene.name,
            description: scene.description,
          })),
        }),
      };

      const messages = [
        { role: "system" as const, content: systemPrompt },
        ...historyMessages,
        currentTurnMessage,
      ];

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: this.config.maxOutputTokens ?? 128,
          enable_thinking: this.config.enableThinking ?? false,
          messages,
          tools: tools(allowedScenes),
          tool_choice: "auto",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("LLM_CREDENTIAL_INVALID");
        }
        const errText = await response.text().catch(() => "");
        console.error("Qwen API HTTP error:", response.status, response.statusText, errText);
        throw new Error(`LLM_HTTP_${response.status}: ${errText || response.statusText}`);
      }

      const body = (await response.json()) as { choices?: OpenAiChoice[] };
      const message = body.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];
      const textContent = message?.content ? String(message.content).trim() : undefined;
      if (!toolCall) {
        return {
          type: "no_action",
          reason: "unsupported",
          model,
          latencyMs: Date.now() - startedAt,
          llmOutput: textContent,
        };
      }

      const argumentsText = toolCall.function?.arguments ?? "{}";
      const argumentsJson = JSON.parse(argumentsText) as Record<string, unknown>;
      const sceneObj = allowedScenes.find((s) => s.id === argumentsJson.sceneId);
      const sceneDisplayName = sceneObj?.name ?? "指定场景";
      const cleanLlmOutput = textContent || `call ${toolCall.function?.name}(scene: "${sceneDisplayName}")`;

      return {
        type: "tool_call",
        tool: toolCall.function?.name ?? "unknown",
        arguments: { sceneId: argumentsJson.sceneId, replyMessage: argumentsJson.replyMessage },
        model,
        latencyMs: Date.now() - startedAt,
        llmOutput: cleanLlmOutput,
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError" || error.message.toLowerCase().includes("timeout")) {
          throw new Error("LLM_TIMEOUT");
        }
        if (error.message === "LLM_CREDENTIAL_INVALID" || error.message === "LLM_CREDENTIAL_NOT_CONFIGURED") {
          throw error;
        }
      }
      console.error("Qwen Provider Request Failed:", error instanceof Error ? error.message : error);
      const msg = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
}
