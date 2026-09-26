export function isPreviewEnvironment(env: Record<string, string | undefined>) {
  return env.AI_ENVIRONMENT === "preview";
}

/** Local development stores exposure settings in the filesystem. */
export function isLocalAssistantExposureRuntime(env: Record<string, string | undefined>) {
  return env.AI_ENVIRONMENT === "development";
}
