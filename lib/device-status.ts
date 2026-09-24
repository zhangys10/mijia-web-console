// Read-only home device-status collector.
//
// Answers "which lights are on, by room" the same way the console 首页 does: it
// runs the shared device pipeline (lib/device-sync.ts) and reduces the result with
// the very same buildDeviceManagementModel the dashboard uses, so the agent and the
// home page can never disagree about whether a light is on.
//
// The output is strictly sanitized: no DID, model string, siid/piid, scene id or raw
// Xiaomi record survives. Shared by the agent's `get_device_status` remote tool.

import { classifyDeviceKind, inferHardwareRole } from "./device-views.ts";
import { buildDeviceManagementModel, type ManagedDevice } from "./device-management.ts";
import { syncXiaomiDevices } from "./device-sync.ts";
import { listDevices, type XiaomiSession } from "./xiaomi-cloud.ts";

export type DeviceRoomItem = {
  name: string;
  kind: string;
  state: "on" | "off" | "unknown";
  online: boolean;
};

export type DeviceRoom = {
  room: string;
  items: DeviceRoomItem[];
};

export type DeviceStatus = {
  capturedAt: string;
  completeness: "complete" | "partial" | "empty";
  poweredOn: number;
  rooms: DeviceRoom[];
  warnings: string[];
};

const MAX_ROOMS = 20;
const MAX_ITEMS_PER_ROOM = 40;
const hiddenRoom = /勿关|勿删|语音|隐藏/;

// The dashboard's own room ordering: hidden/utility rooms last, then zh-CN collation.
function roomRank(room: string) {
  return [Number(hiddenRoom.test(room)), room] as const;
}

function compareRooms(left: string, right: string) {
  const [leftHidden, leftName] = roomRank(left);
  const [rightHidden, rightName] = roomRank(right);
  return leftHidden - rightHidden || leftName.localeCompare(rightName, "zh-CN");
}

// A device with no readable power property (on === null, e.g. a lock or sensor)
// is reported as `unknown` — never guessed into "off".
export function deviceState(device: ManagedDevice): DeviceRoomItem["state"] {
  if (device.online !== true && device.on === null) return "unknown";
  if (device.on === true) return "on";
  if (device.on === false) return "off";
  return "unknown";
}

// Pure: reduce dashboard devices to a sanitized per-room status snapshot.
export function buildDeviceStatusSnapshot(input: {
  capturedAt: string;
  devices: ManagedDevice[];
  failedBatchCount: number;
  specificationFailureCount: number;
  timedOut: boolean;
}): DeviceStatus {
  const model = buildDeviceManagementModel(input.devices);
  // Only the 首页-relevant, controllable/readable hardware: lights, light groups and
  // other powered devices. Switch panels and controllers are control surfaces whose
  // channel state is already reflected on the light they drive.
  const reported = model.records.filter(record =>
    ["smart-light", "group", "other"].includes(record.category),
  );

  const itemsByDevice = reported.map(record => ({
    room: record.device.room || "未分配",
    item: {
      name: record.device.name,
      kind: record.device.kind,
      state: deviceState(record.device),
      online: record.device.online === true,
    } satisfies DeviceRoomItem,
  }));

  const rooms = [...new Set(itemsByDevice.map(entry => entry.room))]
    .sort(compareRooms)
    .slice(0, MAX_ROOMS)
    .map(room => ({
      room,
      items: itemsByDevice
        .filter(entry => entry.room === room)
        .map(entry => entry.item)
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .slice(0, MAX_ITEMS_PER_ROOM),
    }))
    .filter(group => group.items.length > 0);

  const warnings: string[] = [];
  if (input.specificationFailureCount > 0) warnings.push("部分设备规格解析失败，其状态可能不准确。");
  if (input.failedBatchCount > 0 || input.timedOut) warnings.push("部分设备状态暂时不可用。");
  if (reported.some(record => record.device.online !== true)) warnings.push("部分设备当前离线。");

  const itemCount = rooms.reduce((count, group) => count + group.items.length, 0);
  const poweredOn = rooms.reduce(
    (count, group) => count + group.items.filter(item => item.state === "on").length,
    0,
  );
  return {
    capturedAt: input.capturedAt,
    completeness: itemCount === 0
      ? "empty"
      : reported.some(record => deviceState(record.device) === "unknown") || warnings.length > 0
        ? "partial"
        : "complete",
    poweredOn,
    rooms,
    warnings,
  };
}

export type DeviceStatusDependencies = {
  listDevices?: typeof listDevices;
  sync?: typeof syncXiaomiDevices;
};

export async function collectDeviceStatus(
  session: XiaomiSession,
  homeId: string,
  dependencies: DeviceStatusDependencies = {},
  exposedDids?: readonly string[],
): Promise<DeviceStatus> {
  const discovery = await (dependencies.listDevices ?? listDevices)(session);
  const targetHomeId = homeId || String(discovery.homes[0]?.id ?? "");
  if (!targetHomeId || !discovery.homes.some(home => home.id === targetHomeId)) {
    throw new Error("AI_HOME_FORBIDDEN");
  }
  const sync = await (dependencies.sync ?? syncXiaomiDevices)(session, discovery);
  // The dashboard scopes every view by homeId first; this collector does the same.
  const homeDevices: ManagedDevice[] = sync.devices
    .filter(device => device.homeId === targetHomeId)
    .filter(device => !exposedDids || exposedDids.includes(device.did))
    .map((device, index) => ({
      id: index + 100,
      did: device.did,
      name: device.name,
      home: device.home,
      homeId: device.homeId,
      room: device.room,
      kind: classifyDeviceKind(device.model, device.name, device.logicalType ?? ""),
      icon: "",
      on: device.on,
      status: "",
      detail: "",
      color: "",
      online: device.online,
      parentId: device.parentId,
      urn: device.urn,
      logicalType: device.logicalType,
      hardwareRole: inferHardwareRole(device.model, device.name),
      topology: device.topology,
      groupMemberIds: device.groupMemberIds,
      groupIds: device.groupIds,
      powerControl: device.powerControl ?? undefined,
    }));

  return buildDeviceStatusSnapshot({
    capturedAt: new Date().toISOString(),
    devices: homeDevices,
    failedBatchCount: sync.runtime.failedPropertyBatchCount,
    specificationFailureCount: sync.runtime.specificationFailureCount,
    timedOut: sync.runtime.timedOut,
  });
}
