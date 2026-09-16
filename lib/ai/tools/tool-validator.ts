import type { AllowedScene } from "../scenes/catalog.ts";

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export function sanitizeUserFacingMessage(
  message: string,
  allowedScenes: readonly { id: string; name: string }[] = [],
): string {
  let result = message;
  for (const scene of allowedScenes) {
    if (scene.id && scene.name) {
      result = result.replaceAll(scene.id, scene.name);
    }
  }
  result = result.replace(/["']?sceneId["']?\s*:\s*["'][^"']+["']/gi, "");
  result = result.replace(/\b\d{15,22}\b/g, "对应场景");
  result = result.replace(/[「“”」"']\s*[「“”」"']/g, "").replace(/\s+/g, " ").trim();
  return result;
}

export function sanitizeLlmOutput(
  llmOutput: string | undefined,
  allowedScenes: readonly { id: string; name: string }[] = [],
): string | undefined {
  if (!llmOutput) return undefined;
  let result = llmOutput;
  for (const scene of allowedScenes) {
    if (scene.id && scene.name) {
      result = result.replaceAll(scene.id, scene.name);
    }
  }
  result = result.replace(/["']?sceneId["']?\s*:\s*["']([^"']+)["']/g, 'scene: "$1"');
  result = result.replace(/\b\d{15,22}\b/g, "对应场景");
  return result;
}

export function validateToolCall(
  call: ToolCall,
  allowedScenes: readonly AllowedScene[] = [],
): { valid: true; sceneId: string; sceneName: string; replyMessage?: string } | { valid: false; reason: string } {
  if (call.name !== "activate_scene") return { valid: false, reason: "UNSUPPORTED_TOOL" };
  const sceneId = call.arguments.sceneId;
  if (typeof sceneId !== "string" || !sceneId) return { valid: false, reason: "UNSUPPORTED_SCENE" };
  const scene = allowedScenes.find(entry => entry.id === sceneId && entry.enabledForAi);
  if (!scene) return { valid: false, reason: "UNSUPPORTED_SCENE" };
  const rawReplyMessage = typeof call.arguments.replyMessage === "string" && call.arguments.replyMessage.trim()
    ? call.arguments.replyMessage.trim()
    : undefined;
  const replyMessage = rawReplyMessage ? sanitizeUserFacingMessage(rawReplyMessage, allowedScenes) : undefined;
  return replyMessage !== undefined
    ? { valid: true, sceneId: scene.id, sceneName: scene.name, replyMessage }
    : { valid: true, sceneId: scene.id, sceneName: scene.name };
}
