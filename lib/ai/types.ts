export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type IntentDecision =
  | {
      type: "tool_call";
      tool: "activate_scene";
      arguments: { sceneId: string; replyMessage?: string };
      model: string;
      latencyMs: number;
      llmOutput?: string;
    }
  | {
      type: "no_action";
      reason: "unsupported" | "ambiguous";
      model: string;
      latencyMs: number;
      llmOutput?: string;
    };

export type RawIntentDecision =
  | {
      type: "tool_call";
      tool: string;
      arguments: { sceneId: unknown; replyMessage?: unknown };
      model: string;
      latencyMs: number;
      llmOutput?: string;
    }
  | {
      type: "no_action";
      reason: "unsupported" | "ambiguous";
      model: string;
      latencyMs: number;
      llmOutput?: string;
    };

export type AiCommandResponse = {
  requestId: string;
  conversationId?: string;
  sessionContext?: string;
  /** 当会话达到最大轮数并自动开启新会话时为 true，便于客户端/快捷指令显式感知。 */
  conversationReset?: boolean;
  /** 当前交互在会话中所处的轮数（从 1 开始）。 */
  turnIndex?: number;
  status: "completed" | "partial_success" | "not_understood";
  intent?: "activate_scene" | "none";
  sceneId?: string;
  sceneName?: string;
  message: string;
  execution?: {
    status: "success" | "partial_success";
    succeeded: number;
    failed: number;
  };
  decisionSource?: "llm" | "deterministic_fallback";
  llmOutput?: string;
};

export type SceneExecutionResult = {
  status: "success" | "partial_success";
  succeeded: number;
  failed: number;
  message: string;
};
