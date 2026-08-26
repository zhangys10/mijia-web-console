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
import { resolveSwitchMode } from "../../../../lib/switch-channel-mode";
import { listDevices, unseal, xiaomiRequest, type XiaomiSession } from "../../../../lib/xiaomi-cloud";

type RawDevice = Record<string, unknown>;
type PropertyValue = boolean | number | string;
type PropertyPlan = { did: string; siid: number; piid: number };

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
  await Promise.all([...specificationKeys.entries()].map(async ([key, item]) => {
    try { specifications.set(key, (await getMiotCapabilities(item.model, item.urn)).groups); }
    catch { specifications.set(key, []); }
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
    if (!isOnline(device)) continue;
    const did = text(device.did);
    const model = deviceModel(device);
    const groups = specifications.get(`${model}:${deviceUrn(device) ?? ""}`) ?? [];
    const role = inferHardwareRole(model, text(device.name));
    if (role === "controller" || role === "switch") {
      const switchGroups = groups.filter(group => group.name === "switch");
      switchGroups.forEach((group, index) => {
        const on = group.properties.find(property => property.name === "on" && property.readable);
        const mode = group.properties.find(property => property.name === "mode" && property.readable);
        channelDescriptors.push({ device, group, buttonIndex: index + 1, on, mode });
        for (const property of [on, mode]) if (property) plans.set(propertyKey(did, property.siid, property.piid), { did, siid: property.siid, piid: property.piid });
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
  await Promise.all(chunks([...plans.values()], 40).map(async batch => {
    try {
      const response = await xiaomiRequest(session, "/app/miotspec/prop/get", { params: batch });
      if (!Array.isArray(response.result)) return;
      for (const item of response.result as RawDevice[]) {
        if (Number(item.code ?? 0) !== 0 || !["boolean", "number", "string"].includes(typeof item.value)) continue;
        values.set(propertyKey(text(item.did), Number(item.siid), Number(item.piid)), item.value as PropertyValue);
      }
    } catch { /* A failed state batch must not make device synchronization fail. */ }
  }));

  const channels = new Map<string, DeviceChannelRuntimeState>();
  for (const descriptor of channelDescriptors) {
    const did = text(descriptor.device.did);
    const homeId = deviceHome(descriptor.device);
    const onValue = descriptor.on ? values.get(propertyKey(did, descriptor.on.siid, descriptor.on.piid)) : undefined;
    const modeValue = descriptor.mode ? values.get(propertyKey(did, descriptor.mode.siid, descriptor.mode.piid)) : undefined;
    const connectionType = descriptor.mode && modeValue !== undefined ? resolveSwitchMode(descriptor.mode, modeValue) : "unknown";
    channels.set(deviceChannelStateKey(homeId, did, descriptor.group.siid), {
      homeId,
      did,
      siid: descriptor.group.siid,
      buttonIndex: descriptor.buttonIndex,
      label: descriptor.group.label,
      connectionType,
      reportedOn: typeof onValue === "boolean" ? onValue : null,
      modeValue: modeValue ?? null,
      evidence: connectionType === "unknown" ? "unknown" : "miot-property",
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
    const topology = buildDeviceTopology(result.devices, runtime.channels);
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
