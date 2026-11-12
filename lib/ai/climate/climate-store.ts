import { getStore } from "@edgeone/pages-blob";
import { getMiotCapabilities, type MiotCapabilityProperty } from "../../miot-spec.ts";
import { listDevices, xiaomiRequest, type XiaomiSession } from "../../xiaomi-cloud.ts";

export type ClimateStore = {
  get(key: string, options?: { type?: "json"; consistency?: "strong" | "eventual" }): Promise<unknown>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
  delete?(key: string): Promise<void>;
};
type PropertyPlan = { did: string; siid: number; piid: number };
type ConfiguredActuator = {
  actuatorRef: string; actuatorName: string; actuatorRoom: string;
  target: PropertyPlan; mode?: PropertyPlan; power?: PropertyPlan;
  range: { min: number; max: number; step: number }; modes?: Array<number | string | boolean>;
  modeLabels?: Record<string, string>;
  capabilityRevision: string;
};
type ConfiguredRoom = {
  roomRef: string; roomName: string; sensorRef: string; sensor: PropertyPlan;
  sensorName: string; actuators: ConfiguredActuator[];
};
export type ClimateObservation = {
  observationRef: string; roomRef: string; actuatorRef: string; ambientTemperature: number; targetTemperature: number;
  mode: string | null; capturedAt: string; localHour: number; dayOfWeek: number;
  powerOn: boolean | null;
  source: "external_override" | "console_override"; excluded: boolean;
  previous: { targetTemperature: number; mode: string | null };
};
export type ClimateCell = {
  timeWindow: string; ambientBand: string; ambientRange: [number | null, number | null];
  status: "learned" | "suggested" | "insufficient_evidence"; derivedTargetTemperature: number | null;
  derivedMode: string | null; confidence: number; supportCount: number; distinctDates: number;
  contributingFrom: string | null; contributingTo: string | null; explanation: string;
  explicitTargetTemperature?: number; explicitMode?: string;
};
type RoomRuntime = {
  confirmed?: { targetTemperature: number; mode: string | null; observedAt: string };
  candidate?: { targetTemperature: number; mode: string | null; firstSeenAt: string; source?: "console_override" };
  lastSampleAt?: string;
};
export type ClimateState = {
  version: 1; enabled: boolean; timezone: "Asia/Shanghai"; rooms: ConfiguredRoom[];
  samples: Array<{ sampleRef: string; roomRef: string; actuatorRef: string; ambientTemperature: number; targetTemperature: number; mode: string | null; power: boolean | null; capturedAt: string }>;
  observations: ClimateObservation[]; runtime: Record<string, RoomRuntime>;
  draftProfile: { version: "1"; revision: string; generatedAt: string; rooms: Array<{ roomRef: string; actuatorRef: string; cells: ClimateCell[] }> } | null;
  profileRevisions: Array<{ version: "1"; revision: string; generatedAt: string; rooms: Array<{ roomRef: string; actuatorRef: string; cells: ClimateCell[] }> }>;
  reviewedRevision: string | null; reviewedAt: string | null; updatedAt: string | null;
};
type DeviceOption = { ref: string; name: string; room: string };
export type ClimateInventory = { sensors: DeviceOption[]; actuators: DeviceOption[] };
type SensorInventoryItem = DeviceOption & { plan: PropertyPlan };
type ActuatorInventoryItem = DeviceOption & {
  target: PropertyPlan; mode?: PropertyPlan; power?: PropertyPlan; revision: string;
  range: { min: number; max: number; step: number }; modes?: Array<number | string | boolean>;
  modeLabels?: Record<string, string>;
};
type ClimateDiscoveryInventory = { sensors: SensorInventoryItem[]; actuators: ActuatorInventoryItem[] };

export class ClimateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}

const emptyState = (): ClimateState => ({ version: 1, enabled: false, timezone: "Asia/Shanghai", rooms: [], samples: [], observations: [], runtime: {}, draftProfile: null, profileRevisions: [], reviewedRevision: null, reviewedAt: null, updatedAt: null });
const CLIMATE_CAPABILITY_POLICY = "boiler-thermostat-only-v2";
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
async function digest(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join(""); }
const propertyKey = (value: PropertyPlan) => `${value.did}\0${value.siid}.${value.piid}`;

function storeFor(env: Record<string, string | undefined>): ClimateStore {
  const name = env.AI_CLIMATE_MEMORY_STORE?.trim() || "mijia-ai-climate-memory-v1";
  const projectId = env.PAGES_PROJECT_ID?.trim(), token = env.PAGES_BLOB_API_TOKEN?.trim();
  return (projectId && token ? getStore({ name, projectId, token }) : getStore(name)) as ClimateStore;
}
async function homeKey(homeId: string) { return `homes/${await digest(homeId)}.json`; }

export async function readClimateState(homeId: string, supplied?: ClimateStore, env: Record<string, string | undefined> = {}) {
  try {
    const value = await (supplied ?? storeFor(env)).get(await homeKey(homeId), { type: "json", consistency: "strong" });
    if (value === null) return emptyState();
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) throw new Error("invalid climate state");
    const state = value as ClimateState;
    for (const room of state.rooms) {
      const legacy = room as ConfiguredRoom & { actuator?: ConfiguredActuator; actuatorRef?: string; actuatorName?: string; capabilityRevision?: string };
      if (!room.actuators && legacy.actuator && legacy.actuatorRef) room.actuators = [{ ...legacy.actuator, actuatorRef: legacy.actuatorRef, actuatorName: legacy.actuatorName ?? "气候设备", actuatorRoom: room.roomName, capabilityRevision: legacy.capabilityRevision ?? "legacy" }];
    }
    state.profileRevisions ??= state.draftProfile ? [state.draftProfile] : [];
    return state;
  } catch { throw new ClimateError("AI_CLIMATE_STORE_UNAVAILABLE", 503); }
}
export async function writeClimateState(homeId: string, state: ClimateState, supplied?: ClimateStore, env: Record<string, string | undefined> = {}) {
  try { await (supplied ?? storeFor(env)).setJSON(await homeKey(homeId), state); }
  catch { throw new ClimateError("AI_CLIMATE_STORE_UNAVAILABLE", 503); }
}
export async function deleteClimateState(homeId: string, supplied?: ClimateStore, env: Record<string, string | undefined> = {}) {
  try { await (supplied ?? storeFor(env)).delete?.(await homeKey(homeId)); }
  catch { throw new ClimateError("AI_CLIMATE_STORE_UNAVAILABLE", 503); }
}

async function deviceRef(homeId: string, did: string, kind: "sensor" | "actuator") { return `${kind}_${(await digest(`${homeId}:${did}`)).slice(0, 24)}`; }
async function roomRef(homeId: string, room: string) { return `room_${(await digest(`${homeId}:${room}`)).slice(0, 24)}`; }
function exact(groups: Array<{ name: string; properties: MiotCapabilityProperty[] }>, name: string) {
  return groups.flatMap(group => group.properties).find(property => property.name === name);
}
export function selectClimateProperties(groups: Array<{ name: string; label?: string; sourceLabel?: string; properties: MiotCapabilityProperty[] }>, deviceIdentity = "") {
  const groupIdentity = (group: (typeof groups)[number]) => `${group.name} ${group.label ?? ""} ${group.sourceLabel ?? ""}`.toLowerCase();
  const boiler = /(boiler|water-heater|锅炉|热水器)/.test(`${deviceIdentity} ${groups.map(groupIdentity).join(" ")}`.toLowerCase());
  const thermostatService = (group: (typeof groups)[number]) => /(thermostat|room-heating|温控|房间采暖)/.test(groupIdentity(group));
  const eligibleGroups = boiler ? groups.filter(thermostatService) : groups;
  const candidates = eligibleGroups.flatMap(group => group.properties.filter(property => property.name === "target-temperature" && property.readable && property.writable && property.range).map(target => {
    const identity = groupIdentity(group);
    const thermostat = /(thermostat|temperature-control|floor-heating|radiator|room-heating|温控|地暖|暖气|采暖)/.test(identity) ? 300 : 0;
    const climate = /(climate|air-conditioner|空调)/.test(identity) ? 200 : 0;
    const boiler = /(boiler|heater|锅炉)/.test(identity) ? 100 : 0;
    const hotWater = /(water-heater|hot-water|water-storage|bath|domestic-water|热水|洗浴|生活用水)/.test(identity) ? 400 : 0;
    const comfortRange = target.range!.min < 30 && target.range!.max <= 45 ? 100 : 0;
    const waterRange = target.range!.min >= 30 || target.range!.max > 50 ? 150 : 0;
    return { group, target, score: thermostat + climate + boiler + comfortRange - hotWater - waterRange };
  }));
  const selected = candidates.sort((left, right) => right.score - left.score)[0];
  if (!selected) return null;
  const mode = selected.group.properties.find(property => property.name === "mode" && property.readable && property.choices?.length);
  const localPower = selected.group.properties.find(property => property.name === "on" && property.readable);
  if (boiler) return { target: selected.target, mode, power: localPower, serviceName: selected.group.name, selectionPolicy: CLIMATE_CAPABILITY_POLICY };
  const fallbackPower = groups.flatMap(group => {
    const identity = groupIdentity(group);
    const hotWater = /(water-heater|hot-water|water-storage|bath|domestic-water|热水|洗浴|生活用水)/.test(identity);
    const controller = /(thermostat|floor-heating|radiator|room-heating|climate|air-conditioner|boiler|heater|温控|地暖|暖气|采暖|锅炉)/.test(identity);
    const mainController = /(controller|main-control|总控|主控)/.test(identity);
    return group.properties.filter(property => property.name === "on" && property.readable).map(power => ({ power, score: hotWater ? -100 : mainController ? 200 : controller ? 100 : 0 }));
  }).sort((left, right) => right.score - left.score)[0]?.power;
  const power = localPower ?? fallbackPower;
  return { target: selected.target, mode, power, serviceName: selected.group.name, selectionPolicy: null };
}
function plan(did: string, property: MiotCapabilityProperty): PropertyPlan { return { did, siid: property.siid, piid: property.piid }; }
function choiceLabels(property: MiotCapabilityProperty | undefined) {
  return property?.choices ? Object.fromEntries(property.choices.map(choice => [String(choice.value), choice.label])) : undefined;
}
function powerValue(value: unknown) { return typeof value === "boolean" ? value : value === 1 || value === "1" ? true : value === 0 || value === "0" ? false : null; }

export async function climateInventory(session: XiaomiSession, homeId: string): Promise<ClimateDiscoveryInventory> {
  const discovery = await listDevices(session);
  const devices = discovery.devices.filter(device => text(device.homeId ?? device.home_id) === homeId && text(device.did) && text(device.model));
  const sensors: SensorInventoryItem[] = [], actuators: ActuatorInventoryItem[] = [];
  for (const device of devices.slice(0, 200)) {
    const did = text(device.did), model = text(device.model), name = text(device.name) || "未命名设备", room = text(device.roomName ?? device.room_name) || "未分配";
    try {
      const specification = await getMiotCapabilities(model, text(device.urn) || undefined);
      const temperature = exact(specification.groups, "temperature");
      if (temperature?.readable) sensors.push({ ref: await deviceRef(homeId, did, "sensor"), name, room, plan: plan(did, temperature) });
      const climate = selectClimateProperties(specification.groups, `${model} ${name}`);
      if (climate) {
        const { target, mode: usableMode, power, serviceName, selectionPolicy } = climate;
        const revisionParts = [model, serviceName, target.siid, target.piid, target.range, usableMode?.siid, usableMode?.piid, usableMode?.choices, power?.siid, power?.piid];
        if (selectionPolicy) revisionParts.unshift(selectionPolicy);
        const revision = `rev_${(await digest(JSON.stringify(revisionParts))).slice(0, 24)}`;
        actuators.push({ ref: await deviceRef(homeId, did, "actuator"), name, room, target: plan(did, target), ...(usableMode ? { mode: plan(did, usableMode), modes: usableMode.choices!.map(choice => choice.value), modeLabels: choiceLabels(usableMode) } : {}), ...(power ? { power: plan(did, power) } : {}), revision, range: target.range! });
      }
    } catch { /* Missing specifications are unavailable, never guessed. */ }
  }
  return { sensors, actuators };
}

/** Refresh private MIoT plans without changing the user's opaque room/device selections. */
export function reconcileClimateConfig(state: ClimateState, inventory: ClimateDiscoveryInventory) {
  let changed = false;
  for (const room of state.rooms) {
    const sensor = inventory.sensors.find(item => item.ref === room.sensorRef);
    if (sensor && JSON.stringify(room.sensor) !== JSON.stringify(sensor.plan)) {
      room.sensor = sensor.plan;
      room.sensorName = sensor.name;
      changed = true;
    }
    room.actuators = room.actuators.map(actuator => {
      const discovered = inventory.actuators.find(item => item.ref === actuator.actuatorRef);
      if (!discovered) return actuator;
      const replacement: ConfiguredActuator = {
        actuatorRef: discovered.ref,
        actuatorName: discovered.name,
        actuatorRoom: discovered.room,
        target: discovered.target,
        ...(discovered.mode ? { mode: discovered.mode } : {}),
        ...(discovered.power ? { power: discovered.power } : {}),
        range: discovered.range,
        ...(discovered.modes ? { modes: discovered.modes } : {}),
        ...(discovered.modeLabels ? { modeLabels: discovered.modeLabels } : {}),
        capabilityRevision: discovered.revision,
      };
      if (JSON.stringify(actuator) === JSON.stringify(replacement)) return actuator;
      const semanticsChanged = discovered.revision !== actuator.capabilityRevision;
      const samePair = (item: { roomRef: string; actuatorRef: string }) => item.roomRef === room.roomRef && item.actuatorRef === actuator.actuatorRef;
      if (semanticsChanged) {
        delete state.runtime[`${room.roomRef}:${actuator.actuatorRef}`];
        state.samples = state.samples.filter(item => !samePair(item));
        state.observations = state.observations.filter(item => !samePair(item));
        if (state.draftProfile) state.draftProfile.rooms = state.draftProfile.rooms.filter(item => !samePair(item));
        for (const profile of state.profileRevisions) profile.rooms = profile.rooms.filter(item => !samePair(item));
        state.reviewedRevision = null;
        state.reviewedAt = null;
      }
      changed = true;
      return replacement;
    });
  }
  return changed;
}

export async function updateClimateConfig(session: XiaomiSession, homeId: string, input: unknown, supplied?: ClimateStore, env: Record<string, string | undefined> = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClimateError("AI_INVALID_REQUEST");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["enabled", "rooms"].includes(key)) || typeof body.enabled !== "boolean" || !Array.isArray(body.rooms) || body.rooms.length > 20) throw new ClimateError("AI_INVALID_REQUEST");
  const inventory = await climateInventory(session, homeId);
  const rooms: ConfiguredRoom[] = [];
  for (const raw of body.rooms) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ClimateError("AI_INVALID_REQUEST");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["roomName", "sensorRef", "actuatorRefs"].includes(key)) || !Array.isArray(item.actuatorRefs) || item.actuatorRefs.length < 1 || item.actuatorRefs.length > 12 || new Set(item.actuatorRefs).size !== item.actuatorRefs.length) throw new ClimateError("AI_INVALID_REQUEST");
    const roomName = text(item.roomName), sensor = inventory.sensors.find(value => value.ref === item.sensorRef && value.room === roomName);
    const actuators = item.actuatorRefs.map(ref => inventory.actuators.find(value => value.ref === ref));
    if (!roomName || !sensor || actuators.some(value => !value)) throw new ClimateError("AI_INVALID_REQUEST");
    rooms.push({ roomRef: await roomRef(homeId, roomName), roomName, sensorRef: sensor.ref, sensor: sensor.plan, sensorName: sensor.name, actuators: actuators.map(value => ({ actuatorRef: value!.ref, actuatorName: value!.name, actuatorRoom: value!.room, target: value!.target, mode: value!.mode, ...(value!.power ? { power: value!.power } : {}), range: value!.range, modes: value!.modes, modeLabels: value!.modeLabels, capabilityRevision: value!.revision })) });
  }
  const current = await readClimateState(homeId, supplied, env);
  const state = { ...current, enabled: body.enabled, rooms, updatedAt: new Date().toISOString() };
  await writeClimateState(homeId, state, supplied, env);
  return { state, inventory: { sensors: inventory.sensors.map(({ ref, name, room }) => ({ ref, name, room })), actuators: inventory.actuators.map(({ ref, name, room }) => ({ ref, name, room })) } };
}

export async function sampleClimate(session: XiaomiSession, homeId: string, supplied?: ClimateStore, env: Record<string, string | undefined> = {}, now = new Date(), requester: typeof xiaomiRequest = xiaomiRequest) {
  const state = await readClimateState(homeId, supplied, env);
  if (!state.enabled || !state.rooms.length) return { state, sampled: false, newSamples: 0, acceptedOverrides: 0 };
  const plans = new Map<string, PropertyPlan>();
  for (const room of state.rooms) for (const item of [room.sensor, ...room.actuators.flatMap(actuator => [actuator.target, actuator.mode, actuator.power])].filter(Boolean) as PropertyPlan[]) plans.set(propertyKey(item), item);
  const values = new Map<string, unknown>();
  const entries = [...plans.values()];
  for (let index = 0; index < entries.length; index += 40) {
    const response = await requester(session, "/app/miotspec/prop/get", { params: entries.slice(index, index + 40) });
    for (const item of Array.isArray(response.result) ? response.result as Array<Record<string, unknown>> : []) if (item.code === 0 || item.code === undefined) values.set(`${item.did}\0${item.siid}.${item.piid}`, item.value);
  }
  const capturedAt = now.toISOString(), cutoff = now.getTime() - 90 * 86400000;
  state.samples = state.samples.filter(item => Date.parse(item.capturedAt) >= cutoff);
  state.observations = state.observations.filter(item => Date.parse(item.capturedAt) >= cutoff);
  let newSamples = 0, acceptedOverrides = 0;
  for (const room of state.rooms) for (const actuator of room.actuators) {
    const runtimeKey = `${room.roomRef}:${actuator.actuatorRef}`;
    const ambient = values.get(propertyKey(room.sensor)), target = values.get(propertyKey(actuator.target)), rawMode = actuator.mode ? values.get(propertyKey(actuator.mode)) : null;
    const power = actuator.power ? values.get(propertyKey(actuator.power)) : null;
    const runtime = state.runtime[runtimeKey] ?? {};
    const range = actuator.range;
    const validTarget = typeof target === "number" && Number.isFinite(target) && target >= range.min && target <= range.max && Math.abs((target - range.min) / range.step - Math.round((target - range.min) / range.step)) < 1e-6;
    const validMode = !actuator.mode || Boolean(actuator.modes?.some(value => value === rawMode));
    if (typeof ambient !== "number" || !Number.isFinite(ambient) || !validTarget || !validMode) { state.runtime[runtimeKey] = { ...runtime, lastSampleAt: capturedAt }; continue; }
    const mode = actuator.mode ? String(rawMode) : null, bucket = Math.floor(now.getTime() / 900000), sampleRef = `sample_${(await digest(`${room.roomRef}:${actuator.actuatorRef}:${bucket}`)).slice(0, 24)}`;
    const powerOn = powerValue(power);
    if (!state.samples.some(item => item.sampleRef === sampleRef)) {
      state.samples.push({ sampleRef, roomRef: room.roomRef, actuatorRef: actuator.actuatorRef, ambientTemperature: ambient, targetTemperature: target, mode, power: powerOn, capturedAt });
      newSamples++;
    }
    const current = { targetTemperature: target, mode };
    if (!runtime.confirmed) runtime.confirmed = { ...current, observedAt: capturedAt };
    else if (runtime.confirmed.targetTemperature === target && runtime.confirmed.mode === mode) runtime.candidate = undefined;
    else if (!runtime.candidate || runtime.candidate.targetTemperature !== target || runtime.candidate.mode !== mode) runtime.candidate = { ...current, firstSeenAt: capturedAt };
    else {
      const observationRef = `obs_${(await digest(`${room.roomRef}:${actuator.actuatorRef}:${target}:${mode}:${Math.floor(now.getTime() / 3600000)}`)).slice(0, 24)}`;
      if (!state.observations.some(item => item.observationRef === observationRef)) {
        const local = new Intl.DateTimeFormat("en-US", { timeZone: state.timezone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
        const localHour = Number(local.find(item => item.type === "hour")?.value ?? now.getUTCHours());
        const weekdayName = local.find(item => item.type === "weekday")?.value ?? "Mon";
        const dayOfWeek = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekdayName) + 1;
        state.observations.push({ observationRef, roomRef: room.roomRef, actuatorRef: actuator.actuatorRef, ambientTemperature: ambient, targetTemperature: target, mode, powerOn, capturedAt, localHour, dayOfWeek: Math.max(1, dayOfWeek), source: runtime.candidate.source ?? "external_override", excluded: false, previous: { targetTemperature: runtime.confirmed.targetTemperature, mode: runtime.confirmed.mode } });
        acceptedOverrides++;
      }
      runtime.confirmed = { ...current, observedAt: capturedAt }; runtime.candidate = undefined;
    }
    state.runtime[runtimeKey] = { ...runtime, lastSampleAt: capturedAt };
  }
  state.updatedAt = capturedAt;
  await writeClimateState(homeId, state, supplied, env);
  return { state, sampled: true, newSamples, acceptedOverrides };
}

/** Records intent only; sampleClimate must observe the matching device readback before accepting it. */
export async function noteConsoleClimateWrite(homeId: string, did: string, siid: number, piid: number, value: unknown, supplied?: ClimateStore, env: Record<string, string | undefined> = {}) {
  const state = await readClimateState(homeId, supplied, env);
  for (const room of state.rooms) {
    for (const actuator of room.actuators) {
    const runtime = state.runtime[`${room.roomRef}:${actuator.actuatorRef}`];
    if (!runtime?.confirmed) continue;
    const targetWrite = actuator.target.did === did && actuator.target.siid === siid && actuator.target.piid === piid;
    const modeWrite = actuator.mode?.did === did && actuator.mode.siid === siid && actuator.mode.piid === piid;
    if (targetWrite && typeof value === "number") runtime.candidate = { targetTemperature: value, mode: runtime.confirmed.mode, firstSeenAt: new Date().toISOString(), source: "console_override" };
    if (modeWrite && ["string", "number", "boolean"].includes(typeof value)) runtime.candidate = { targetTemperature: runtime.confirmed.targetTemperature, mode: String(value), firstSeenAt: new Date().toISOString(), source: "console_override" };
    }
  }
  await writeClimateState(homeId, state, supplied, env);
}

export function publicClimateState(state: ClimateState, inventory?: ClimateInventory) {
  return {
    enabled: state.enabled, timezone: state.timezone, updatedAt: state.updatedAt,
    rooms: state.rooms.map(({ roomRef, roomName, sensorRef, sensorName, actuators }) => ({ roomRef, roomName, sensorRef, sensorName, actuators: actuators.map(({ actuatorRef, actuatorName, actuatorRoom, capabilityRevision, modeLabels }) => ({ actuatorRef, actuatorName, actuatorRoom, capabilityRevision, modeLabels, lastSampleAt: state.runtime[`${roomRef}:${actuatorRef}`]?.lastSampleAt ?? null })) })),
    inventory, observations: state.observations, samples: state.samples.slice(-1000), draftProfile: state.draftProfile,
    reviewedProfile: state.profileRevisions.find(item => item.revision === state.reviewedRevision) ?? null,
    reviewedRevision: state.reviewedRevision, reviewedAt: state.reviewedAt,
  };
}
