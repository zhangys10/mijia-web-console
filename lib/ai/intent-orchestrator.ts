import type { AiCommandConfig } from "./config.ts";
import { isDeterministicFallback } from "./fallback.ts";
import type { QwenOpenAiCompatibleProvider } from "./providers/qwen-openai-provider.ts";
import type { IntentDecision, RawIntentDecision } from "./types.ts";
import { validateToolCall } from "./tools/tool-validator.ts";

export class IntentOrchestrator {
  private readonly provider: QwenOpenAiCompatibleProvider;
  private readonly config: AiCommandConfig;

  constructor(
    provider: QwenOpenAiCompatibleProvider,
    config: AiCommandConfig,
  ) {
    this.provider = provider;
    this.config = config;
  }

  async decide(text: string, locale: string, timezone: string): Promise<IntentDecision> {
    let rawDecision: RawIntentDecision;
    try {
      rawDecision = await this.provider.decide(text, locale, timezone);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      if (this.config.deterministicFallback && isDeterministicFallback(text)) {
        return {
          type: "tool_call",
          tool: "activate_scene",
          arguments: { sceneId: "home" },
          model: "deterministic_fallback",
          latencyMs: 0,
        };
      }
      throw new Error(message);
    }
    if (rawDecision.type === "tool_call") {
      const validation = validateToolCall({ name: rawDecision.tool, arguments: rawDecision.arguments });
      if (!validation.valid) throw new Error("UNSUPPORTED_INTENT");
      return {
        type: "tool_call",
        tool: "activate_scene",
        arguments: { sceneId: validation.sceneId },
        model: rawDecision.model,
        latencyMs: rawDecision.latencyMs,
      };
    }
    return rawDecision;
  }
}
