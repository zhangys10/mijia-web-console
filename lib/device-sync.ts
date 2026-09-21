// Shared Xiaomi device read pipeline.
//
// Extracted verbatim from the browser devices route so one read path serves the
// 首页 dashboard API, the device-management views, and the read-only
// `get_device_status` agent tool. Loading live MIoT property values and mapping
// them onto device/topology records is the expensive, failure-prone part; keeping
// a single implementation means the agent can never disagree with the dashboard
// about whether a light is on.
//
// Nothing here is sanitized on its own — callers project to their own boundary
// shape. The agent tool in `device-status.ts` is responsible for stripping DIDs,
// models and raw property addresses.

import { collectDeviceGroupMembers, isDeviceGroupId } from "./device-groups.ts";
import {
  buildDeviceTopology,
  deviceChannelStateKey,
  deviceTopologyIdentity,
  parseDerivedDeviceId,
  topologyForDevice,
  type DeviceChannelRuntimeState,
  type DeviceTopology,
} from "./device-topology.ts";
import { inferHardwareRole } from "./device-views.ts";
import { getMiotCapabilities, type MiotCapabilityGroup, type MiotCapabilityProperty } from "./miot-spec.ts";
import { diagnoseSwitchMode, isSwitchModeProperty } from "./switch-channel-mode.ts";
import { withTimeoutFallback } from "./time-budget.ts";
import { xiaomiErrorInfo, xiaomiRequest, type XiaomiDeviceList, type XiaomiSession } from "./xiaomi-cloud.ts";
import { loadDeviceGroupMemberships, mergeDeviceGroupMemberships } from "./xiaomi-device-groups.ts";
import { sceneDeviceCapabilityKey } from "./xiaomi-scenes.ts";

export type RawDevice = Record<string, unknown>;
export type PropertyValue = boolean | number | string;
export type PropertyPlan = { did: string; siid: number; piid: number };
type PropertyResultState =
  | { status: "ok" }
  | { status: "property-code-error"; code: number }
  | { status: "property-result-invalid" }
  | { status: "property-batch-failed" };

const debugRuntime = process.env.XIAOMI_RUNTIME_DEBUG === "1";

export function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^(?:XIAOMI|MIOT)_[A-Z0-9_]+$/.test(message) ? message : error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

export function runtimeDiagnostic(event: string, details: Record<string, unknown>) {
  if (!debugRuntime) return;
  console.info("[xiaomi-runtime]", JSON.stringify({ event, ...details }));
}

export function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function deviceHome(device: RawDevice) {
  return text(device.homeId ?? device.home_id) || "default";
}

export function deviceModel(device: RawDevice) {
  return text(device.model);
}

export function deviceUrn(device: RawDevice) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

export function isOnline(device: RawDevice) {
  const value = device.isOnline ?? device.is_online ?? device.online;
  return value === undefined ? true : Boolean(value);
}

function propertyKey(did: string, siid: number, piid: number) {
  return `${did}:${siid}:${piid}`;
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

export type RuntimeState = Awaited<ReturnType<typeof loadRuntimeState>>;

export async function loadRuntimeState(session: XiaomiSession, devices: RawDevice[]) {
  const candidates = devices.filter(device => {
    const did = text(device.did);
    if (!did || parseDerivedDeviceId(did)) return false;
    return Boolean(deviceModel(device));
  });
  const specificationKeys = new Map<string, { model: string; urn?: string }>();
  for (const device of candidates) {
    const model = deviceModel(device);
    if (!model) continue;
    const urn = deviceUrn(device);
    specificationKeys.set(`${model}:${urn ?? ""}`, { model, urn });
  }
  const specifications = new Map<string, MiotCapabilityGroup[]>();
  const specificationFailures = new Map<string, string>();
  await Promise.all([...specificationKeys.entries()].map(async ([key, item]) => {
    try {
      const groups = (await getMiotCapabilities(item.model, item.urn)).groups;
      specifications.set(key, groups);
      if (item.model === "xiaomi.controller.oh4w") {
        runtimeDiagnostic("specification-loaded", {
          model: item.model,
          switches: groups.filter(group => group.name === "switch").map(group => ({
            siid: group.siid,
            modeProperties: group.properties.filter(isSwitchModeProperty).map(property => ({
              name: property.name,
              piid: property.piid,
              readable: property.readable,
              choices: property.choices ?? [],
            })),
          })),
        });
      }
    } catch (error) {
      const failure = errorCode(error);
      specifications.set(key, []);
      specificationFailures.set(key, failure);
      runtimeDiagnostic("specification-failed", { model: item.model, error: failure });
    }
  }));

  const plans = new Map<string, PropertyPlan>();
  const channelDescriptors: Array<{
    device: RawDevice;
    group: MiotCapabilityGroup;
    buttonIndex: number;
    on?: MiotCapabilityProperty;
    mode?: MiotCapabilityProperty;
  }> = [];
  const deviceOnDescriptors: Array<{ device: RawDevice; property: MiotCapabilityProperty }> = [];

  for (const device of candidates) {
    const did = text(device.did);
    const model = deviceModel(device);
    const specificationKey = `${model}:${deviceUrn(device) ?? ""}`;
    const groups = specifications.get(specificationKey) ?? [];
    const role = inferHardwareRole(model, text(device.name));
    if (!isOnline(device)) {
      if (role === "controller" || role === "switch") {
        runtimeDiagnostic("device-skipped", { model, reason: "device-offline" });
      }
      continue;
    }
    if (role === "controller" || role === "switch") {
      const switchGroups = groups.filter(group => group.name === "switch");
      if (!switchGroups.length) {
        runtimeDiagnostic("switch-services-missing", {
          model,
          reason: specificationFailures.has(specificationKey) ? "spec-unavailable" : "switch-service-missing",
          error: specificationFailures.get(specificationKey) ?? null,
        });
      }
      switchGroups.forEach((group, index) => {
        const on = group.properties.find(property => property.name === "on" && property.readable);
        const mode = group.properties.find(property => isSwitchModeProperty(property) && property.readable);
        channelDescriptors.push({ device, group, buttonIndex: index + 1, on, mode });
        for (const property of [on, mode]) if (property) plans.set(propertyKey(did, property.siid, property.piid), { did, siid: property.siid, piid: property.piid });
        if (model === "xiaomi.controller.oh4w" && !mode) {
          runtimeDiagnostic("mode-property-missing", {
            model,
            siid: group.siid,
            properties: group.properties.map(property => ({ name: property.name, piid: property.piid, readable: property.readable })),
          });
        }
      });
    }
    if (role === "device" || isDeviceGroupId(did)) {
      const on = groups.flatMap(group => group.properties).find(property => property.name === "on" && property.readable);
      if (on) {
        deviceOnDescriptors.push({ device, property: on });
        plans.set(propertyKey(did, on.siid, on.piid), { did, siid: on.siid, piid: on.piid });
      }
    }
  }

  const values = new Map<string, PropertyValue>();
  const resultStates = new Map<string, PropertyResultState>();
  const incompletePropertyBatches = new Set<number>();
  const retryablePropertyBatches = new Set<number>();
  const propertyBatches = chunks([...plans.values()], 40);
  await Promise.all(propertyBatches.map(async (batch, batchIndex) => {
    try {
      const response = await xiaomiRequest(session, "/app/miotspec/prop/get", { params: batch });
      if (!Array.isArray(response.result)) {
        incompletePropertyBatches.add(batchIndex);
        for (const plan of batch) resultStates.set(propertyKey(plan.did, plan.siid, plan.piid), { status: "property-result-invalid" });
        runtimeDiagnostic("property-batch-invalid", { batch: batchIndex + 1, requested: batch.length });
        return;
      }
      let accepted = 0;
      let rejected = 0;
      for (const item of response.result as RawDevice[]) {
        const key = propertyKey(text(item.did), Number(item.siid), Number(item.piid));
        if (Number(item.code ?? 0) !== 0) {
          resultStates.set(key, { status: "property-code-error", code: Number(item.code) });
          rejected += 1;
          continue;
        }
        if (!["boolean", "number", "string"].includes(typeof item.value)) {
          resultStates.set(key, { status: "property-result-invalid" });
          rejected += 1;
          continue;
        }
        values.set(key, item.value as PropertyValue);
        resultStates.set(key, { status: "ok" });
        accepted += 1;
      }
      runtimeDiagnostic("property-batch-completed", {
        batch: batchIndex + 1,
        requested: batch.length,
        returned: response.result.length,
        accepted,
        rejected,
      });
      if (rejected > 0 || response.result.length < batch.length) incompletePropertyBatches.add(batchIndex);
    } catch (error) {
      incompletePropertyBatches.add(batchIndex);
      if (xiaomiErrorInfo(error).retryable) retryablePropertyBatches.add(batchIndex);
      const failure = errorCode(error);
      for (const plan of batch) resultStates.set(propertyKey(plan.did, plan.siid, plan.piid), { status: "property-batch-failed" });
      runtimeDiagnostic("property-batch-failed", { batch: batchIndex + 1, requested: batch.length, error: failure });
    }
  }));

  const channels = new Map<string, DeviceChannelRuntimeState>();
  for (const descriptor of channelDescriptors) {
    const did = text(descriptor.device.did);
    const homeId = deviceHome(descriptor.device);
    const onValue = descriptor.on ? values.get(propertyKey(did, descriptor.on.siid, descriptor.on.piid)) : undefined;
    const modeKey = descriptor.mode ? propertyKey(did, descriptor.mode.siid, descriptor.mode.piid) : null;
    const modeValue = modeKey ? values.get(modeKey) : undefined;
    const diagnostic = diagnoseSwitchMode(descriptor.mode, modeValue);
    const connectionType = diagnostic.capability === "wireless-only" ? "wireless" : "unknown";
    if (diagnostic.capability === "unknown") {
      const resultState = modeKey ? resultStates.get(modeKey) : undefined;
      runtimeDiagnostic("channel-mode-unknown", {
        model: deviceModel(descriptor.device),
        siid: descriptor.group.siid,
        modeProperty: descriptor.mode ? { name: descriptor.mode.name, piid: descriptor.mode.piid } : null,
        reason: resultState && resultState.status !== "ok" ? resultState.status : diagnostic.reason,
        propertyCode: resultState?.status === "property-code-error" ? resultState.code : null,
        valueType: modeValue === undefined ? "missing" : typeof modeValue,
        value: modeValue ?? null,
        choices: descriptor.mode?.choices ?? [],
      });
    } else if (deviceModel(descriptor.device) === "xiaomi.controller.oh4w") {
      runtimeDiagnostic("channel-mode-resolved", {
        model: deviceModel(descriptor.device),
        siid: descriptor.group.siid,
        piid: descriptor.mode?.piid ?? null,
        modeCapability: diagnostic.capability,
        value: modeValue,
      });
    }
    channels.set(deviceChannelStateKey(homeId, did, descriptor.group.siid), {
      homeId,
      did,
      siid: descriptor.group.siid,
      buttonIndex: descriptor.buttonIndex,
      label: descriptor.group.label,
      connectionType,
      modeCapability: diagnostic.capability,
      reportedOn: typeof onValue === "boolean" ? onValue : null,
      powerControl: descriptor.on?.writable ? { did, siid: descriptor.on.siid, piid: descriptor.on.piid } : undefined,
      modeValue: modeValue ?? null,
      evidence: diagnostic.capability === "unknown" ? "unknown" : "miot-property",
    });
  }

  const devicePower = new Map<string, { value: boolean; powerControl?: { did: string; siid: number; piid: number } }>();
  for (const descriptor of deviceOnDescriptors) {
    const did = text(descriptor.device.did);
    const value = values.get(propertyKey(did, descriptor.property.siid, descriptor.property.piid));
    if (typeof value === "boolean") devicePower.set(deviceTopologyIdentity(deviceHome(descriptor.device), did), {
      value,
      powerControl: descriptor.property.writable ? { did, siid: descriptor.property.siid, piid: descriptor.property.piid } : undefined,
    });
  }
  const sceneCapabilities = new Map(candidates.map(device => [
    sceneDeviceCapabilityKey(deviceHome(device), text(device.did)),
    specifications.get(`${deviceModel(device)}:${deviceUrn(device) ?? ""}`) ?? [],
  ]));
  return { channels, devicePower, sceneCapabilities, specificationFailureCount: specificationFailures.size, failedPropertyBatchCount: incompletePropertyBatches.size, retryablePropertyBatchCount: retryablePropertyBatches.size, propertyBatchCount: propertyBatches.length, timedOut: false };
}

// The exact device projection the browser devices route returns. `on` is the live
// MIoT power value (null when the device exposes no readable power property, e.g.
// a lock), resolved from either the device's own `on` property or its controlling
// switch channel.
export type XiaomiDeviceView = {
  did: string;
  name: string;
  model: string;
  online: boolean;
  on: boolean | null;
  room: string;
  homeId: string;
  home: string;
  roomId: string;
  icon: unknown;
  parentId: string | null;
  logicalType: string;
  urn: string | null;
  groupMemberIds: string[];
  groupIds: string[];
  powerControl: { did: string; siid: number; piid: number } | null;
  topology: DeviceTopology | null;
};

export function projectXiaomiDevices(input: {
  devices: RawDevice[];
  runtime: RuntimeState;
  topology: ReturnType<typeof buildDeviceTopology>;
  groupMembers: Map<string, string[]>;
}): XiaomiDeviceView[] {
  const { devices: source, runtime, topology, groupMembers } = input;
  return source.map(device => {
    const did = text(device.did);
    const homeId = deviceHome(device);
    const parsed = parseDerivedDeviceId(did);
    const mappedTopology = topologyForDevice(topology, device);
    const members = (groupMembers.get(did) ?? []).map(memberId => source.find(item => text(item.did) === memberId && deviceHome(item) === homeId)).filter((item): item is RawDevice => Boolean(item));
    const status = device.isOnline ?? device.is_online ?? device.online;
    const memberStates = members.map(member => member.isOnline ?? member.is_online ?? member.online).filter(member => member !== undefined);
    const channelState = parsed ? runtime.channels.get(deviceChannelStateKey(homeId, parsed.physicalDid, parsed.siid)) : undefined;
    const devicePower = runtime.devicePower.get(deviceTopologyIdentity(homeId, did));
    const on = devicePower?.value ?? channelState?.reportedOn ?? null;
    return {
      did,
      name: text(device.name ?? device.model) || "未命名设备",
      model: deviceModel(device) || text(members.find(member => member.model)?.model),
      online: status === undefined
        ? isDeviceGroupId(did) ? !memberStates.length || memberStates.some(Boolean) : true
        : Boolean(status),
      on,
      room: text(device.roomName) || "未分配",
      homeId,
      home: text(device.homeName) || "我的家",
      roomId: text(device.room_id),
      icon: device.icon ?? null,
      parentId: mappedTopology?.parentId ?? null,
      logicalType: typeof device.type === "string" ? device.type : typeof device.device_type === "string" ? device.device_type : typeof device.deviceType === "string" ? device.deviceType : typeof device.category === "string" ? device.category : "",
      urn: deviceUrn(device) ?? null,
      groupMemberIds: members.map(member => text(member.did)),
      groupIds: [...groupMembers].filter(([groupId, ids]) => ids.includes(did) && source.some(item => text(item.did) === groupId && deviceHome(item) === homeId)).map(([groupId]) => groupId),
      powerControl: devicePower?.powerControl ?? channelState?.powerControl ?? null,
      topology: mappedTopology ?? null,
    };
  });
}

export type XiaomiDeviceSync = {
  discovery: XiaomiDeviceList;
  runtime: RuntimeState;
  topology: ReturnType<typeof buildDeviceTopology>;
  devices: XiaomiDeviceView[];
  groupMembership: { members: Map<string, string[]>; error: unknown };
  groupRequestAttemptCount: number;
};

// Full device sync (discovery → live properties → topology) without any HTTP or
// session-cookie concern, so both the browser route and the agent tool share it.
export async function syncXiaomiDevices(
  session: XiaomiSession,
  discovery: XiaomiDeviceList,
): Promise<XiaomiDeviceSync> {
  const groupDids = discovery.devices.map(device => text(device.did)).filter(isDeviceGroupId);
  const groupMembershipRequest = loadDeviceGroupMemberships(session, groupDids)
    .then(members => ({ members, error: undefined as unknown }))
    .catch(error => ({ members: new Map<string, string[]>(), error }));
  // Runtime-state budget shared by both callers: exceeding it degrades to
  // "unknown" power values rather than failing the whole sync.
  const runtime = await withTimeoutFallback(loadRuntimeState(session, discovery.devices), 12_000, () => {
    runtimeDiagnostic("runtime-state-budget-exceeded", { budgetMs: 12_000, devices: discovery.devices.length });
    return {
      channels: new Map(),
      devicePower: new Map(),
      sceneCapabilities: new Map(),
      specificationFailureCount: 0,
      failedPropertyBatchCount: 0,
      retryablePropertyBatchCount: 0,
      propertyBatchCount: 0,
      timedOut: true,
    };
  });
  const topology = buildDeviceTopology(discovery.devices, runtime.channels, discovery.controlObjectResults);
  const groupMembership = await groupMembershipRequest;
  const groupMembers = mergeDeviceGroupMemberships(collectDeviceGroupMembers(discovery.devices), groupMembership.members);
  return {
    discovery,
    runtime,
    topology,
    devices: projectXiaomiDevices({ devices: discovery.devices, runtime, topology, groupMembers }),
    groupMembership,
    groupRequestAttemptCount: groupDids.length ? 1 : 0,
  };
}
