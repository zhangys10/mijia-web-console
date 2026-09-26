export function isPreviewEnvironment(env: Record<string, string | undefined>) {
  return env.AI_PREVIEW_MODE === "true" || env.VERCEL_ENV === "preview";
}

/** Local Next/Vite development stores exposure settings in the filesystem. */
export function isLocalAssistantExposureRuntime(env: Record<string, string | undefined>) {
  return env.NODE_ENV === "development" && !isPreviewEnvironment(env);
}
