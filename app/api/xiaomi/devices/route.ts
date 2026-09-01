import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { collectDeviceGroupMembers, isDeviceGroupId } from "../../../../lib/device-groups";
import {
  buildDeviceTopology,
  deviceChannelStateKey,
  deviceTopologyIdentity,
  parseDerivedDeviceId,
  topologyForDevice,
  type DeviceChannelRuntimeState,
} from "../../../../lib/device-topology";
import { inferHardwareRole } from "../../../../lib/device-views";
import { getMiotCapabilities, type MiotCapabilityGroup, type MiotCapabilityProperty } from "../../../../lib/miot-spec";
import { diagnoseSwitchMode, isSwitchModeProperty } from "../../../../lib/switch-channel-mode";
import { withTimeoutFallback } from "../../../../lib/time-budget";
import { listDevices, unseal, xiaomiErrorInfo, xiaomiRequest, type XiaomiSession } from "../../../../lib/xiaomi-cloud";
import { listRawManualScenes, loadSceneActionCapabilities, parseManualScenes, sceneDeviceCapabilityKey } from "../../../../lib/xiaomi-scenes";

type RawDevice = Record<string, unknown>;
type PropertyValue = boolean | number | string;
type PropertyPlan = { did: string; siid: number; piid: number };
type PropertyResultState =
  | { status: "ok" }
  | { status: "property-code-error"; code: number }
  | { status: "property-result-invalid" }
  | { status: "property-batch-failed" };

const debugRuntime = process.env.XIAOMI_RUNTIME_DEBUG === "1";

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
  return { channels, devicePower, sceneCapabilities, specificationFailureCount: specificationFailures.size, failedPropertyBatchCount: incompletePropertyBatches.size, retryablePropertyBatchCount: retryablePropertyBatches.size, propertyBatchCount: propertyBatches.length };
}

function validIdentifier(value: string | null) {
  return Boolean(value && value.length <= 128 && !/[\u0000-\u001f]/.test(value));
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const requestedHomeId = request.nextUrl.searchParams.get("homeId");
    const includeScenes = request.nextUrl.searchParams.get("includeScenes") === "1";
    if (requestedHomeId && !validIdentifier(requestedHomeId)) return NextResponse.json({ error: "INVALID_HOME_ID", retryable: false }, { status: 400 });
    const value = (await cookies()).get("xiaomi_session")?.value;
    if (!value) return NextResponse.json({ error: "XIAOMI_NOT_CONNECTED" }, { status: 401 });
    const session = await unseal<XiaomiSession>(value);
    const discoveryStartedAt = Date.now();
    const result = await listDevices(session);
    const discoveryDurationMs = Date.now() - discoveryStartedAt;
    const runtimeStartedAt = Date.now();
    const runtime = await withTimeoutFallback(loadRuntimeState(session, result.devices), 12_000, () => {
      runtimeDiagnostic("runtime-state-budget-exceeded", { budgetMs: 12_000, devices: result.devices.length });
      return {
        channels: new Map(),
        devicePower: new Map(),
        sceneCapabilities: new Map(),
        specificationFailureCount: 0,
        failedPropertyBatchCount: 0,
        retryablePropertyBatchCount: 0,
        propertyBatchCount: 0,
      };
    });
    const runtimeDurationMs = Date.now() - runtimeStartedAt;
    const topology = buildDeviceTopology(result.devices, runtime.channels, result.controlObjectResults);
    for (const mapped of new Set([...topology.values()])) {
      for (const channel of mapped.channels) {
        runtimeDiagnostic("channel-control-classified", {
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
        groupMemberIds: groupMembers.get(did) ?? [],
        groupIds: [...groupMembers].filter(([, ids]) => ids.includes(did)).map(([groupId]) => groupId),
        powerControl: devicePower?.powerControl ?? channelState?.powerControl ?? null,
        topology: mappedTopology ?? null,
      };
    });
    const selectedHomeId = result.homes.some(home => home.id === requestedHomeId) ? requestedHomeId! : result.homes[0]?.id ?? null;
    const warnings: Array<{ code: string; scope: "devices" | "properties" | "specifications" | "scenes"; retryable: boolean; retryAfterSeconds?: number }> = [...result.warnings];
    if (runtime.failedPropertyBatchCount > 0) warnings.push({ code: "XIAOMI_PROPERTIES_PARTIAL", scope: "properties", retryable: runtime.retryablePropertyBatchCount > 0 });
    if (runtime.specificationFailureCount > 0) warnings.push({ code: "MIOT_SPECIFICATIONS_PARTIAL", scope: "specifications", retryable: false });
    let scenes;
    let sceneDurationMs = 0;
    let sceneAttemptCount = 0;
    let scenesCompleteness: "complete" | "partial" | "not-requested" = "not-requested";
    if (includeScenes && selectedHomeId) {
      const sceneStartedAt = Date.now();
      sceneAttemptCount = 1;
      try {
        const rawScenes = await listRawManualScenes(session, selectedHomeId);
        const sceneCapabilities = await loadSceneActionCapabilities(rawScenes, selectedHomeId, runtime.sceneCapabilities);
        scenes = parseManualScenes({ result: rawScenes }, selectedHomeId, result.devices, sceneCapabilities);
        scenesCompleteness = "complete";
      } catch (error) {
        const failure = xiaomiErrorInfo(error);
        warnings.push({ code: errorCode(error), scope: "scenes", retryable: failure.retryable, ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) });
        scenesCompleteness = "partial";
      } finally {
        sceneDurationMs = Date.now() - sceneStartedAt;
      }
    }
    const capturedAt = new Date().toISOString();
    const diagnostic = {
      vercelRegion: process.env.VERCEL_REGION ?? null,
      sessionRegion: session.region,
      durationMs: Date.now() - startedAt,
      discoveryDurationMs,
      runtimeDurationMs,
      sceneDurationMs,
      deviceRequestAttemptCount: result.requestAttemptCount,
      propertyRequestAttemptCount: runtime.propertyBatchCount,
      sceneRequestAttemptCount: sceneAttemptCount,
      totalXiaomiRequestAttemptCount: result.requestAttemptCount + runtime.propertyBatchCount + sceneAttemptCount,
      successfulHomeCount: result.successfulHomeCount,
      failedHomeCount: result.failedHomeCount,
      propertyBatchFailureCount: runtime.failedPropertyBatchCount,
      warningCount: warnings.length,
    };
    console.info("[xiaomi-sync]", JSON.stringify(diagnostic));
    return NextResponse.json({
      homes: result.homes,
      devices,
      selectedHomeId,
      ...(scenes ? { scenes } : {}),
      capturedAt,
      stateCapturedAt: capturedAt,
      completeness: {
        devices: result.completeness,
        properties: runtime.failedPropertyBatchCount > 0 ? "partial" : "complete",
        specifications: runtime.specificationFailureCount > 0 ? "partial" : "complete",
        scenes: scenesCompleteness,
      },
      warnings,
    });
  } catch (error) {
    const failure = xiaomiErrorInfo(error);
    console.error("[xiaomi-devices]", JSON.stringify({
      vercelRegion: process.env.VERCEL_REGION ?? null,
      durationMs: Date.now() - startedAt,
      error: failure.message,
    }));
    if (failure.status === 401) (await cookies()).delete("xiaomi_session");
    const headers = failure.retryAfterSeconds ? { "Retry-After": String(failure.retryAfterSeconds) } : undefined;
    return NextResponse.json({ error: failure.message, retryable: failure.retryable, ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) }, { status: failure.status, headers });
  }
}
