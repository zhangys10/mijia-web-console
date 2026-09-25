import { listDevices, listHomes, type XiaomiDeviceList, type XiaomiSession } from "../../xiaomi-cloud.ts";
import { isPreviewEnvironment } from "../config.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { AutomationTokenError, openAutomationToken } from "../security/automation-token.ts";
import { collectDeviceStatus, type DeviceStatus } from "../../device-status.ts";
import { classifyDeviceKind } from "../../device-views.ts";
import { collectHomeEnvironment, type EnvironmentMetric, type EnvironmentSnapshot, type HomeEnvironmentDiagnostics } from "../../home-environment.ts";
import {
  AssistantExposureError,
  assistantExposureProjection,
  listAssistantExposureInventory,
  readAssistantExposure,
  type AssistantExposure,
  type AssistantExposureStore,
  type ExposureInventory,
} from "./assistant-exposure.ts";
import { authorizeRemoteTool, RemoteToolError } from "./remote-tool-service.ts";

type Environment = Record<string, string | undefined>;
type HomeContext = { session: XiaomiSession; homeId: string; discovery: XiaomiDeviceList; exposure: AssistantExposure; inventory: ExposureInventory; selectedDids: string[] };

export type AssistantV1Dependencies = {
  homes?: typeof listHomes;
  environment?: typeof collectHomeEnvironment;
  devices?: typeof collectDeviceStatus;
  discovery?: typeof listDevices;
  homeInventory?: typeof listAssistantExposureInventory;
  exposure?: typeof readAssistantExposure;
  exposureStore?: AssistantExposureStore;
  diagnosticLogger?: (record: Record<string, unknown>) => void;
};

const NO_STORE = { "Cache-Control": "no-store" };
const deviceStates = new Set(["on", "off", "unknown"]);

class AssistantV1RequestError extends RemoteToolError {
  readonly diagnosticCode: string;
  constructor(diagnosticCode: string) {
    super("AI_INVALID_REQUEST", 400);
    this.diagnosticCode = diagnosticCode;
  }
}

function invalid(reason: string): never { throw new AssistantV1RequestError(reason); }

function validateBody(body: unknown, allowed: readonly string[]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("BODY_NOT_OBJECT");
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) invalid("BODY_UNKNOWN_FIELD");
  if (typeof record.requestId !== "string" || !/^[A-Za-z0-9_.-]{6,128}$/.test(record.requestId)) invalid("REQUEST_ID_INVALID");
  if (record.home !== undefined && (typeof record.home !== "string" || !record.home.trim() || record.home.length > 100)) invalid("HOME_SELECTOR_INVALID");
  return record;
}

async function resolveHomeContext(
  input: Record<string, unknown>,
  token: string,
  env: Environment,
  dependencies: AssistantV1Dependencies,
): Promise<HomeContext> {
  if (token.length > 8192) throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  const tokenEnvironment = env.APP_ENV?.trim();
  if (!tokenEnvironment) throw new RemoteToolError("AI_AUTOMATION_TOKEN_ENV_NOT_CONFIGURED", 500);
  let payload;
  try {
    payload = await openAutomationToken(token, {
      secret: env.AI_AUTOMATION_TOKEN_SECRET || undefined,
      expectedKeyId: env.AI_AUTOMATION_TOKEN_KEY_ID || undefined,
      env: tokenEnvironment,
    });
  } catch (error) {
    if (error instanceof AutomationTokenError && error.code === "AUTOMATION_TOKEN_EXPIRED") throw new RemoteToolError("AUTOMATION_TOKEN_EXPIRED", 401);
    throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  }
  if (payload.audience !== "mijia-agent") throw new RemoteToolError("AUTOMATION_TOKEN_INVALID", 401);
  try { await derivePrincipalId(payload.xiaomiSession, env); }
  catch { throw new RemoteToolError("AI_UNAUTHENTICATED", 401); }
  const discovery = await (dependencies.discovery ?? listDevices)(payload.xiaomiSession);
  const homes = dependencies.homes ? await dependencies.homes(payload.xiaomiSession) : discovery.homes;
  if (!homes.length) throw new RemoteToolError("AI_HOME_NOT_FOUND", 404);
  const selector = typeof input.home === "string" ? input.home.trim() : "";
  const home = selector
    ? homes.find(item => item.id === selector) ?? homes.find(item => item.name === selector) ?? homes.find(item => item.name.includes(selector) || selector.includes(item.name))
    : payload.homeId ? homes.find(item => item.id === payload.homeId) : homes[0];
  if (!home) throw new RemoteToolError("AI_HOME_NOT_FOUND", 404);
  const exposure = await (dependencies.exposure ?? readAssistantExposure)(home.id, dependencies.exposureStore, env);
  const inventory = dependencies.homeInventory
    ? await dependencies.homeInventory(payload.xiaomiSession, home.id, exposure)
    : await listAssistantExposureInventory(payload.xiaomiSession, home.id, exposure, {
      homes: async () => homes,
      devices: async () => discovery,
    });
  const eligibleDids = new Set(discovery.devices.flatMap(device => {
    if (String(device.homeId ?? "") !== home.id) return [];
    const name = typeof device.name === "string" ? device.name : "";
    const model = typeof device.model === "string" ? device.model : "";
    const kind = classifyDeviceKind(model, name, typeof device.logicalType === "string" ? device.logicalType : "");
    const did = typeof device.did === "string" || typeof device.did === "number" ? String(device.did) : "";
    return did && !/(?:lock|camera|doorbell|security|alarm|intercom)/i.test(`${kind} ${model} ${name}`) ? [did] : [];
  }));
  const selectedDids = exposure.enabled ? exposure.deviceDids.filter(did => eligibleDids.has(did)) : [];
  return { session: payload.xiaomiSession, homeId: home.id, discovery, exposure, inventory, selectedDids };
}

export async function getAssistantCapabilitiesV1(
  body: unknown,
  token: string,
  env: Environment,
  dependencies: AssistantV1Dependencies = {},
) {
  const input = validateBody(body, ["requestId", "home"]);
  const context = await resolveHomeContext(input, token, env, dependencies);
  const projection = assistantExposureProjection(context.exposure, context.inventory);
  return {
    contextVersion: "1",
    exposureRevision: projection.revision,
    capabilities: projection.capabilities,
    projection: {
      rooms: projection.rooms,
      measurementTypes: projection.measurementTypes,
      deviceKinds: projection.deviceKinds,
      roomMetrics: Object.fromEntries(Object.entries(context.exposure.roomMetrics)
        .filter(([room]) => context.inventory.rooms.includes(room))
        .map(([room, metrics]) => [room, metrics])),
      roomDeviceKinds: Object.fromEntries(projection.rooms.map(room => [room, [...new Set(context.inventory.devices
        .filter(device => device.room === room && device.eligible && device.enabled)
        .map(device => device.kind))]]).filter(([, kinds]) => (kinds as string[]).length > 0)),
      sceneSearchAvailable: false,
    },
  };
}

function statusIsPartial(diagnostics: HomeEnvironmentDiagnostics) {
  return diagnostics.specificationFailures > 0 || diagnostics.failedBatches > 0
    || diagnostics.missingResults > 0 || diagnostics.nonzeroResults > 0 || diagnostics.invalidValues > 0;
}

function stringFilter(args: Record<string, unknown>, name: string, allowed: readonly string[], max: number): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !allowed.includes(item))) invalid(`FILTER_${name.toUpperCase()}_INVALID`);
  return [...new Set(value as string[])];
}

function validateArguments(operation: unknown, value: unknown, projection: ReturnType<typeof assistantExposureProjection>) {
  if (typeof operation !== "string" || !["get_home_environment", "get_device_status"].includes(operation)) invalid("OPERATION_INVALID");
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("ARGUMENTS_NOT_OBJECT");
  const args = value as Record<string, unknown>;
  const keys = operation === "get_home_environment" ? ["rooms", "metrics"] : ["rooms", "kinds", "states"];
  if (Object.keys(args).some(key => !keys.includes(key))) invalid("ARGUMENTS_UNKNOWN_FIELD");
  const rooms = stringFilter(args, "rooms", projection.rooms, 20);
  const metrics = operation === "get_home_environment" ? stringFilter(args, "metrics", projection.measurementTypes, 9) : undefined;
  const kinds = operation === "get_device_status" ? stringFilter(args, "kinds", projection.deviceKinds, 40) : undefined;
  const states = operation === "get_device_status" ? stringFilter(args, "states", [...deviceStates], 3) : undefined;
  return { rooms, metrics: metrics as EnvironmentMetric[] | undefined, kinds, states };
}

export function filterEnvironmentByExposure(status: EnvironmentSnapshot, roomMetrics: Record<string, readonly EnvironmentMetric[]>, onTruncation?: (details: { readingLimitReached: boolean; responseSizeLimitReached: boolean }) => void): EnvironmentSnapshot {
  let truncated = false;
  const groups = status.groups.flatMap(group => {
    const readings = group.readings.filter(item => item.roomName !== null && (roomMetrics[item.roomName] ?? []).includes(group.metric));
    const latest = group.latest && group.latest.roomName !== null && (roomMetrics[group.latest.roomName] ?? []).includes(group.metric) ? group.latest : readings[0] ?? null;
    if (readings.length > 20) truncated = true;
    return readings.length || latest ? [{ ...group, latest, readings: readings.slice(0, 20) }] : [];
  });
  const snapshot: EnvironmentSnapshot = { ...status, groups, completeness: groups.length ? status.completeness : "empty" };
  const truncationWarning = "部分读数未展示。";
  const byteLength = () => new TextEncoder().encode(JSON.stringify({
    ...snapshot,
    completeness: "partial",
    warnings: [...status.warnings.slice(0, 7), truncationWarning],
  })).byteLength;
  let responseSizeLimitReached = byteLength() > 60_000;
  while (responseSizeLimitReached) {
    const largest = snapshot.groups.filter(group => group.readings.length > 1)
      .sort((left, right) => right.readings.length - left.readings.length)[0];
    if (!largest) break;
    largest.readings.pop();
    truncated = true;
    responseSizeLimitReached = byteLength() > 60_000;
  }
  if (truncated) {
    snapshot.completeness = "partial";
    snapshot.warnings = [...status.warnings.slice(0, 7), truncationWarning];
  }
  if (truncated || responseSizeLimitReached) {
    onTruncation?.({ readingLimitReached: truncated, responseSizeLimitReached });
  }
  return snapshot;
}

export function filterDeviceStatus(status: DeviceStatus, rooms: readonly string[], kinds: readonly string[] | undefined, states: readonly string[] | undefined): DeviceStatus {
  const filteredRooms = status.rooms.flatMap(group => {
    if (!rooms.includes(group.room)) return [];
    const items = group.items.filter(item => (!kinds || kinds.includes(item.kind)) && (!states || states.includes(item.state)));
    return items.length ? [{ ...group, items }] : [];
  });
  const poweredOn = filteredRooms.reduce((count, room) => count + room.items.filter(item => item.state === "on").length, 0);
  return { ...status, rooms: filteredRooms, poweredOn, completeness: filteredRooms.length ? status.completeness : "empty" };
}

export async function invokeAssistantToolV1(
  body: unknown,
  token: string,
  env: Environment,
  dependencies: AssistantV1Dependencies = {},
) {
  const input = validateBody(body, ["requestId", "home", "operation", "arguments"]);
  const context = await resolveHomeContext(input, token, env, dependencies);
  const projection = assistantExposureProjection(context.exposure, context.inventory);
  const operation = input.operation;
  const operationProjection = operation === "get_home_environment"
    ? { ...projection, rooms: Object.keys(context.exposure.roomMetrics).filter(room => context.inventory.rooms.includes(room)) }
    : projection;
  const filters = validateArguments(operation, input.arguments, operationProjection);
  if (!context.exposure.enabled || !projection.capabilities.some(capability => capability.name === operation)) {
    throw new RemoteToolError("AI_CAPABILITY_UNAVAILABLE", 403);
  }
  if (isPreviewEnvironment(env)) throw new RemoteToolError("AI_PREVIEW_READ_ONLY", 403);
  if (operation === "get_home_environment") {
    if (!projection.capabilities.some(item => item.name === "get_home_environment")) throw new RemoteToolError("AI_CAPABILITY_UNAVAILABLE", 403);
    const exposedRooms = operationProjection.rooms;
    const rooms = filters.rooms ?? exposedRooms;
    const requestedMetrics = filters.metrics;
    const roomMetrics = Object.fromEntries(rooms.flatMap(room => {
      const exposed = context.exposure.roomMetrics[room] ?? [];
      const selected = requestedMetrics ? exposed.filter(metric => requestedMetrics.includes(metric)) : exposed;
      return selected.length ? [[room, selected]] : [];
    }));
    const metrics = [...new Set(Object.values(roomMetrics).flat())];
    const requestId = typeof input.requestId === "string" && /^[A-Za-z0-9_.-]{6,128}$/.test(input.requestId) ? input.requestId : undefined;
    const logDiagnostic = dependencies.diagnosticLogger ?? (record => console.info(JSON.stringify(record)));
    const status = await (dependencies.environment ?? collectHomeEnvironment)(context.session, context.homeId, {
      listDevices: async () => context.discovery,
      onDiagnostics: (diagnostics: HomeEnvironmentDiagnostics) => {
        if (statusIsPartial(diagnostics)) {
          logDiagnostic({ event: "assistant_environment_partial", requestId, route: "/api/internal/assistant/v1/tools:invoke", stage: "PROPERTY_COLLECTION", httpStatus: 200, category: "PARTIAL_READ", ...diagnostics });
        }
      },
    }, {
      rooms,
      metrics,
      roomMetrics,
    });
    return filterEnvironmentByExposure(status, roomMetrics, details => {
      logDiagnostic({ event: "assistant_environment_partial", requestId, route: "/api/internal/assistant/v1/tools:invoke", stage: "EXPOSURE_FILTER", httpStatus: 200, category: "RESPONSE_TRUNCATED", ...details });
    });
  }
  const rooms = filters.rooms ?? projection.rooms;
  const selectedDids = context.selectedDids;
  const status = await (dependencies.devices ?? collectDeviceStatus)(context.session, context.homeId, { listDevices: async () => context.discovery }, selectedDids);
  return filterDeviceStatus(status, rooms, filters.kinds, filters.states);
}

export function createAssistantV1Handler(
  operation: "capabilities" | "invoke",
  dependencies: AssistantV1Dependencies = {},
) {
  return async function onRequest(context: { request: Request; env: Environment }) {
    const headers = { ...NO_STORE, "Content-Type": "application/json" };
    const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    let stage: "AUTHORIZATION" | "REQUEST_BODY" | "CAPABILITIES" | "TOOL_INVOKE" = "AUTHORIZATION";
    let requestId: string | undefined;
    try {
      if (context.request.method !== "POST") return respond({ code: "AI_INVALID_REQUEST" }, 405);
      if (!await authorizeRemoteTool(context.request.headers.get("Authorization"), context.env.AI_TOOLS_INTERNAL_SECRET)) return respond({ code: "AI_UNAUTHENTICATED" }, 401);
      const token = context.request.headers.get("X-Ai-User-Token") ?? "";
      if (!token) return respond({ code: "AI_UNAUTHENTICATED" }, 401);

      stage = "REQUEST_BODY";
      let body: unknown;
      try {
        const text = await context.request.text();
        if (new TextEncoder().encode(text).byteLength > 32768) return respond({ code: "AI_INVALID_REQUEST" }, 400);
        body = JSON.parse(text);
      } catch { return respond({ code: "AI_INVALID_REQUEST" }, 400); }

      requestId = body && typeof body === "object" && !Array.isArray(body)
        && typeof (body as Record<string, unknown>).requestId === "string"
        && /^[A-Za-z0-9_.-]{6,128}$/.test((body as Record<string, string>).requestId)
        ? (body as Record<string, string>).requestId : undefined;
      stage = operation === "capabilities" ? "CAPABILITIES" : "TOOL_INVOKE";
      const result = operation === "capabilities"
        ? await getAssistantCapabilitiesV1(body, token, context.env, dependencies)
        : await invokeAssistantToolV1(body, token, context.env, dependencies);
      return respond(result);
    } catch (error) {
      if (error instanceof AssistantExposureError) return respond({ code: error.code }, error.status);
      if (error instanceof AssistantV1RequestError) return respond({ code: error.message, diagnosticCode: error.diagnosticCode }, error.status);
      if (error instanceof RemoteToolError) return respond({ code: error.message }, error.status);
      (dependencies.diagnosticLogger ?? (record => console.error(JSON.stringify(record))))({
        event: "assistant_api_exception",
        requestId: requestId ?? crypto.randomUUID(),
        route: `/api/internal/assistant/v1/${operation === "capabilities" ? "capabilities" : "tools:invoke"}`,
        stage,
        httpStatus: 502,
        category: "UNEXPECTED_EXCEPTION",
      });
      return respond({
        code: "AI_AGENT_UNAVAILABLE",
        diagnosticCode: `ASSISTANT_${stage}_EXCEPTION`,
      }, 502);
    }
  };
}
