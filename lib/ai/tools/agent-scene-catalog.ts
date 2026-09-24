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
import { classifyDeviceKind } from "../../device-views.ts";
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
  risk: "low" | "blocked";
  actionSummaries: Array<{ room: string | null; device: string | null; actions: Array<{ label: string; value: string }> }>;
};

export type SafeAgentScene = {
  id: string;
  name: string;
  description: string;
  revision: string;
  risk: "low" | "blocked";
  actionSummaries: AgentSceneRecord["actionSummaries"];
};

export type AgentSceneSummary = {
  alias: string;
  name: string;
  description: string;
  actionCount: number;
  revision: string;
  risk: "low" | "blocked";
  actionSummaries: AgentSceneRecord["actionSummaries"];
};

const BLOCKED_ACTION = /lock|camera|doorbell|security|alarm|intercom|gas|access|door/i;
const LOW_RISK_ACTIONS = new Set(["power", "brightness", "color-temperature"]);

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

function safeLowRiskScene(scene: ManualScene, devices: Array<{ name: string; room: string; kind: string }>) {
  if (!scene.actions.length || scene.actions.length > 32 || BLOCKED_ACTION.test(scene.name)) return false;
  return scene.actions.every(action => {
    if (!action.deviceName || BLOCKED_ACTION.test(`${action.label} ${action.deviceName}`)) return false;
    if (!action.details.length || action.details.some(detail => !LOW_RISK_ACTIONS.has(detail.kind))) return false;
    const matches = devices.filter(device => device.name === action.deviceName && device.room === action.room);
    return matches.length === 1 && (matches[0].kind === "light" || matches[0].kind === "switch");
  });
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
    devices?: Array<{ name: string; room: string; kind: string }>;
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
      risk: safeLowRiskScene(scene, input.devices ?? []) ? "low" : "blocked",
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
  const devices = deviceList.devices.flatMap(device => {
    if (String(device.homeId ?? "") !== input.homeId) return [];
    const name = typeof device.name === "string" ? device.name : "";
    const room = typeof device.roomName === "string" ? device.roomName : "";
    const model = typeof device.model === "string" ? device.model : "";
    const logicalType = typeof device.logicalType === "string" ? device.logicalType : "";
    if (!name || !room) return [];
    return [{ name, room, kind: classifyDeviceKind(model, name, logicalType) }];
  });
  return buildAgentSceneCatalog({
    principalId: input.principalId,
    homeId: input.homeId,
    scenes,
    devices,
  });
}

export function safeScenesForModel(scenes: readonly AgentSceneRecord[]): SafeAgentScene[] {
  return scenes.map(({ alias, name, description, revision, risk, actionSummaries }) => ({
    id: alias,
    name,
    description,
    revision,
    risk,
    actionSummaries,
  }));
}

export function sceneSummaries(scenes: readonly AgentSceneRecord[]): AgentSceneSummary[] {
  return scenes.map(({ alias, name, description, actionCount, revision, risk, actionSummaries }) => ({
    alias,
    name,
    description,
    actionCount,
    revision,
    risk,
    actionSummaries,
  }));
}
