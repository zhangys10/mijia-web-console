import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { collectDeviceGroupMembers, isDeviceGroupId } from "../../../../lib/device-groups";
import {
  buildDeviceTopology,
  deviceChannelStateKey,
  deviceTopologyIdentity,
  parseDerivedDeviceId,
  topologyForDevice,
  type DeviceChannelRuntimeState,
} from "../../../../lib/device-topology";
import { classifyDeviceKind, inferHardwareRole } from "../../../../lib/device-views";
import { getMiotCapabilities, type MiotCapabilityGroup, type MiotCapabilityProperty } from "../../../../lib/miot-spec";
import { diagnoseSwitchMode, isSwitchModeProperty } from "../../../../lib/switch-channel-mode";
import { listDevices, unseal, xiaomiRequest, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

type RawDevice = Record<string, unknown>;
type PropertyValue = boolean | number | string;
type PropertyPlan = { did: string; siid: number; piid: number };
type PropertyResultState =
  | { status: "ok" }
  | { status: "property-code-error"; code: number }
  | { status: "property-result-invalid" }
  | { status: "property-batch-failed" };

const debugRuntime = process.env.XIAOMI_RUNTIME_DEBUG === "1";

function redactedDid(did: string) {
  return did.length <= 4 ? "••••" : `••••${did.slice(-4)}`;
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  return /^(?:XIAOMI|MIOT)_[A-Z0-9_]+$/.test(message) ? message : error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function runtimeDiagnostic(event: string, details: Record<string, unknown>) {
  if (!debugRuntime) return;
  console.info("[xiaomi-runtime]", JSON.stringify({ event, ...details }));
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function deviceHome(device: RawDevice) {
  return text(device.homeId ?? device.home_id) || "default";
}

function deviceModel(device: RawDevice) {
  return text(device.model);
}

function deviceUrn(device: RawDevice) {
  const value = device.urn ?? device.spec_type ?? device.miot_type;
  return typeof value === "string" && value.startsWith("urn:") ? value : undefined;
}

function isOnline(device: RawDevice) {
  const value = device.isOnline ?? device.is_online ?? device.online;
  return value === undefined ? true : Boolean(value);
}

function propertyKey(did: string, siid: number, piid: number) {
  return `${did}:${siid}:${piid}`;
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

async function loadRuntimeState(session: XiaomiSession, devices: RawDevice[]) {
  const candidates = devices.filter(device => {
    const did = text(device.did);
    if (!did || parseDerivedDeviceId(did)) return false;
    const model = deviceModel(device);
    const name = text(device.name);
    const kind = classifyDeviceKind(model, name, text(device.type ?? device.device_type));
    const role = inferHardwareRole(model, name);
    return isDeviceGroupId(did) || role === "controller" || role === "switch" || kind === "light" || kind === "lamp";
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
        runtimeDiagnostic("device-skipped", { did: redactedDid(did), model, reason: "device-offline" });
      }
      continue;
    }
    if (role === "controller" || role === "switch") {
      const switchGroups = groups.filter(group => group.name === "switch");
      if (!switchGroups.length) {
        runtimeDiagnostic("switch-services-missing", {
          did: redactedDid(did),
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
            did: redactedDid(did),
            model,
            siid: group.siid,
            properties: group.properties.map(property => ({ name: property.name, piid: property.piid, readable: property.readable })),
          });
        }
      });
    }
    if (isDeviceGroupId(did) || ["light", "lamp"].includes(classifyDeviceKind(model, text(device.name)))) {
      const on = groups.flatMap(group => group.properties).find(property => property.name === "on" && property.readable);
      if (on) {
        deviceOnDescriptors.push({ device, property: on });
        plans.set(propertyKey(did, on.siid, on.piid), { did, siid: on.siid, piid: on.piid });
      }
    }
  }

  const values = new Map<string, PropertyValue>();
  const resultStates = new Map<string, PropertyResultState>();
  await Promise.all(chunks([...plans.values()], 40).map(async (batch, batchIndex) => {
    try {
      const response = await xiaomiRequest(session, "/app/miotspec/prop/get", { params: batch });
      if (!Array.isArray(response.result)) {
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
    } catch (error) {
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
        did: redactedDid(did),
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
        did: redactedDid(did),
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
      modeValue: modeValue ?? null,
      evidence: diagnostic.capability === "unknown" ? "unknown" : "miot-property",
    });
  }

  const deviceOn = new Map<string, boolean>();
  for (const descriptor of deviceOnDescriptors) {
    const did = text(descriptor.device.did);
    const value = values.get(propertyKey(did, descriptor.property.siid, descriptor.property.piid));
    if (typeof value === "boolean") deviceOn.set(deviceTopologyIdentity(deviceHome(descriptor.device), did), value);
  }
  return { channels, deviceOn };
}

export async function GET() {
  try {
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const session = await unseal<XiaomiSession>(value);
    const result = await listDevices(session);
    const runtime = await loadRuntimeState(session, result.devices);
    const topology = buildDeviceTopology(result.devices, runtime.channels, result.controlObjectResults);
    for (const mapped of new Set([...topology.values()])) {
      for (const channel of mapped.channels) {
        runtimeDiagnostic("channel-control-classified", {
          did: mapped.parentId ? redactedDid(mapped.parentId) : null,
          siid: channel.channelSiid,
          modeCapability: channel.modeCapability,
          controlObjectStatus: channel.controlObjectStatus,
          controlObjectComplete: channel.controlObjectComplete,
          objectCount: channel.controlObjects.length,
          classification: channel.classification,
        });
      }
    }
    const groupMembers = collectDeviceGroupMembers(result.devices);
    const devices = result.devices.map(device => {
      const did = text(device.did);
      const homeId = deviceHome(device);
      const parsed = parseDerivedDeviceId(did);
      const mappedTopology = topologyForDevice(topology, device);
      const members = (groupMembers.get(did) ?? []).map(memberId => result.devices.find(item => text(item.did) === memberId && deviceHome(item) === homeId)).filter((item): item is RawDevice => Boolean(item));
      const status = device.isOnline ?? device.is_online ?? device.online;
      const memberStates = members.map(member => member.isOnline ?? member.is_online ?? member.online).filter(member => member !== undefined);
      const channelState = parsed ? runtime.channels.get(deviceChannelStateKey(homeId, parsed.physicalDid, parsed.siid)) : undefined;
      const on = runtime.deviceOn.get(deviceTopologyIdentity(homeId, did)) ?? channelState?.reportedOn ?? null;
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
        groupMemberIds: groupMembers.get(did) ?? [],
        groupIds: [...groupMembers].filter(([, ids]) => ids.includes(did)).map(([groupId]) => groupId),
        topology: mappedTopology ?? null,
      };
    });
    return NextResponse.json({ homes: result.homes, devices, stateCapturedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    console.error("[xiaomi-devices]", JSON.stringify({ error: message }));
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
