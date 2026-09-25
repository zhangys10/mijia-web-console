import type { ManualScene } from "../../xiaomi-scenes.ts";
import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import {
  listRawManualScenes,
  loadSceneActionCapabilities,
  loadSceneDeviceCapabilities,
  manualSceneRevisionMaterial,
  parseManualScenes,
  type XiaomiRequester,
} from "../../xiaomi-scenes.ts";
import { listDevices } from "../../xiaomi-cloud.ts";
import { getMiotCapabilities } from "../../miot-spec.ts";

export type AgentSceneRecord = {
  alias: string;
  sceneId: string;
  homeId: string;
  name: string;
  description: string;
  enabled: boolean;
  actionCount: number;
  revision: string;
  actionSummaries: Array<{ room: string | null; device: string | null; actions: Array<{ label: string; value: string }> }>;
};

export type SafeAgentScene = {
  id: string;
  name: string;
  description: string;
  revision: string;
  actionSummaries: AgentSceneRecord["actionSummaries"];
};

export type AgentSceneSummary = {
  alias: string;
  name: string;
  description: string;
  actionCount: number;
  revision: string;
  actionSummaries: AgentSceneRecord["actionSummaries"];
};


async function sceneRevision(scene: ManualScene) {
  const content = JSON.stringify(manualSceneRevisionMaterial(scene));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `rev_${hex.slice(0, 24)}`;
}

function actionSummaries(scene: ManualScene): AgentSceneRecord["actionSummaries"] {
  return scene.actions.slice(0, 32).map(action => ({
    room: action.room?.slice(0, 200) ?? null,
    device: action.deviceName?.slice(0, 200) ?? null,
    actions: action.details.slice(0, 12).map(({ label, value }) => ({ label: label.slice(0, 80), value: value.slice(0, 80) })),
  }));
}

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
    const revision = await sceneRevision(scene);
    records.push({
      alias: await sceneAlias(input.principalId, input.homeId, scene.id),
      sceneId: scene.id,
      homeId: scene.homeId,
      name: scene.name.slice(0, 200),
      description: `当前家庭的手动场景：${scene.name}`.slice(0, 500),
      enabled: scene.enabled,
      actionCount: scene.actionCount,
      revision,
      actionSummaries: actionSummaries(scene),
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
    deviceRequest?: Parameters<typeof listDevices>[1];
    loadDevices?: typeof listDevices;
    loadCapabilities?: typeof getMiotCapabilities;
  },
): Promise<AgentSceneRecord[]> {
  const rawScenes = await listRawManualScenes(input.session, input.homeId, input.request);
  const deviceList = await (input.loadDevices ?? listDevices)(input.session, input.deviceRequest);
  const sceneCapabilities = await loadSceneActionCapabilities(
    rawScenes,
    input.homeId,
    await loadSceneDeviceCapabilities(deviceList.devices, input.homeId, input.loadCapabilities),
    input.loadCapabilities,
  );
  const scenes = parseManualScenes(
    { result: rawScenes },
    input.homeId,
    deviceList.devices,
    sceneCapabilities,
  );
  return buildAgentSceneCatalog({
    principalId: input.principalId,
    homeId: input.homeId,
    scenes,
  });
}

export function safeScenesForModel(scenes: readonly AgentSceneRecord[]): SafeAgentScene[] {
  return scenes.map(({ alias, name, description, revision, actionSummaries }) => ({
    id: alias,
    name,
    description,
    revision,
    actionSummaries,
  }));
}

export function sceneSummaries(scenes: readonly AgentSceneRecord[]): AgentSceneSummary[] {
  return scenes.map(({ alias, name, description, actionCount, revision, actionSummaries }) => ({
    alias,
    name,
    description,
    actionCount,
    revision,
    actionSummaries,
  }));
}
