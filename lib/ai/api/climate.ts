import { listHomes } from "../../xiaomi-cloud.ts";
import { authenticateXiaomiSession, jsonResponse, readJsonBody, webApiErrorResponse, type AiWebContext } from "../web-chat/web-api-boundary.ts";
import { ClimateError, climateInventory, deleteClimateState, publicClimateState, readClimateState, reconcileClimateConfig, sampleClimate, updateClimateConfig, writeClimateState, type ClimateStore } from "../climate/climate-store.ts";

type Action = "config" | "sample" | "observations" | "profiles" | "derive" | "review" | "memory";
type Dependencies = { store?: ClimateStore; homes?: typeof listHomes; fetch?: typeof fetch };
const MAX_BODY = 64 * 1024;

function homeIdOf(request: Request, body?: unknown) {
  const candidate = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).homeId
    : new URL(request.url).searchParams.get("homeId");
  if (typeof candidate !== "string" || !candidate || candidate.length > 100) throw new ClimateError("AI_INVALID_REQUEST");
  return candidate;
}

async function derive(homeId: string, context: AiWebContext, dependencies: Dependencies) {
  const state = await readClimateState(homeId, dependencies.store, context.env);
  const base = context.env.AI_AGENT_BASE_URL?.replace(/\/$/, "");
  const secret = context.env.AI_AGENT_INTERNAL_SECRET;
  if (!base || !secret) throw new ClimateError("AI_CLIMATE_DERIVATION_UNAVAILABLE", 503);
  const response = await (dependencies.fetch ?? fetch)(`${base}/climate-profile`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timezone: state.timezone, observations: state.observations }),
  });
  if (!response.ok) throw new ClimateError("AI_CLIMATE_DERIVATION_UNAVAILABLE", 502);
  const profile = await response.json() as typeof state.draftProfile;
  state.draftProfile = profile;
  if (profile && !state.profileRevisions.some(item => item.revision === profile.revision)) state.profileRevisions.push(profile);
  state.updatedAt = new Date().toISOString();
  await writeClimateState(homeId, state, dependencies.store, context.env);
  return state;
}

export async function climateRequest(context: AiWebContext, action: Action, dependencies: Dependencies = {}) {
  try {
    const store = dependencies.store ?? (context.env.AI_ENVIRONMENT === "development" ? (await import("../climate/local-climate-store.ts")).localClimateStore : undefined);
    dependencies = { ...dependencies, store };
    const allowed: Record<Action, string[]> = { config: ["GET", "PUT"], sample: ["POST"], observations: ["GET", "PATCH"], profiles: ["GET"], derive: ["POST"], review: ["POST"], memory: ["DELETE"] };
    if (!allowed[action].includes(context.request.method)) return jsonResponse({ code: "AI_INVALID_REQUEST" }, 405);
    const session = await authenticateXiaomiSession(context.request, context.env);
    const body = ["PUT", "POST", "PATCH", "DELETE"].includes(context.request.method) ? await readJsonBody(context.request, MAX_BODY) : undefined;
    const homeId = homeIdOf(context.request, body);
    if (!(await (dependencies.homes ?? listHomes)(session)).some(home => home.id === homeId)) throw new ClimateError("AI_HOME_NOT_FOUND", 403);

    if (action === "config") {
      let result;
      if (context.request.method === "GET") {
        const state = await readClimateState(homeId, dependencies.store, context.env), inventory = await climateInventory(session, homeId);
        if (reconcileClimateConfig(state, inventory)) {
          state.updatedAt = new Date().toISOString();
          await writeClimateState(homeId, state, dependencies.store, context.env);
        }
        result = { state, inventory };
      } else result = await updateClimateConfig(session, homeId, stripHome(body), dependencies.store, context.env);
      return jsonResponse(publicClimateState(result.state, sanitizeInventory(result.inventory)), 200);
    }
    if (action === "sample") {
      const result = await sampleClimate(session, homeId, dependencies.store, context.env);
      let derivationPending = false;
      if (result.acceptedOverrides) try { result.state = await derive(homeId, context, dependencies); } catch { derivationPending = true; }
      return jsonResponse({ ...publicClimateState(result.state), sampled: result.sampled, acceptedOverrides: result.acceptedOverrides, derivationPending }, 200);
    }
    if (action === "observations") {
      const state = await readClimateState(homeId, dependencies.store, context.env);
      if (context.request.method === "PATCH") {
        const value = stripHome(body) as Record<string, unknown>;
        if (!value || Object.keys(value).some(key => !["observationRef", "excluded"].includes(key)) || typeof value.observationRef !== "string" || typeof value.excluded !== "boolean") throw new ClimateError("AI_INVALID_REQUEST");
        const observation = state.observations.find(item => item.observationRef === value.observationRef);
        if (!observation) throw new ClimateError("AI_CLIMATE_OBSERVATION_NOT_FOUND", 404);
        observation.excluded = value.excluded;
        await writeClimateState(homeId, state, dependencies.store, context.env);
      }
      return jsonResponse({ observations: state.observations }, 200);
    }
    if (action === "derive") return jsonResponse(publicClimateState(await derive(homeId, context, dependencies)), 200);
    if (action === "review") {
      const state = await readClimateState(homeId, dependencies.store, context.env), value = stripHome(body) as Record<string, unknown>;
      if (value && Object.keys(value).every(key => ["revision", "edit"].includes(key)) && value.revision === state.draftProfile?.revision && value.edit && typeof value.edit === "object" && !Array.isArray(value.edit)) {
        const profile = state.draftProfile;
        if (!profile) throw new ClimateError("AI_INVALID_REQUEST");
        const edit = value.edit as Record<string, unknown>;
        if (Object.keys(edit).some(key => !["roomRef", "actuatorRef", "timeWindow", "ambientBand", "targetTemperature", "mode"].includes(key)) || typeof edit.roomRef !== "string" || typeof edit.actuatorRef !== "string" || typeof edit.timeWindow !== "string" || typeof edit.ambientBand !== "string" || (edit.targetTemperature !== undefined && (typeof edit.targetTemperature !== "number" || edit.targetTemperature < 5 || edit.targetTemperature > 40)) || (edit.mode !== undefined && (typeof edit.mode !== "string" || edit.mode.length > 40))) throw new ClimateError("AI_INVALID_REQUEST");
        const cell = profile.rooms.find(room => room.roomRef === edit.roomRef && room.actuatorRef === edit.actuatorRef)?.cells.find(item => item.timeWindow === edit.timeWindow && item.ambientBand === edit.ambientBand);
        if (!cell) throw new ClimateError("AI_INVALID_REQUEST");
        if (typeof edit.targetTemperature === "number") cell.explicitTargetTemperature = edit.targetTemperature;
        if (typeof edit.mode === "string") cell.explicitMode = edit.mode;
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(profile.rooms)));
        profile.revision = `climate_${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
        profile.generatedAt = new Date().toISOString();
        state.profileRevisions.push(structuredClone(profile));
        await writeClimateState(homeId, state, dependencies.store, context.env);
        return jsonResponse(publicClimateState(state), 200);
      }
      if (!value || Object.keys(value).some(key => key !== "revision") || value.revision !== state.draftProfile?.revision) throw new ClimateError("AI_INVALID_REQUEST");
      state.reviewedRevision = value.revision as string; state.reviewedAt = new Date().toISOString();
      await writeClimateState(homeId, state, dependencies.store, context.env);
      return jsonResponse(publicClimateState(state), 200);
    }
    if (action === "memory") {
      const value = stripHome(body) as Record<string, unknown>;
      if (value && Object.keys(value).length) {
        if (Object.keys(value).some(key => key !== "roomRef") || typeof value.roomRef !== "string") throw new ClimateError("AI_INVALID_REQUEST");
        const state = await readClimateState(homeId, dependencies.store, context.env), roomRef = value.roomRef;
        state.rooms = state.rooms.filter(room => room.roomRef !== roomRef); state.samples = state.samples.filter(item => item.roomRef !== roomRef); state.observations = state.observations.filter(item => item.roomRef !== roomRef); delete state.runtime[roomRef];
        for (const profile of state.profileRevisions) profile.rooms = profile.rooms.filter(room => room.roomRef !== roomRef);
        if (state.draftProfile) state.draftProfile.rooms = state.draftProfile.rooms.filter(room => room.roomRef !== roomRef);
        await writeClimateState(homeId, state, dependencies.store, context.env);
        return jsonResponse(publicClimateState(state), 200);
      }
      await deleteClimateState(homeId, dependencies.store, context.env); return jsonResponse({ deleted: true }, 200);
    }
    return jsonResponse(publicClimateState(await readClimateState(homeId, dependencies.store, context.env)), 200);
  } catch (error) {
    if (error instanceof ClimateError) return jsonResponse({ code: error.code }, error.status);
    return webApiErrorResponse(error);
  }
}

function stripHome(body: unknown) {
  return body && typeof body === "object" && !Array.isArray(body)
    ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => key !== "homeId")) : body;
}
function sanitizeInventory(inventory: { sensors: Array<{ ref: string; name: string; room: string }>; actuators: Array<{ ref: string; name: string; room: string }> }) {
  return { sensors: inventory.sensors.map(({ ref, name, room }) => ({ ref, name, room })), actuators: inventory.actuators.map(({ ref, name, room }) => ({ ref, name, room })) };
}
