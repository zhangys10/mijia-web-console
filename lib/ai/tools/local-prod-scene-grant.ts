import type { AgentSceneRecord } from "./agent-scene-catalog.ts";
import { matchSceneActionIntent } from "./scene-action-intent.ts";

export type LocalProdSceneGrant = {
  requestId: string;
  idempotencyKey: string;
  sceneAlias: string;
  revision: string;
  messageHash: string;
  expiresAt: number;
};

export async function createLocalProdSceneGrant(input: {
  message: string;
  requestId: string;
  idempotencyKey: string;
  scenes: readonly AgentSceneRecord[];
  now?: number;
}): Promise<LocalProdSceneGrant> {
  const message = input.message.trim();
  if (!message || message.length > 500) throw new Error("INVALID_SCENE_ACTION_MESSAGE");
  if (!/^req_[A-Za-z0-9_-]{12,124}$/.test(input.requestId)) throw new Error("INVALID_SCENE_ACTION_REQUEST_ID");
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)) throw new Error("INVALID_SCENE_ACTION_IDEMPOTENCY_KEY");
  const scene = matchSceneActionIntent(message, input.scenes);
  if (!scene) throw new Error("SCENE_ACTION_MUST_MATCH_ONE_EXACT_MANUAL_SCENE");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  const messageHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return {
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    sceneAlias: scene.alias,
    revision: scene.revision,
    messageHash,
    expiresAt: (input.now ?? Date.now()) + 60_000,
  };
}
