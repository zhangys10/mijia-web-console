export function isPreviewEnvironment(env: Record<string, string | undefined>) {
  return env.AI_ENVIRONMENT === "preview";
}
