import type { AiCommandConfig } from "./config.ts";
import { findFallbackScene, recoverIntentFromTextOrLlmOutput } from "./fallback.ts";
import type { QwenOpenAiCompatibleProvider } from "./providers/qwen-openai-provider.ts";
import type { AllowedScene } from "./scenes/catalog.ts";
import { runtimeScenes } from "./scenes/catalog.ts";
import type { ChatMessage, IntentDecision, RawIntentDecision } from "./types.ts";
import { sanitizeLlmOutput, validateToolCall } from "./tools/tool-validator.ts";

export class IntentOrchestrator {
  private readonly provider: QwenOpenAiCompatibleProvider;
  private readonly config: AiCommandConfig;

  constructor(provider: QwenOpenAiCompatibleProvider, config: AiCommandConfig) {
    this.provider = provider;
    this.config = config;
  }

  async decide(
    text: string,
    scenes: readonly AllowedScene[],
    locale: string,
    timezone: string,
    history?: readonly ChatMessage[],
  ): Promise<IntentDecision> {
    let rawDecision: RawIntentDecision;
    try {
      rawDecision = await this.provider.decide(text, scenes, locale, timezone, history);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LLM_PROVIDER_ERROR";
      if (this.config.deterministicFallback) {
        const fallbackScene = findFallbackScene(text, scenes);
        if (fallbackScene) {
          const isHome = /回家|到家|进门/.test(fallbackScene.name);
          return {
            type: "tool_call",
            tool: "activate_scene",
            arguments: {
              sceneId: fallbackScene.id,
              replyMessage: isHome ? "欢迎回家，已经开启回家模式。" : ("已经开启「" + fallbackScene.name + "」。"),
            },
            model: "deterministic_fallback",
            latencyMs: 0,
            llmOutput: "fallback to scene: " + fallbackScene.name,
          };
        }
      }
      throw new Error(message);
    }

    if (rawDecision.type === "tool_call") {
      const validation = validateToolCall({ name: rawDecision.tool, arguments: rawDecision.arguments }, scenes);
      if (!validation.valid) throw new Error("UNSUPPORTED_INTENT");
      return {
        type: "tool_call",
        tool: "activate_scene",
        arguments: validation.replyMessage !== undefined
          ? { sceneId: validation.sceneId, replyMessage: validation.replyMessage }
          : { sceneId: validation.sceneId },
        model: rawDecision.model,
        latencyMs: rawDecision.latencyMs,
        llmOutput: sanitizeLlmOutput(rawDecision.llmOutput, scenes),
      };
    }

    // LLM 未返回工具调用时，先尝试从文本或用户输入中兜底恢复明确的场景意图，
    // 避免模型“口头声称已执行”但实际未调用工具（intent 仍为 none）的假执行漏洞。
    const recovered = recoverIntentFromTextOrLlmOutput(text, rawDecision.llmOutput, scenes);
    if (recovered) {
      console.warn("[intent-orchestrator] Recovered scene intent from text output:", {
        sceneId: recovered.scene.id,
        sceneName: recovered.scene.name,
        llmOutput: rawDecision.llmOutput,
      });
      return {
        type: "tool_call",
        tool: "activate_scene",
        arguments: {
          sceneId: recovered.scene.id,
          replyMessage: recovered.replyMessage,
        },
        model: rawDecision.model,
        latencyMs: rawDecision.latencyMs,
        llmOutput: rawDecision.llmOutput
          ? sanitizeLlmOutput(rawDecision.llmOutput, scenes)
          : `recovered: activate_scene(scene: "${recovered.scene.name}")`,
      };
    }

    return {
      ...rawDecision,
      llmOutput: sanitizeLlmOutput(rawDecision.llmOutput, scenes),
    };
  }
}

export { runtimeScenes };
