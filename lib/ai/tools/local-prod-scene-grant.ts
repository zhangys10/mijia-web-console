import type { AgentSceneRecord } from "./agent-scene-catalog.ts";
import type { ControllableDevice } from "./device-operation-catalog.ts";
import { matchDeviceActionIntent } from "./device-action-intent.ts";
import { matchSceneActionIntent } from "./scene-action-intent.ts";

export type LocalProdSceneGrant = {
  kind: "scene";
  requestId: string;
  idempotencyKey: string;
  sceneAlias: string;
  revision: string;
  messageHash: string;
  expiresAt: number;
};

export type LocalProdDeviceGrant = {
  kind: "device_property";
  requestId: string;
  idempotencyKey: string;
  deviceId: string;
  operationId: string;
  revision: string;
  value: boolean | number | string;
  messageHash: string;
  expiresAt: number;
};

function validateRequest(message: string, requestId: string, idempotencyKey: string) {
  if (!message || message.length > 500) throw new Error("INVALID_ACTION_MESSAGE");
  if (!/^req_[A-Za-z0-9_-]{12,124}$/.test(requestId)) throw new Error("INVALID_ACTION_REQUEST_ID");
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new Error("INVALID_ACTION_IDEMPOTENCY_KEY");
}

async function messageHash(message: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createLocalProdSceneGrant(input: {
  message: string;
  requestId: string;
  idempotencyKey: string;
  scenes: readonly AgentSceneRecord[];
  now?: number;
}): Promise<LocalProdSceneGrant> {
  const message = input.message.trim();
  validateRequest(message, input.requestId, input.idempotencyKey);
  const scene = matchSceneActionIntent(message, input.scenes);
  if (!scene) throw new Error("SCENE_ACTION_MUST_MATCH_ONE_EXACT_MANUAL_SCENE");
  return {
    kind: "scene",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    sceneAlias: scene.alias,
    revision: scene.revision,
    messageHash: await messageHash(message),
    expiresAt: (input.now ?? Date.now()) + 60_000,
  };
}

export async function createLocalProdDeviceGrant(input: {
  message: string;
  requestId: string;
  idempotencyKey: string;
  devices: readonly ControllableDevice[];
  now?: number;
}): Promise<LocalProdDeviceGrant> {
  const message = input.message.trim();
  validateRequest(message, input.requestId, input.idempotencyKey);
  const selected = matchDeviceActionIntent(message, input.devices);
  if (!selected) throw new Error("DEVICE_ACTION_MUST_MATCH_ONE_EXACT_SAFE_OPERATION");
  return {
    kind: "device_property",
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    deviceId: selected.device.deviceId,
    operationId: selected.operation.operationId,
    revision: selected.operation.revision,
    value: selected.value,
    messageHash: await messageHash(message),
    expiresAt: (input.now ?? Date.now()) + 60_000,
  };
}
