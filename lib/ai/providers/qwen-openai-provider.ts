import type { AiCommandConfig } from "../config.ts";
import type { RawIntentDecision } from "../types.ts";

const systemPrompt = `你是家庭控制意图路由器，只能决定是否调用提供的工具。

规则：
1. 仅当用户明确表示已经到家、刚进家门、回来了，或明确要求开启“回家模式”时，调用 activate_scene，sceneId=home。
2. 计划、假设、否定、询问和转述不执行。例如：“我还没回家”“如果我回家”“回家模式是什么”“他说他回家了”。
3. 指令含糊或不在能力范围内时，不调用任何工具。
4. 不推测设备，不生成设备 ID，不解释内部实现。
5. 每个请求最多调用一次工具。`;

const tools = [
  {
    type: "function",
    function: {
      name: "activate_scene",
      description: "当用户明确表示已经回到家或要求开启回家模式时，激活一个已配置的家庭场景。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sceneId: {
            type: "string",
            enum: ["home"],
            description: "场景唯一标识。home 表示回家模式。",
          },
        },
        required: ["sceneId"],
      },
    },
  },
];

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

  async decide(text: string, locale = "zh-CN", timezone = "Asia/Shanghai"): Promise<RawIntentDecision> {
    if (!this.config.apiKey || !this.config.baseUrl) throw new Error("LLM_PROVIDER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          max_tokens: 128,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `text=${text}\nlocale=${locale}\ntimezone=${timezone}\navailableScenes=[{"id":"home","name":"回家模式"}]` },
          ],
          tools,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("LLM_PROVIDER_ERROR");
      const body = await response.json() as { choices?: OpenAiChoice[] };
      const message = body.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];
      if (!toolCall) {
        return { type: "no_action", reason: "unsupported", model: this.config.model, latencyMs: Date.now() - startedAt };
      }
      const argumentsText = toolCall.function?.arguments ?? "{}";
      const argumentsJson = JSON.parse(argumentsText) as Record<string, unknown>;
      return {
        type: "tool_call",
        tool: toolCall.function?.name ?? "unknown",
        arguments: { sceneId: argumentsJson.sceneId },
        model: this.config.model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("LLM_TIMEOUT");
      throw new Error("LLM_PROVIDER_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }
}
