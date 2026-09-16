export type IntentDecision =
  | {
      type: "tool_call";
      tool: "activate_scene";
      arguments: { sceneId: "home" };
      model: string;
      latencyMs: number;
    }
  | {
      type: "no_action";
      reason: "unsupported" | "ambiguous";
      model: string;
      latencyMs: number;
    };

export type RawIntentDecision =
  | {
      type: "tool_call";
      tool: string;
      arguments: { sceneId: unknown };
      model: string;
      latencyMs: number;
    }
  | {
      type: "no_action";
      reason: "unsupported" | "ambiguous";
      model: string;
      latencyMs: number;
    };

export type AiCommandResponse = {
  requestId: string;
  status: "completed" | "partial_success" | "not_understood";
  intent?: "activate_scene";
  sceneId?: "home";
  message: string;
  execution?: {
    status: "success" | "partial_success";
    succeeded: number;
    failed: number;
  };
  decisionSource?: "llm" | "deterministic_fallback";
};

export type SceneExecutionResult = {
  status: "success" | "partial_success";
  succeeded: number;
  failed: number;
  message: string;
};
