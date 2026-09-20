const DEFAULT_LLM_MODEL = "qwen3.7-flash-2026-07-15";
const DEFAULT_LLM_TIMEOUT_MS = 3000;
const DEFAULT_CONVERSATION_MAX_TURNS = 5;
const MAX_CONVERSATION_TURNS_LIMIT = 20;

export function isPreviewEnvironment(env: Record<string, string | undefined>) {
  return env.AI_ENVIRONMENT === "preview";
}

export type AiCommandConfig = {
  enabled: boolean;
  authHash: string;
  session: string;
  homeId: string;
  sceneId: string;
  provider: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  deterministicFallback: boolean;
  enableThinking: boolean;
  maxOutputTokens: number;
  /** 单次会话保留的最大问答轮数（一轮 = 1 条 user + 1 条 assistant）。 */
  conversationMaxTurns: number;
  automationTokenSecret: string;
  automationTokenKeyId: string;
};

function positiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function bool(value: string | undefined, fallback: boolean) {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function loadAiCommandConfig(env: NodeJS.ProcessEnv = process.env): AiCommandConfig {
  return {
    enabled: bool(env.AI_COMMAND_ENABLED, false),
    authHash: env.AI_COMMAND_AUTH_TOKEN_HASH ?? "",
    session: env.XIAOMI_AI_SESSION ?? "",
    homeId: env.AI_SCENE_HOME_ID ?? "",
    sceneId: env.AI_SCENE_HOME_SCENE_ID ?? "",
    provider: env.LLM_PROVIDER ?? env.LLM_DEFAULT_PROVIDER ?? "qwen-cn",
    baseUrl: env.LLM_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: env.LLM_MODEL ?? env.LLM_DEFAULT_MODEL ?? DEFAULT_LLM_MODEL,
    timeoutMs: Number.parseInt(env.LLM_TIMEOUT_MS ?? `${DEFAULT_LLM_TIMEOUT_MS}`, 10),
    deterministicFallback: bool(env.AI_DETERMINISTIC_FALLBACK, true),
    enableThinking: bool(env.LLM_ENABLE_THINKING, false),
    maxOutputTokens: Number.parseInt(env.LLM_MAX_OUTPUT_TOKENS ?? "128", 10),
    conversationMaxTurns: positiveInt(env.AI_CONVERSATION_MAX_TURNS, DEFAULT_CONVERSATION_MAX_TURNS, MAX_CONVERSATION_TURNS_LIMIT),
    automationTokenSecret: env.AI_AUTOMATION_TOKEN_SECRET ?? "",
    automationTokenKeyId: env.AI_AUTOMATION_TOKEN_KEY_ID ?? "key-2026-01",
  };
}
