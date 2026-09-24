import {
  authenticateXiaomiSession,
  jsonResponse,
  readJsonBody,
  webApiErrorResponse,
  type AiWebContext,
} from "../web-chat/web-api-boundary.ts";
import { listDevices, listHomes } from "../../xiaomi-cloud.ts";
import { derivePrincipalId } from "../security/principal.ts";
import { AssistantExposureError, listAssistantExposureInventory, readAssistantExposure, updateAssistantExposure, type AssistantExposureStore } from "../tools/assistant-exposure.ts";

const MAX_BODY_BYTES = 32768;

function requestedHome(request: Request, body?: unknown) {
  const url = new URL(request.url);
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).homeId
    : url.searchParams.get("homeId");
  if (typeof value !== "string" || !value || value.length > 100) throw new AssistantExposureError("AI_INVALID_REQUEST", 400);
  return value;
}

async function resolveHome(
  session: Awaited<ReturnType<typeof authenticateXiaomiSession>>,
  homeId: string,
  homesReader: typeof listHomes = listHomes,
) {
  const homes = await homesReader(session);
  if (!homes.some(home => home.id === homeId)) throw new AssistantExposureError("AI_HOME_NOT_FOUND", 403);
}

export async function onRequest(context: AiWebContext, dependencies: {
  store?: AssistantExposureStore;
  homes?: typeof listHomes;
  devices?: typeof listDevices;
} = {}) {
  if (context.request.method !== "GET" && context.request.method !== "PUT") {
    return jsonResponse({ code: "AI_INVALID_REQUEST" }, 405);
  }
  try {
    const session = await authenticateXiaomiSession(context.request, context.env);
    const body = context.request.method === "PUT" ? await readJsonBody(context.request, MAX_BODY_BYTES) : undefined;
    const homeId = requestedHome(context.request, body);
    await resolveHome(session, homeId, dependencies.homes);
    if (context.request.method === "GET") {
      const exposure = await readAssistantExposure(homeId, dependencies.store, context.env);
      const inventory = await listAssistantExposureInventory(session, homeId, exposure);
      return jsonResponse({ exposure: { enabled: exposure.enabled, roomMetrics: exposure.roomMetrics, updatedAt: exposure.updatedAt, revision: exposure.revision }, inventory }, 200);
    }
    const actorPrincipalId = await derivePrincipalId(session, context.env);
    // homeId selects the authorized home; it is transport context, not an exposure setting.
    const settings = body && typeof body === "object" && !Array.isArray(body)
      ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => key !== "homeId"))
      : body;
    const result = await updateAssistantExposure(session, homeId, settings, actorPrincipalId, {
      store: dependencies.store,
      env: context.env,
      homes: dependencies.homes,
      devices: dependencies.devices,
    });
    return jsonResponse({ exposure: { enabled: result.exposure.enabled, roomMetrics: result.exposure.roomMetrics, updatedAt: result.exposure.updatedAt, revision: result.exposure.revision }, inventory: result.inventory }, 200);
  } catch (error) {
    if (error instanceof AssistantExposureError) {
      return jsonResponse({ code: error.code }, error.status);
    }
    return webApiErrorResponse(error);
  }
}
