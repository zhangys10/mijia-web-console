import type { ManualScene } from "../../xiaomi-scenes.ts";
import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { listManualScenes, type XiaomiRequester } from "../../xiaomi-scenes.ts";

export type AgentSceneRecord = {
  alias: string;
  sceneId: string;
  homeId: string;
  name: string;
  description: string;
  enabled: boolean;
  actionCount: number;
};

export type SafeAgentScene = {
  id: string;
  name: string;
  description: string;
};

export type AgentSceneSummary = {
  alias: string;
  name: string;
  description: string;
  actionCount: number;
};

async function sceneAlias(principalId: string, homeId: string, sceneId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${principalId}:${homeId}:${sceneId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `scene_${hex.slice(0, 16)}`;
}

export async function buildAgentSceneCatalog(
  input: {
    principalId: string;
    homeId: string;
    scenes: readonly ManualScene[];
  },
): Promise<AgentSceneRecord[]> {
  const records: AgentSceneRecord[] = [];
  for (const scene of input.scenes) {
    if (scene.homeId !== input.homeId || !scene.enabled) continue;
    records.push({
      alias: await sceneAlias(input.principalId, input.homeId, scene.id),
      sceneId: scene.id,
      homeId: scene.homeId,
      name: scene.name,
      description: `当前家庭的手动场景：${scene.name}`,
      enabled: scene.enabled,
      actionCount: scene.actionCount,
    });
  }
  return records;
}

export async function loadAgentScenes(
  input: {
    principalId: string;
    homeId: string;
    session: XiaomiSession;
    request?: XiaomiRequester;
  },
): Promise<AgentSceneRecord[]> {
  const scenes = await listManualScenes(input.session, input.homeId, input.request);
  return buildAgentSceneCatalog({
    principalId: input.principalId,
    homeId: input.homeId,
    scenes,
  });
}

export function safeScenesForModel(scenes: readonly AgentSceneRecord[]): SafeAgentScene[] {
  return scenes.map(({ alias, name, description }) => ({
    id: alias,
    name,
    description,
  }));
}

export function sceneSummaries(scenes: readonly AgentSceneRecord[]): AgentSceneSummary[] {
  return scenes.map(({ alias, name, description, actionCount }) => ({
    alias,
    name,
    description,
    actionCount,
  }));
}
