import { getStore } from "@edgeone/pages-blob";
import type { XiaomiSession } from "../../xiaomi-cloud.ts";
import { listDevices, listHomes } from "../../xiaomi-cloud.ts";
import { collectHomeEnvironment, type EnvironmentMetric, type EnvironmentSnapshot } from "../../home-environment.ts";
import { classifyDeviceKind } from "../../device-views.ts";
import { loadAgentScenes } from "./agent-scene-catalog.ts";
import { collectDeviceStatus, type DeviceStatus } from "../../device-status.ts";

export const HOME_METRICS: EnvironmentMetric[] = [
  "temperature", "humidity", "co2", "formaldehyde", "pm25", "pm10", "tvoc", "pressure", "battery",
];

export type AssistantExposure = {
  version: 1;
  enabled: boolean;
  sceneActionsEnabled: boolean;
  roomMetrics: Record<string, EnvironmentMetric[]>;
  deviceDids: string[];
  sceneApprovals: Record<string, string>;
  updatedAt: string | null;
  revision: string;
};

export type ExposureInventory = {
  rooms: string[];
  metrics: EnvironmentMetric[];
  roomMetrics: Record<string, EnvironmentMetric[]>;
  devices: Array<{ ref: string; name: string; room: string; kind: string; enabled: boolean; eligible: boolean }>;
  scenes: Array<{ ref: string; name: string; actionCount: number; risk: "low" | "blocked"; approvalStatus: "approved" | "changed" | "pending" | "blocked"; enabled: boolean; revision: string; actionSummaries: Array<{ room: string | null; device: string | null; actions: Array<{ label: string; value: string }> }> }>;
};

type ExposureReaders = {
  homes?: typeof listHomes;
  devices?: typeof listDevices;
  environment?: typeof collectHomeEnvironment;
  deviceStatus?: typeof collectDeviceStatus;
  sceneCatalog?: typeof loadAgentScenes;
};

export type AssistantExposureStore = {
  get(key: string, options?: { type?: "json"; consistency?: "strong" | "eventual" }): Promise<unknown>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
};

type AssistantExposureAuditRecord = {
  version: 1;
  changedAt: string;
  actorPrincipalId: string;
  previousRevision: string;
  revision: string;
  enabled: boolean;
  roomMetrics: Record<string, EnvironmentMetric[]>;
  exposedDeviceCount: number;
  exposedSceneCount: number;
  sceneActionsEnabled: boolean;
};

export class AssistantExposureError extends Error {
  readonly code: "AI_HOME_NOT_FOUND" | "AI_EXPOSURE_STORE_UNAVAILABLE" | "AI_INVALID_REQUEST";
  readonly status: number;

  constructor(code: "AI_HOME_NOT_FOUND" | "AI_EXPOSURE_STORE_UNAVAILABLE" | "AI_INVALID_REQUEST", status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

type ExposureEnvironment = Record<string, string | undefined>;

function blobStore(runtimeEnv?: ExposureEnvironment): AssistantExposureStore {
  const env = runtimeEnv ?? {};
  const name = env.AI_ASSISTANT_EXPOSURE_STORE?.trim() || "mijia-ai-assistant-exposure-v1";
  const projectId = env.PAGES_PROJECT_ID?.trim();
  const token = env.PAGES_BLOB_API_TOKEN?.trim();
  if (projectId && token) {
    return getStore({ name, projectId, token }) as AssistantExposureStore;
  }
  return getStore(name) as AssistantExposureStore;
}

async function homeKey(homeId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(homeId));
  const hex = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  return `homes/${hex}.json`;
}

function emptyExposure(): AssistantExposure {
  return { version: 1, enabled: false, sceneActionsEnabled: false, roomMetrics: {}, deviceDids: [], sceneApprovals: {}, updatedAt: null, revision: "exp_default_deny" };
}

export async function readAssistantExposure(homeId: string, store?: AssistantExposureStore, env?: ExposureEnvironment): Promise<AssistantExposure> {
  try {
    const value = await (store ?? blobStore(env)).get(await homeKey(homeId), { type: "json", consistency: "strong" });
    if (value === null) return emptyExposure();
    if (!value || typeof value !== "object") throw new Error("invalid exposure");
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.enabled !== "boolean" || (record.sceneActionsEnabled !== undefined && typeof record.sceneActionsEnabled !== "boolean") || !record.roomMetrics || typeof record.roomMetrics !== "object" || !Array.isArray(record.deviceDids) || (record.sceneApprovals !== undefined && (!record.sceneApprovals || typeof record.sceneApprovals !== "object" || Array.isArray(record.sceneApprovals))) || typeof record.revision !== "string") throw new Error("invalid exposure");
    const roomMetrics: Record<string, EnvironmentMetric[]> = {};
    for (const [room, metrics] of Object.entries(record.roomMetrics)) {
      if (typeof room !== "string" || !Array.isArray(metrics) || metrics.some(metric => !HOME_METRICS.includes(metric as EnvironmentMetric))) throw new Error("invalid exposure");
      roomMetrics[room] = [...new Set(metrics as EnvironmentMetric[])];
    }
    if (record.deviceDids.some(did => typeof did !== "string" || !did || did.length > 128)) throw new Error("invalid exposure");
    const rawApprovals = (record.sceneApprovals ?? {}) as Record<string, unknown>;
    const sceneApprovals: Record<string, string> = {};
    for (const [id, revision] of Object.entries(rawApprovals)) {
      if (!id || id.length > 128 || typeof revision !== "string" || !/^rev_[a-f0-9]{24}$/.test(revision)) throw new Error("invalid exposure");
      sceneApprovals[id] = revision;
    }
    return {
      version: 1,
      enabled: record.enabled,
      sceneActionsEnabled: record.sceneActionsEnabled === true,
      roomMetrics,
      deviceDids: [...new Set(record.deviceDids as string[])],
      sceneApprovals,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
      revision: record.revision,
    };
  } catch (error) {
    if (error instanceof AssistantExposureError) throw error;
    throw new AssistantExposureError("AI_EXPOSURE_STORE_UNAVAILABLE", 503);
  }
}

async function exposureRevision(value: Pick<AssistantExposure, "enabled" | "sceneActionsEnabled" | "roomMetrics" | "deviceDids" | "sceneApprovals">) {
  const canonical = JSON.stringify({ enabled: value.enabled, sceneActionsEnabled: value.sceneActionsEnabled, roomMetrics: value.roomMetrics, deviceDids: value.deviceDids, sceneApprovals: value.sceneApprovals });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `exp_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

async function sceneExposureRef(homeId: string, sceneId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${homeId}:${sceneId}`));
  return `scene_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)}`;
}

export async function saveAssistantExposure(homeId: string, input: unknown): Promise<AssistantExposure> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["enabled", "sceneActionsEnabled", "roomMetrics", "deviceRefs", "sceneRefs"].includes(key)) || typeof body.enabled !== "boolean" || (body.sceneActionsEnabled !== undefined && typeof body.sceneActionsEnabled !== "boolean") || !body.roomMetrics || typeof body.roomMetrics !== "object" || Array.isArray(body.roomMetrics) || !Array.isArray(body.deviceRefs) || (body.sceneRefs !== undefined && !Array.isArray(body.sceneRefs))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const roomMetrics: Record<string, EnvironmentMetric[]> = {};
  for (const [room, metrics] of Object.entries(body.roomMetrics)) {
    if (!room || room.length > 200 || !Array.isArray(metrics) || metrics.length > HOME_METRICS.length || metrics.some(metric => typeof metric !== "string" || !HOME_METRICS.includes(metric as EnvironmentMetric))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
    roomMetrics[room] = [...new Set(metrics as EnvironmentMetric[])];
  }
  if (body.deviceRefs.length > 500 || body.deviceRefs.some(ref => typeof ref !== "string" || !/^entity_[a-f0-9]{32}$/.test(ref))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const sceneRefs = body.sceneRefs ?? [];
  if (sceneRefs.length > 200 || sceneRefs.some(ref => typeof ref !== "string" || !/^scene_[a-f0-9]{16}$/.test(ref))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  return { version: 1, enabled: body.enabled, sceneActionsEnabled: body.sceneActionsEnabled === true, roomMetrics, deviceDids: [], sceneApprovals: {}, updatedAt: null, revision: "" };
}

export async function listAssistantExposureInventory(
  session: XiaomiSession,
  homeId: string,
  exposure: AssistantExposure,
  dependencies: { homes?: typeof listHomes; devices?: typeof listDevices; sceneCatalog?: typeof loadAgentScenes } = {},
): Promise<ExposureInventory> {
  const [homes, result] = await Promise.all([(dependencies.homes ?? listHomes)(session), (dependencies.devices ?? listDevices)(session)]);
  if (!homes.some(home => home.id === homeId)) throw new AssistantExposureError("AI_HOME_NOT_FOUND", 404);
  const devices = result.devices.filter(device => String(device.homeId ?? "") === homeId).flatMap(device => {
    const did = typeof device.did === "string" || typeof device.did === "number" ? String(device.did) : "";
    if (!did) return [];
    return [{
      did,
      name: typeof device.name === "string" && device.name ? device.name : "未命名设备",
      room: typeof device.roomName === "string" && device.roomName ? device.roomName : "未分配",
      model: typeof device.model === "string" ? device.model : "",
      logicalType: typeof device.logicalType === "string" ? device.logicalType : "",
    }];
  });
  const rooms = [...new Set(devices.map(device => device.room))].sort((a, b) => a.localeCompare(b, "zh-CN")).slice(0, 20);
  const visibleDevices = devices.filter(device => rooms.includes(device.room)).slice(0, 500);
  const items = await Promise.all(visibleDevices.map(async device => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${homeId}:${device.did}`));
    const ref = `entity_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
    const kind = classifyDeviceKind(device.model, device.name, device.logicalType);
    const eligible = !/(?:lock|camera|doorbell|security|alarm|intercom)/i.test(`${kind} ${device.model} ${device.name}`);
    return { ref, name: device.name, room: device.room, kind, enabled: eligible && exposure.deviceDids.includes(device.did), eligible, did: device.did };
  }));
  const sceneCatalog = dependencies.sceneCatalog
    ? await dependencies.sceneCatalog({ principalId: "usr_" + "0".repeat(43), homeId, session })
    : dependencies.homes || dependencies.devices
      ? []
      : await loadAgentScenes({ principalId: "usr_" + "0".repeat(43), homeId, session });
  return {
    rooms,
    metrics: HOME_METRICS,
    roomMetrics: {},
    devices: items.map(({ ref, name, room, kind, enabled, eligible }) => ({ ref, name, room, kind, enabled, eligible })),
    scenes: await Promise.all(sceneCatalog.map(async scene => {
      const savedRevision = exposure.sceneApprovals[scene.sceneId];
      const approvalStatus = scene.risk !== "low"
        ? "blocked"
        : savedRevision === scene.revision
          ? "approved"
          : savedRevision
            ? "changed"
            : "pending";
      return {
        ref: await sceneExposureRef(homeId, scene.sceneId),
        name: scene.name,
        actionCount: scene.actionCount,
        risk: scene.risk,
        approvalStatus,
        enabled: exposure.enabled && exposure.sceneActionsEnabled && approvalStatus === "approved",
        revision: scene.revision,
        actionSummaries: scene.actionSummaries,
      };
    })),
  };
}

/** Settings choices come from values the existing read tools actually report. */
export async function listObservedAssistantExposureInventory(
  session: XiaomiSession,
  homeId: string,
  exposure: AssistantExposure,
  dependencies: ExposureReaders = {},
): Promise<ExposureInventory> {
  const discovery = await (dependencies.devices ?? listDevices)(session);
  const base = await listAssistantExposureInventory(session, homeId, exposure, {
    homes: dependencies.homes,
    devices: async () => discovery,
    sceneCatalog: dependencies.sceneCatalog ?? (dependencies.homes || dependencies.devices ? async () => [] : loadAgentScenes),
  });
  const [environment, status] = await Promise.all([
    (dependencies.environment ?? collectHomeEnvironment)(session, homeId, { listDevices: async () => discovery }),
    (dependencies.deviceStatus ?? collectDeviceStatus)(session, homeId, { listDevices: async () => discovery }),
  ]);
  return observedExposureInventory(base, environment, status);
}

export function observedExposureInventory(base: ExposureInventory, environment: EnvironmentSnapshot, status: DeviceStatus): ExposureInventory {
  const roomMetrics: Record<string, EnvironmentMetric[]> = {};
  for (const group of environment.groups) {
    for (const reading of group.readings) {
      const room = reading.roomName;
      if (!room || !base.rooms.includes(room)) continue;
      const metrics = roomMetrics[room] ?? [];
      if (!metrics.includes(group.metric)) roomMetrics[room] = [...metrics, group.metric];
    }
  }
  const key = (room: string, name: string, kind: string) => `${room}\u0000${name}\u0000${kind}`;
  const statusCounts = new Map<string, number>();
  for (const group of status.rooms) for (const item of group.items) {
    const value = key(group.room, item.name, item.kind);
    statusCounts.set(value, (statusCounts.get(value) ?? 0) + 1);
  }
  const baseCounts = new Map<string, number>();
  for (const device of base.devices) {
    const value = key(device.room, device.name, device.kind);
    baseCounts.set(value, (baseCounts.get(value) ?? 0) + 1);
  }
  const devices = base.devices.filter(device => {
    const value = key(device.room, device.name, device.kind);
    return statusCounts.get(value) === baseCounts.get(value);
  });
  const metrics = HOME_METRICS.filter(metric => Object.values(roomMetrics).some(values => values.includes(metric)));
  return { rooms: base.rooms, metrics, roomMetrics, devices, scenes: base.scenes };
}

export async function updateAssistantExposure(
  session: XiaomiSession,
  homeId: string,
  input: unknown,
  actorPrincipalId: string,
  dependencies: ExposureReaders & { store?: AssistantExposureStore; env?: ExposureEnvironment } = {},
): Promise<{ exposure: AssistantExposure; inventory: ExposureInventory }> {
  if (!/^usr_[A-Za-z0-9_-]{43}$/.test(actorPrincipalId)) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const parsed = await saveAssistantExposure(homeId, input);
  const current = await readAssistantExposure(homeId, dependencies.store, dependencies.env);
  const inventory = await listObservedAssistantExposureInventory(session, homeId, current, dependencies);
  const requestedRefs = new Set((input as { deviceRefs: string[] }).deviceRefs);
  const selectedDevices = await (dependencies.devices ?? listDevices)(session);
  const homeDevices = selectedDevices.devices.filter(device => String(device.homeId ?? "") === homeId).flatMap(device => {
    const did = typeof device.did === "string" || typeof device.did === "number" ? String(device.did) : "";
    if (!did) return [];
    return [{
      did,
      name: typeof device.name === "string" ? device.name : "",
      model: typeof device.model === "string" ? device.model : "",
      logicalType: typeof device.logicalType === "string" ? device.logicalType : "",
      room: typeof device.roomName === "string" && device.roomName ? device.roomName : "未分配",
    }];
  });
  const validRefs = new Map<string, string>();
  const eligibleRefs = new Set(inventory.devices.filter(item => item.eligible).map(item => item.ref));
  for (const device of homeDevices) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${homeId}:${device.did}`));
    const ref = `entity_${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
    if (!eligibleRefs.has(ref)) continue;
    const name = typeof device.name === "string" ? device.name : "";
    const model = typeof device.model === "string" ? device.model : "";
    const kind = classifyDeviceKind(model, name, typeof device.logicalType === "string" ? device.logicalType : "");
    if (/(?:lock|camera|doorbell|security|alarm|intercom)/i.test(`${kind} ${model} ${name}`)) continue;
    validRefs.set(ref, device.did);
  }
  const deviceDids = [...requestedRefs].map(ref => validRefs.get(ref));
  if (deviceDids.some(did => !did)) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const catalog = dependencies.sceneCatalog
    ? await dependencies.sceneCatalog({ principalId: actorPrincipalId, homeId, session })
    : dependencies.homes || dependencies.devices
      ? []
      : await loadAgentScenes({ principalId: actorPrincipalId, homeId, session });
  const requestedSceneRefs = new Set(((input as { sceneRefs?: string[] }).sceneRefs ?? []));
  const validScenes = new Map(await Promise.all(catalog.filter(scene => scene.risk === "low").map(async scene => [await sceneExposureRef(homeId, scene.sceneId), scene] as const)));
  if ([...requestedSceneRefs].some(ref => !validScenes.has(ref))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  const sceneApprovals = Object.fromEntries([...requestedSceneRefs].map(ref => {
    const scene = validScenes.get(ref)!;
    return [scene.sceneId, scene.revision];
  }));
  for (const room of Object.keys(parsed.roomMetrics)) if (!inventory.rooms.includes(room)) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  for (const [room, metrics] of Object.entries(parsed.roomMetrics)) {
    if (metrics.some(metric => !(inventory.roomMetrics?.[room] ?? []).includes(metric))) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  }
  const changedAt = new Date().toISOString();
  const next: AssistantExposure = { ...parsed, deviceDids: deviceDids as string[], sceneApprovals, updatedAt: changedAt, revision: await exposureRevision({ ...parsed, deviceDids: deviceDids as string[], sceneApprovals }) };
  try {
    const store = dependencies.store ?? blobStore(dependencies.env);
    const baseKey = await homeKey(homeId);
    const auditKey = baseKey.replace(/\.json$/, `/audit/${Date.now()}-${crypto.randomUUID()}.json`);
    const auditRecord: AssistantExposureAuditRecord = {
      version: 1,
      changedAt,
      actorPrincipalId,
      previousRevision: current.revision,
      revision: next.revision,
      enabled: next.enabled,
      roomMetrics: next.roomMetrics,
      exposedDeviceCount: next.deviceDids.length,
      exposedSceneCount: Object.keys(next.sceneApprovals).length,
      sceneActionsEnabled: next.sceneActionsEnabled,
    };
    await store.setJSON(auditKey, auditRecord, { onlyIfNew: true });
    await store.setJSON(baseKey, next);
  } catch {
    throw new AssistantExposureError("AI_EXPOSURE_STORE_UNAVAILABLE", 503);
  }
  return {
    exposure: next,
    inventory: {
      ...inventory,
      devices: inventory.devices.map(device => ({ ...device, enabled: device.eligible && requestedRefs.has(device.ref) })),
      scenes: inventory.scenes.map(scene => ({
        ...scene,
        approvalStatus: scene.risk !== "low" ? "blocked" : requestedSceneRefs.has(scene.ref) ? "approved" : "pending",
        enabled: next.enabled && next.sceneActionsEnabled && requestedSceneRefs.has(scene.ref),
      })),
    },
  };
}

export function assistantExposureProjection(exposure: AssistantExposure, inventory: ExposureInventory) {
  if (!exposure.enabled) return { revision: exposure.revision, rooms: [], measurementTypes: [], deviceKinds: [], sceneRevisions: [], capabilities: [] };
  const selectedDevices = inventory.devices.filter(device => device.eligible && device.enabled && inventory.rooms.includes(device.room));
  const exposedMeasurementRooms = Object.keys(exposure.roomMetrics).filter(room => inventory.rooms.includes(room));
  const rooms = [...new Set([...exposedMeasurementRooms, ...selectedDevices.map(device => device.room)])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const measurementTypes = [...new Set(exposedMeasurementRooms.flatMap(room => exposure.roomMetrics[room] ?? []))].sort();
  const deviceKinds = [...new Set(selectedDevices.map(device => device.kind))].sort();
  return {
    revision: exposure.revision,
    rooms,
    measurementTypes,
    deviceKinds,
    sceneRevisions: exposure.sceneActionsEnabled ? inventory.scenes.filter(scene => scene.enabled).map(scene => scene.revision) : [],
    capabilities: [
      ...(rooms.length && measurementTypes.length ? [{ name: "get_home_environment", available: true as const, risk: "home_read" as const }] : []),
      ...(selectedDevices.length ? [{ name: "get_device_status", available: true as const, risk: "home_read" as const }] : []),
    ],
  };
}
