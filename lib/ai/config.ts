export function isPreviewEnvironment(env: Record<string, string | undefined>) {
  return env.AI_ENVIRONMENT === "preview";
}

/** Use filesystem storage only for explicitly local or unconfigured Node dev. */
export function isLocalAssistantExposureRuntime(env: Record<string, string | undefined>) {
  const environment = env.AI_ENVIRONMENT?.trim();
  if (environment) return environment === "development";
  return env.NODE_ENV === "development";
}
