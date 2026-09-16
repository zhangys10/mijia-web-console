const DEFAULT_LLM_MODEL = "qwen3.7-flash-2026-07-15";
const DEFAULT_LLM_TIMEOUT_MS = 3000;

export type AiCommandConfig = {
  enabled: boolean;
  authHash: string;
  session: string;
  homeId: string;
  sceneId: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  deterministicFallback: boolean;
};

function bool(value: string | undefined, fallback: boolean) {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function loadAiCommandConfig(env: NodeJS.ProcessEnv = process.env): AiCommandConfig {
  return {
    enabled: bool(env.AI_COMMAND_ENABLED, true),
    authHash: env.AI_COMMAND_AUTH_TOKEN_HASH ?? "",
    session: env.XIAOMI_AI_SESSION ?? "",
    homeId: env.AI_SCENE_HOME_ID ?? "",
    sceneId: env.AI_SCENE_HOME_SCENE_ID ?? "",
    provider: env.LLM_PROVIDER ?? "qwen",
    baseUrl: env.LLM_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    timeoutMs: Number.parseInt(env.LLM_TIMEOUT_MS ?? `${DEFAULT_LLM_TIMEOUT_MS}`, 10),
    deterministicFallback: bool(env.AI_DETERMINISTIC_FALLBACK, true),
  };
}
