import type { AgentSceneRecord } from "./agent-scene-catalog.ts";
import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { runManualScene, xiaomiRequest, type XiaomiRequester } from "../../xiaomi-scenes.ts";
import type { SceneExecutionResult } from "../types.ts";

export type ActivateSceneContext = {
  principalId: string;
  homeId: string;
  scopes: readonly string[];
  idempotencyKey: string;
};

export function validateActivateSceneCall(input: {
  tool: string;
  alias: unknown;
  scenes: readonly AgentSceneRecord[];
  context: ActivateSceneContext;
}): { valid: true; scene: AgentSceneRecord } | { valid: false; reason: string } {
  if (input.tool !== "activate_scene") return { valid: false, reason: "UNSUPPORTED_TOOL" };
  if (!input.context.scopes.includes("scene:activate")) return { valid: false, reason: "AI_SCOPE_FORBIDDEN" };
  if (typeof input.alias !== "string" || !input.alias) return { valid: false, reason: "AI_INVALID_SCENE" };
  if (input.context.idempotencyKey.length < 16 || input.context.idempotencyKey.length > 128) {
    return { valid: false, reason: "AI_IDEMPOTENCY_KEY_REQUIRED" };
  }

  const scene = input.scenes.find((item) => item.alias === input.alias);
  if (
    !scene
    || scene.homeId !== input.context.homeId
    || scene.reviewStatus !== "approved"
    || scene.riskLevel !== "low"
    || !scene.enabled
  ) {
    return { valid: false, reason: "AI_SCENE_NOT_FOUND" };
  }
  return { valid: true, scene };
}

export async function activateScene(input: {
  session: XiaomiSession;
  scene: AgentSceneRecord;
  requestId: string;
  request?: XiaomiRequester;
}): Promise<SceneExecutionResult> {
  try {
    await runManualScene(input.session, input.scene.sceneId, input.request ?? xiaomiRequest);
    return {
      status: "success",
      succeeded: 1,
      failed: 0,
      message: `已开启「${input.scene.name}」。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI_SCENE_FAILED";
    if (message.includes("TIMEOUT") || message.includes("timeout")) {
      return {
        status: "partial_success",
        succeeded: 0,
        failed: 1,
        message: "场景执行超时，请稍后确认。",
      };
    }
    return {
      status: "partial_success",
      succeeded: 0,
      failed: 1,
      message: "场景执行失败，请稍后重试。",
    };
  }
}
