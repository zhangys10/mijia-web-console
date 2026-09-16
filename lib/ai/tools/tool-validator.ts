import { allowedScenes } from "../scenes/catalog.ts";

export type ToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export function validateToolCall(call: ToolCall): { valid: true; sceneId: "home" } | { valid: false; reason: string } {
  if (call.name !== "activate_scene") return { valid: false, reason: "UNSUPPORTED_TOOL" };
  const sceneId = call.arguments.sceneId;
  if (sceneId !== "home") return { valid: false, reason: "UNSUPPORTED_SCENE" };
  if (!allowedScenes.some(scene => scene.id === sceneId && scene.enabledForAi)) {
    return { valid: false, reason: "SCENE_NOT_ENABLED" };
  }
  return { valid: true, sceneId: "home" };
}
